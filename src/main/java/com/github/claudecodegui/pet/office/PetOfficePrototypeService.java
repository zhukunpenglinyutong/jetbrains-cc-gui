package com.github.claudecodegui.pet.office;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.util.JBCefBrowserFactory;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;
import com.intellij.ui.jcef.JBCefJSQuery;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefRequestHandlerAdapter;
import org.cef.network.CefRequest;

import javax.swing.JFrame;
import javax.swing.WindowConstants;
import java.awt.BorderLayout;
import java.awt.Dimension;
import java.awt.Frame;
import java.awt.GraphicsEnvironment;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;

/** Opt-in multi-IDE Office with source-owned art and authenticated existing-tab navigation. */
@Service(Service.Level.APP)
public final class PetOfficePrototypeService implements Disposable {
    private static final Logger LOG = Logger.getInstance(PetOfficePrototypeService.class);
    private static final int MAX_HTML_BYTES = 5 * 1024 * 1024;
    private final ExecutorService worker = AppExecutorUtil.createBoundedApplicationPoolExecutor("Pet Office prototype", 1);
    private final ExecutorService assetWorker = new java.util.concurrent.ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS,
            new java.util.concurrent.SynchronousQueue<>(), task -> PetOfficeIpcServer.daemon(task, "Pet Office image"));
    private final AtomicBoolean disposed = new AtomicBoolean();
    private final AtomicBoolean opening = new AtomicBoolean();
    private final AtomicLong generation = new AtomicLong();
    private final AtomicInteger pendingUiMessages = new AtomicInteger();
    private final AtomicBoolean rendererEligible = new AtomicBoolean(true);
    // Window/browser fields are accessed only on the EDT.
    private volatile PetOfficeRuntimeLease lease;
    private JFrame window;
    private JBCefBrowser browser;
    private JBCefJSQuery query;
    private CefRequestHandlerAdapter requestHandler;
    private String pageGeneration;
    private String trustedUrl;
    private boolean frontendReady;
    private ScheduledFuture<?> readyDeadline;
    private long lastMetricsLog;
    private PetOfficeSessionPublisher sessionPublisher;
    private volatile PetOfficeRuntimeService runtimeService;
    private volatile LivePage livePage;
    private long presentationRevision;
    private java.nio.file.Path runtimeDirectory;
    private ScheduledFuture<?> boundsSave;

    public static PetOfficePrototypeService getInstance() {
        return ApplicationManager.getApplication().getService(PetOfficePrototypeService.class);
    }

    public void open() {
        rendererEligible.set(true);
        requestOpen(true, null);
    }

    void recover(PetOfficeRecoveryStore.Intent expected) {
        if (rendererEligible.get()) {
            requestOpen(false, expected);
        }
    }

    private void requestOpen(boolean explicit, PetOfficeRecoveryStore.Intent expected) {
        onEdt(() -> {
            if (disposed.get()) {
                return;
            }
            if (window != null && window.isDisplayable()) {
                if (explicit) {
                    showOwned(lease);
                }
                return;
            }
            if (!opening.compareAndSet(false, true)) {
                return;
            }
            long attempt = generation.incrementAndGet();
            if (!submit(() -> initialize(attempt, explicit, expected))) {
                opening.set(false);
            }
        });
    }

    private void initialize(long attempt, boolean explicit, PetOfficeRecoveryStore.Intent expected) {
        PetOfficeRuntimeLease acquired = null;
        try {
            if (disposed.get() || attempt != generation.get()) {
                return;
            }
            if (!SystemInfo.isWindows || GraphicsEnvironment.isHeadless()) {
                throw new IOException("OFFICE_NO_RENDERER_AVAILABLE");
            }
            java.nio.file.Path directory = PetOfficeWindowsRuntime.resolveDirectory();
            runtimeService = PetOfficeRuntimeService.getInstance();
            if (!JBCefBrowserFactory.isJcefSupported()) {
                if (explicit) {
                    showExistingOffice(attempt, directory);
                } else {
                    opening.set(false);
                }
                return;
            }
            byte[] htmlBytes;
            try (InputStream resource = getClass().getResourceAsStream("/html/pet-office.html")) {
                if (resource == null) {
                    throw new IOException("OFFICE_ENTRY_MISSING");
                }
                htmlBytes = resource.readNBytes(MAX_HTML_BYTES + 1);
            }
            if (htmlBytes.length > MAX_HTML_BYTES) {
                throw new IOException("OFFICE_ENTRY_TOO_LARGE");
            }
            acquired = PetOfficeRuntimeLease.tryAcquire(directory).orElse(null);
            if (acquired == null) {
                if (explicit) {
                    showExistingOffice(attempt, directory);
                } else {
                    opening.set(false);
                }
                return;
            }
            if (disposed.get() || attempt != generation.get()) {
                acquired.close();
                return;
            }
            String html = new String(htmlBytes, StandardCharsets.UTF_8);
            PetOfficeRuntimeLease pendingLease = acquired;
            var currentIntent = explicit ? new PetOfficeRecoveryStore(directory).read() : expected;
            var restored = runtimeService.startOwner(directory, acquired, () -> showOwned(pendingLease), currentIntent, explicit);
            runtimeService.awaitDisplayReady(acquired);
            var preferences = new PetOfficePreferencesStore(directory).read();
            onEdt(() -> createWindow(attempt, html, pendingLease, explicit, restored.visible(), directory, preferences));
            acquired = null;
        } catch (Exception | LinkageError failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            if (acquired != null) {
                if (runtimeService != null) {
                    runtimeService.stopOwner(acquired);
                }
                closeLease(acquired);
            }
            String code = failure instanceof IOException && failure.getMessage() != null && failure.getMessage().startsWith("OFFICE_")
                    ? failure.getMessage() : "OFFICE_START_FAILED";
            LOG.warn("[PetOfficePrototype] " + code);
            onEdt(() -> {
                if (attempt == generation.get()) {
                    opening.set(false);
                }
                if (explicit && !disposed.get() && attempt == generation.get()) {
                    NotificationGroupManager.getInstance().getNotificationGroup("CC GUI Notifications")
                            .createNotification(ClaudeCodeGuiBundle.message("petOffice.prototype.title"),
                                    ClaudeCodeGuiBundle.message("petOffice.prototype.unavailable", code), NotificationType.WARNING).notify(null);
                }
            });
        }
    }

    private void showExistingOffice(long attempt, java.nio.file.Path directory) throws IOException {
        if (!runtimeService.showExisting(directory, code -> onEdt(() -> {
            if (!disposed.get() && attempt == generation.get()) {
                opening.set(false);
                if (!code.isEmpty()) {
                    notifyFailure(code);
                }
            }
        }))) {
            throw new IOException("OFFICE_COORDINATOR_UNAVAILABLE");
        }
    }

    private void createWindow(long attempt, String html, PetOfficeRuntimeLease pendingLease, boolean explicit, boolean visible,
                              java.nio.file.Path directory, PetOfficePreferencesStore.Loaded preferences) {
        if (disposed.get() || attempt != generation.get() || !pendingLease.isValid() || !runtimeService.owns(pendingLease)) {
            closeLeaseAsync(pendingLease);
            if (attempt == generation.get()) {
                opening.set(false);
            }
            return;
        }
        lease = pendingLease;
        runtimeDirectory = directory;
        try {
            pageGeneration = UUID.randomUUID().toString();
            trustedUrl = "http://127.0.0.1/ccgui-pet-office/" + pageGeneration + ".html";
            frontendReady = false;
            browser = JBCefBrowserFactory.create();
            query = JBCefJSQuery.create((JBCefBrowserBase) browser);
            String currentPage = pageGeneration;
            String currentUrl = trustedUrl;
            PetOfficeNavigationPolicy navigation = new PetOfficeNavigationPolicy(currentUrl);
            query.addHandler(message -> handleMessage(attempt, currentPage, message));
            requestHandler = new CefRequestHandlerAdapter() {
                @Override
                public boolean onBeforeBrowse(CefBrowser cefBrowser, CefFrame frame, CefRequest request, boolean userGesture, boolean isRedirect) {
                    return disposed.get() || attempt != generation.get() || !navigation.allows(request.getURL(), frame != null && frame.isMain());
                }
            };
            browser.getJBCefClient().addRequestHandler(requestHandler, browser.getCefBrowser());
            window = new JFrame(windowTitle(preferences.state().preferences()));
            JFrame currentWindow = window;
            window.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
            window.setLayout(new BorderLayout());
            window.add(browser.getComponent(), BorderLayout.CENTER);
            var bounds = PetOfficeWindowGeometry.restore(preferences.state().bounds(), usableScreens());
            window.setMinimumSize(new Dimension(Math.min(480, bounds.width), Math.min(480, bounds.height)));
            window.setBounds(bounds);
            window.setAlwaysOnTop(preferences.state().preferences().topmost());
            window.setAutoRequestFocus(explicit);
            window.addComponentListener(new java.awt.event.ComponentAdapter() {
                @Override
                public void componentMoved(java.awt.event.ComponentEvent event) { scheduleBoundsSave(currentWindow, attempt); }
                @Override
                public void componentResized(java.awt.event.ComponentEvent event) { scheduleBoundsSave(currentWindow, attempt); }
            });
            window.addWindowListener(new WindowAdapter() {
                @Override
                public void windowClosing(WindowEvent event) {
                    if (currentWindow == window) {
                        changePresentation(true, false, () -> {
                            publishVisibility(false);
                            currentWindow.setVisible(false);
                        });
                    }
                }

                @Override
                public void windowIconified(WindowEvent event) {
                    if (currentWindow == window) {
                        publishVisibility(false);
                    }
                }

                @Override
                public void windowDeiconified(WindowEvent event) {
                    if (currentWindow == window) {
                        publishVisibility(true);
                    }
                }
            });
            String language = Locale.getDefault().getLanguage().startsWith("zh") ? "zh" : "en";
            String bootstrap = "<script>window.__PET_OFFICE_BOOTSTRAP__={pageGeneration:'" + currentPage + "',language:'" + language
                    + "',mode:'live',protocolVersion:1,alwaysOnTop:" + window.isAlwaysOnTop()
                    + ",sharedPreferences:" + new com.google.gson.Gson().toJson(preferences.state())
                    + ",preferencesRecovered:" + preferences.recovered() + "};"
                    + "window.petOfficeNativeBridge=function(message){" + query.inject("message") + "};</script>";
            if (!visible) {
                // Initialize JCEF's native peer without showing or focusing a recovered hidden Office.
                window.addNotify();
            }
            browser.loadHTML(html.replace("<!-- OFFICE_BOOTSTRAP -->", bootstrap), trustedUrl);
            window.setVisible(visible);
            readyDeadline = AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> onEdt(() -> {
                if (!disposed.get() && attempt == generation.get() && !frontendReady && currentWindow == window) {
                    LOG.warn("[PetOfficePrototype] OFFICE_FRONTEND_READY_TIMEOUT");
                    rendererEligible.set(false);
                    closeWindow(false);
                    notifyFailure("OFFICE_FRONTEND_READY_TIMEOUT");
                }
            }), 20, TimeUnit.SECONDS);
            LOG.info("[PetOffice] Local Office window created");
        } catch (Exception | LinkageError failure) {
            LOG.warn("[PetOfficePrototype] OFFICE_RENDERER_FAILED");
            rendererEligible.set(false);
            closeWindow(false);
            notifyFailure("OFFICE_RENDERER_FAILED");
        } finally {
            opening.set(false);
        }
    }

    private JBCefJSQuery.Response handleMessage(long attempt, String currentPage, String message) {
        long receivedAt = System.nanoTime();
        if (disposed.get() || attempt != generation.get()) {
            return new JBCefJSQuery.Response(null, 1, "OFFICE_REQUEST_REJECTED");
        }
        try {
            PetOfficePrototypeMessage data = PetOfficePrototypeMessage.parse(message);
            if (!currentPage.equals(data.pageGeneration())) {
                return new JBCefJSQuery.Response(null, 1, "OFFICE_STALE_PAGE");
            }
            String command = data.command();
            if (pendingUiMessages.incrementAndGet() > 16) {
                pendingUiMessages.decrementAndGet();
                return new JBCefJSQuery.Response(null, 1, "OFFICE_REQUEST_BUSY");
            }
            onEdt(() -> {
                try {
                    if (disposed.get() || attempt != generation.get() || !currentPage.equals(pageGeneration) || window == null) {
                        return;
                    }
                    switch (command) {
                        case "ready":
                            if (data.protocolVersion() != PetOfficeSceneProtocol.VERSION) {
                                closeWindow(false);
                                notifyFailure("OFFICE_PROTOCOL_MISMATCH");
                                break;
                            }
                            if (frontendReady) {
                                break;
                            }
                            frontendReady = true;
                            publishTopmost();
                            sessionPublisher = PetOfficeSessionPublisher.getInstance();
                            sessionPublisher.setOfficeActive(true);
                            startLivePage(attempt, currentPage);
                            cancelReadyDeadline();
                            publishVisibility(window.isVisible() && (window.getExtendedState() & Frame.ICONIFIED) == 0);
                            LOG.info("[PetOfficePrototype] Dedicated frontend ready");
                            break;
                        case "setTopmost":
                            saveTopmost(data.topmost());
                            break;
                        case "storage":
                            storageRequest(data);
                            break;
                        case "hide":
                            changePresentation(true, false, () -> {
                                publishVisibility(false);
                                window.setVisible(false);
                            });
                            break;
                        case "exit":
                            changePresentation(false, false, () -> closeWindow(false));
                            break;
                        case "metrics":
                            logMetrics(data.metrics());
                            break;
                        case "sceneAck":
                            if (livePage != null) {
                                livePage.delivery.acceptAck(data.field("transferId"), data.sequence());
                            }
                            break;
                        case "resync":
                            if (livePage != null && System.nanoTime() - livePage.lastResync >= 2_000_000_000L) {
                                livePage.lastResync = System.nanoTime();
                                livePage.delivery.requestResync();
                                refreshScene(livePage);
                            }
                            break;
                        case "navigate":
                            navigate(data, receivedAt);
                            break;
                        case "asset":
                            requestAsset(data);
                            break;
                        default:
                            break;
                    }
                } finally {
                    pendingUiMessages.decrementAndGet();
                }
            });
            return null;
        } catch (IOException | RuntimeException malformed) {
            return new JBCefJSQuery.Response(null, 1, "OFFICE_REQUEST_INVALID");
        }
    }

    private void publishTopmost() {
        if (browser != null && frontendReady && window != null) {
            browser.getCefBrowser().executeJavaScript("window.petOfficeSetTopmost&&window.petOfficeSetTopmost(" + window.isAlwaysOnTop() + ");", trustedUrl, 0);
        }
    }

    private static java.util.List<java.awt.Rectangle> usableScreens() {
        java.util.List<java.awt.Rectangle> screens = new java.util.ArrayList<>();
        for (var device : GraphicsEnvironment.getLocalGraphicsEnvironment().getScreenDevices()) {
            var configuration = device.getDefaultConfiguration();
            var area = new java.awt.Rectangle(configuration.getBounds());
            var insets = java.awt.Toolkit.getDefaultToolkit().getScreenInsets(configuration);
            area.x += insets.left;
            area.y += insets.top;
            area.width -= insets.left + insets.right;
            area.height -= insets.top + insets.bottom;
            if (area.width > 0 && area.height > 0) {
                screens.add(area);
            }
        }
        return screens;
    }

    private void scheduleBoundsSave(JFrame expected, long attempt) {
        if (window != expected || attempt != generation.get() || !expected.isShowing() || expected.getExtendedState() != Frame.NORMAL) {
            return;
        }
        var bounds = expected.getBounds();
        if (bounds.width < 320 || bounds.height < 320) {
            return;
        }
        if (boundsSave != null) {
            boundsSave.cancel(false);
        }
        PetOfficeRuntimeLease held = lease;
        var root = runtimeDirectory;
        boundsSave = AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> submit(() -> {
            saveNormalBounds(root, held, bounds, attempt);
        }), 500, TimeUnit.MILLISECONDS);
    }

    private void saveNormalBounds(java.nio.file.Path root, PetOfficeRuntimeLease held, java.awt.Rectangle bounds, long attempt) {
        if (bounds == null || disposed.get() || attempt != generation.get() || held != lease || !runtimeService.owns(held)) {
            return;
        }
        try {
            var store = new PetOfficePreferencesStore(root);
            synchronized (held) {
                var state = store.read().state();
                var normal = new PetOfficePreferencesStore.Bounds(bounds.x, bounds.y, bounds.width, bounds.height, true);
                if (!normal.equals(state.bounds())) {
                    var next = store.update(state.revision(), null, normal, held);
                    onEdt(() -> publishPreferences(next, attempt));
                }
            }
        } catch (IOException invalid) {
            LOG.warn("[PetOffice] OFFICE_PREFERENCES_UNAVAILABLE");
        }
    }

    private void publishPreferences(PetOfficePreferencesStore.State state, long attempt) {
        if (attempt == generation.get() && window != null && browser != null && frontendReady && lease != null && runtimeService.owns(lease)) {
            window.setTitle(windowTitle(state.preferences()));
            window.setAlwaysOnTop(state.preferences().topmost());
            browser.getCefBrowser().executeJavaScript("window.petOfficePreferencesChanged&&window.petOfficePreferencesChanged("
                    + new com.google.gson.Gson().toJson(state) + ");", trustedUrl, 0);
            publishTopmost();
        }
    }

    static String windowTitle(PetOfficePreferencesStore.Preferences preferences) {
        return preferences.officeName().isEmpty() ? ClaudeCodeGuiBundle.message("petOffice.prototype.title") : preferences.officeName();
    }

    private void saveTopmost(boolean topmost) {
        LivePage context = livePage;
        if (context == null || !current(context)) {
            return;
        }
        submit(() -> {
            if (!current(context)) {
                return;
            }
            try {
                PetOfficeRuntimeLease held = lease;
                synchronized (held) {
                    var store = new PetOfficePreferencesStore(runtimeDirectory);
                    var state = store.read().state();
                    var p = state.preferences();
                    var changed = new PetOfficePreferencesStore.Preferences(p.limitMiB(), p.floors(), p.floor(), p.product(), p.search(),
                            p.showIdle(), p.paused(), topmost, p.zoom(), p.presentation(), p.appearanceOverrides(), p.officeName());
                    var next = store.update(state.revision(), changed, null, held);
                    onEdt(() -> publishPreferences(next, context.attempt));
                }
            } catch (IOException invalid) {
                publishPacket(context, PetOfficeSceneProtocol.result(context.page, UUID.randomUUID().toString(), "OFFICE_PREFERENCES_UNAVAILABLE"));
            }
        });
    }

    private void storageRequest(PetOfficePrototypeMessage data) {
        LivePage context = livePage;
        if (context == null || !current(context)) {
            return;
        }
        if (context.storageRequests.incrementAndGet() > 2) {
            context.storageRequests.decrementAndGet();
            dispatchStorage(context, java.util.List.of(context.storage.error(data.field("requestId"), "OFFICE_STORAGE_BUSY")), 0, () -> { });
            return;
        }
        if (!submit(() -> {
            try {
                var packets = context.storage.request(data.field("requestId"), data.field("operation"), data.field("payload"));
                if (data.field("operation").equals("preferences")) {
                    var state = new PetOfficePreferencesStore(runtimeDirectory).read().state();
                    onEdt(() -> publishPreferences(state, context.attempt));
                }
                dispatchStorage(context, packets, 0, context.storageRequests::decrementAndGet);
            } catch (IOException | RuntimeException failure) {
                String message = failure.getMessage();
                String code = message != null && message.matches("OFFICE_[A-Z_]{1,56}") ? message : "OFFICE_STORAGE_INVALID";
                dispatchStorage(context, java.util.List.of(context.storage.error(data.field("requestId"), code)), 0, context.storageRequests::decrementAndGet);
            }
        })) {
            context.storageRequests.decrementAndGet();
        }
    }

    private void dispatchStorage(LivePage context, java.util.List<com.google.gson.JsonObject> packets, int start, Runnable finished) {
        onEdt(() -> {
            if (!current(context) || browser == null || !frontendReady) {
                finished.run();
                return;
            }
            int end = Math.min(start + 8, packets.size());
            try {
                for (int index = start; index < end; index++) {
                    var packet = packets.get(index);
                    packet.addProperty("pageGeneration", context.page);
                    browser.getCefBrowser().executeJavaScript("window.petOfficeStorageResult&&window.petOfficeStorageResult(" + packet + ");", trustedUrl, 0);
                }
            } catch (RuntimeException unavailable) {
                finished.run();
                return;
            }
            if (end < packets.size()) {
                ApplicationManager.getApplication().invokeLater(() -> dispatchStorage(context, packets, end, finished), ModalityState.any());
            } else {
                finished.run();
            }
        });
    }

    private void showOwned(PetOfficeRuntimeLease expected) {
        onEdt(() -> {
            if (!disposed.get() && lease == expected && window != null && window.isDisplayable() && runtimeService != null && runtimeService.owns(expected)) {
                changePresentation(true, true, () -> {
                    window.setAutoRequestFocus(true);
                    window.setExtendedState(window.getExtendedState() & ~Frame.ICONIFIED);
                    window.setVisible(true);
                    publishVisibility(true);
                    window.toFront();
                });
            }
        });
    }

    void coordinatorLost(PetOfficeRuntimeLease expected) {
        onEdt(() -> {
            if (!disposed.get() && lease == expected) {
                LOG.warn("[PetOffice] OFFICE_COORDINATOR_UNAVAILABLE");
                closeWindow(false);
            }
        });
    }

    void exitOwned(PetOfficeRuntimeLease expected) {
        onEdt(() -> {
            if (disposed.get() || runtimeService == null || !runtimeService.owns(expected)) {
                return;
            }
            if (lease == expected && window != null) {
                changePresentation(false, false, () -> closeWindow(false));
            } else if (opening.get() && window == null) {
                generation.incrementAndGet();
                opening.set(false);
                runtimeService.presentation(expected, false, false, result -> {
                    if (result.isEmpty()) {
                        closeLeaseAsync(expected);
                    }
                });
            }
        });
    }

    private void changePresentation(boolean enabled, boolean visible, Runnable apply) {
        PetOfficeRuntimeLease expected = lease;
        JFrame expectedWindow = window;
        long revision = ++presentationRevision;
        if (runtimeService == null || expected == null) {
            return;
        }
        var bounds = expectedWindow != null && expectedWindow.isShowing() && expectedWindow.getExtendedState() == Frame.NORMAL
                && expectedWindow.getWidth() >= 320 && expectedWindow.getHeight() >= 320 ? expectedWindow.getBounds() : null;
        var root = runtimeDirectory;
        long attempt = generation.get();
        submit(() -> {
            saveNormalBounds(root, expected, bounds, attempt);
            runtimeService.presentation(expected, enabled, visible, error -> onEdt(() -> {
                if (disposed.get() || lease != expected || window != expectedWindow || revision != presentationRevision) {
                    return;
                }
                if (error.isEmpty()) {
                    apply.run();
                } else {
                    notifyFailure(error);
                }
            }));
        });
    }

    private void notifyFailure(String code) {
        if (!disposed.get()) {
            NotificationGroupManager.getInstance().getNotificationGroup("CC GUI Notifications")
                    .createNotification(ClaudeCodeGuiBundle.message("petOffice.prototype.title"),
                            ClaudeCodeGuiBundle.message("petOffice.prototype.unavailable", code), NotificationType.WARNING).notify(null);
        }
    }

    private void startLivePage(long attempt, String page) {
        LivePage context = new LivePage(attempt, page);
        livePage = context;
        context.timer = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(() -> refreshScene(context), 0, 2, TimeUnit.SECONDS);
    }

    private boolean current(LivePage context) {
        return !disposed.get() && livePage == context && !context.closed.get() && generation.get() == context.attempt
                && lease != null && runtimeService != null && runtimeService.owns(lease);
    }

    private void refreshScene(LivePage context) {
        if (!current(context) || !context.delivery.canSend() || !context.refreshing.compareAndSet(false, true)) {
            return;
        }
        if (!submit(() -> {
            try {
                if (!current(context)) {
                    return;
                }
                PetOfficeParticipantRegistry.View initial = runtimeService.view();
                PetOfficeSessionRegistry.CompleteSnapshot snapshot = initial.snapshot();
                context.appearances.beginSnapshot();
                Map<String, PetOfficeAppearanceService.Appearance> appearances = new LinkedHashMap<>();
                appearances.putAll(runtimeService.appearances(snapshot));
                // Appearance IO runs independently; recapture facts without renewing backend observations.
                PetOfficeParticipantRegistry.View latest = runtimeService.view();
                PetOfficeSessionRegistry.CompleteSnapshot fresh = latest.snapshot();
                var overrides = new PetOfficePreferencesStore(runtimeDirectory).read().state().preferences().appearanceOverrides();
                Map<String, PetOfficeAppearanceService.Appearance> admitted = new LinkedHashMap<>();
                for (PetOfficeSessionRegistry.SourceSnapshot source : fresh.sources()) {
                    String key = PetOfficeSessionRegistry.key(source.sourceKey());
                    var visual = appearances.get(key);
                    if (overrides.containsKey(key)) {
                        visual = context.appearances.resolveSession(visual, overrides.get(key), context.lastResync);
                    }
                    admitted.put(key, visual == null ? remoteAppearance(context) : visual);
                }
                PetOfficeSceneProtocol.Transfer transfer = context.delivery.prepare(new PetOfficeSceneProtocol.Scene(fresh, admitted, latest.participants()));
                if (transfer != null && current(context)) {
                    dispatchTransfer(context, transfer, () -> context.delivery.isCurrent(transfer), () -> context.delivery.markSent(transfer), 0);
                }
            } catch (IOException | RuntimeException failure) {
                LOG.warn("[PetOffice] Local scene unavailable; retaining the last complete scene");
            } finally {
                context.refreshing.set(false);
            }
        })) {
            context.refreshing.set(false);
        }
    }

    private void navigate(PetOfficePrototypeMessage data, long receivedAt) {
        LivePage context = livePage;
        if (context == null || !current(context)) {
            return;
        }
        PetOfficeTabNavigator.Request request = new PetOfficeTabNavigator.Request(data.field("requestId"), data.field("sourceKey"),
                data.field("routeGeneration"), data.field("interactionId"));
        runtimeService.navigate(context.page, request, () -> current(context),
                result -> publishPacket(context, PetOfficeSceneProtocol.result(context.page, request.requestId(), result.name())), receivedAt);
    }

    private void requestAsset(PetOfficePrototypeMessage data) {
        LivePage context = livePage;
        if (context == null || !current(context)) {
            return;
        }
        if (context.assetRequests.incrementAndGet() > 2) {
            context.assetRequests.decrementAndGet();
            publishPacket(context, PetOfficeSceneProtocol.result(context.page, data.field("requestId"), "ASSET_BUSY"));
            return;
        }
        if (!submitAsset(() -> {
            boolean dispatched = false;
            try {
                var appearance = context.delivery.appearance(data.field("sourceKey"), data.field("appearanceRevision"), data.field("assetDigest"));
                boolean registered = runtimeService.view().snapshot().sources().stream()
                        .anyMatch(source -> PetOfficeSessionRegistry.key(source.sourceKey()).equals(data.field("sourceKey")));
                if (!current(context) || appearance == null || !registered) {
                    throw new IOException("OFFICE_ASSET_STALE");
                }
                byte[] bytes = "session".equals(appearance.scope()) ? context.appearances.bytes(appearance.manifest())
                        : runtimeService.assetBytes(data.field("sourceKey"), appearance, () -> current(context)
                            && context.delivery.appearance(data.field("sourceKey"), data.field("appearanceRevision"), data.field("assetDigest")) != null);
                if (bytes == null) {
                    throw new IOException("OFFICE_ASSET_RETRY");
                }
                var transfer = PetOfficeSceneProtocol.asset(context.page, data.field("requestId"), data.field("sourceKey"),
                        data.field("appearanceRevision"), appearance.manifest(), bytes);
                dispatchTransfer(context, transfer, () -> context.delivery.appearance(data.field("sourceKey"),
                                data.field("appearanceRevision"), data.field("assetDigest")) != null,
                        () -> context.assetRequests.decrementAndGet(), 0);
                dispatched = true;
            } catch (IOException | RuntimeException failure) {
                publishPacket(context, PetOfficeSceneProtocol.result(context.page, data.field("requestId"), "ASSET_RETRY"));
            } finally {
                if (!dispatched) {
                    context.assetRequests.decrementAndGet();
                }
            }
        })) {
            context.assetRequests.decrementAndGet();
        }
    }

    private void dispatchTransfer(LivePage context, PetOfficeSceneProtocol.Transfer transfer, BooleanSupplier allowed, Runnable finished, int start) {
        onEdt(() -> {
            if (!current(context) || !allowed.getAsBoolean() || browser == null || !frontendReady) {
                finished.run();
                return;
            }
            try {
                int end = Math.min(start + 8, transfer.frames().size());
                for (int index = start; index < end; index++) {
                    browser.getCefBrowser().executeJavaScript("window.petOfficeReceive&&window.petOfficeReceive(" + transfer.frames().get(index) + ");", trustedUrl, 0);
                }
                if (end < transfer.frames().size()) {
                    ApplicationManager.getApplication().invokeLater(() -> dispatchTransfer(context, transfer, allowed, finished, end), ModalityState.any());
                } else {
                    finished.run();
                }
            } catch (RuntimeException | LinkageError failure) {
                finished.run();
                LOG.warn("[PetOffice] Scene transfer unavailable");
            }
        });
    }

    private void publishPacket(LivePage context, String packet) {
        onEdt(() -> {
            if (current(context) && browser != null && frontendReady) {
                browser.getCefBrowser().executeJavaScript("window.petOfficeReceive&&window.petOfficeReceive(" + packet + ");", trustedUrl, 0);
            }
        });
    }

    private static PetOfficeAppearanceService.Appearance remoteAppearance(LivePage context) {
        var fallback = context.appearances.resolve(null);
        return new PetOfficeAppearanceService.Appearance(fallback.revision(), fallback.scope(), fallback.opacity(), fallback.actionMappings(), "ASSET_BUSY", fallback.manifest());
    }

    private void logMetrics(PetOfficePrototypeMessage.Metrics metrics) {
        if (metrics == null || System.nanoTime() - lastMetricsLog < 30_000_000_000L) {
            return;
        }
        lastMetricsLog = System.nanoTime();
        LOG.info("[PetOfficePrototype] fps=" + metrics.fps() + " drawMs=" + metrics.drawMs()
                + " visible=" + metrics.visibleSources() + " decodedBytes=" + metrics.decodedBytes());
    }

    private void publishVisibility(boolean visible) {
        if (browser != null && frontendReady) {
            browser.getCefBrowser().executeJavaScript("window.petOfficeSetVisible&&window.petOfficeSetVisible(" + visible + ");", trustedUrl, 0);
        }
    }

    private void closeWindow(boolean finalDispose) {
        if (boundsSave != null) {
            boundsSave.cancel(false);
            boundsSave = null;
        }
        LivePage context = livePage;
        livePage = null;
        if (context != null) {
            context.closed.set(true);
            context.delivery.close();
            submit(context.storage::close);
            context.publisher.navigator().closePage(context.page);
            if (runtimeService != null) {
                runtimeService.closePage(context.page);
            }
            if (context.timer != null) {
                context.timer.cancel(false);
            }
            submit(context.appearances::clear);
        }
        if (sessionPublisher != null) {
            sessionPublisher.setOfficeActive(false);
        }
        generation.incrementAndGet();
        cancelReadyDeadline();
        opening.set(false);
        frontendReady = false;
        boolean browserDisposed = true;
        if (browser != null) {
            try {
                if (requestHandler != null) {
                    browser.getJBCefClient().removeRequestHandler(requestHandler, browser.getCefBrowser());
                }
            } catch (RuntimeException | LinkageError failure) {
                LOG.warn("[PetOfficePrototype] OFFICE_HANDLER_DISPOSAL_FAILED");
            }
            if (query != null) {
                browserDisposed = disposeResource(query);
            }
            browserDisposed &= disposeResource(browser);
        }
        if (window != null) {
            try {
                window.dispose();
            } catch (RuntimeException failure) {
                LOG.warn("[PetOfficePrototype] OFFICE_WINDOW_DISPOSAL_FAILED");
            }
            if (window.isDisplayable()) {
                LOG.warn("[PetOfficePrototype] OFFICE_WINDOW_DISPOSAL_PENDING");
                return;
            }
        }
        if (!browserDisposed) {
            LOG.warn("[PetOfficePrototype] OFFICE_BROWSER_DISPOSAL_PENDING");
            return;
        }
        window = null;
        browser = null;
        query = null;
        requestHandler = null;
        pageGeneration = null;
        PetOfficeRuntimeLease old = lease;
        lease = null;
        if (old != null) {
            closeLeaseAsync(old);
        }
        if (finalDispose) {
            worker.shutdown();
            assetWorker.shutdownNow();
        }
    }

    private void cancelReadyDeadline() {
        if (readyDeadline != null) {
            readyDeadline.cancel(false);
            readyDeadline = null;
        }
    }

    private void closeLeaseAsync(PetOfficeRuntimeLease old) {
        Runnable cleanup = () -> {
            if (runtimeService != null) {
                runtimeService.stopOwner(old);
            }
            closeLease(old);
        };
        if (!submit(cleanup)) {
            // A late acquisition callback can arrive after plugin disposal. It owns no window.
            AppExecutorUtil.getAppExecutorService().execute(cleanup);
        }
    }

    private static boolean disposeResource(Disposable resource) {
        try {
            Disposer.dispose(resource);
            return Disposer.isDisposed(resource);
        } catch (RuntimeException | LinkageError failure) {
            LOG.warn("[PetOfficePrototype] OFFICE_BROWSER_DISPOSAL_FAILED");
            return false;
        }
    }

    private static void closeLease(PetOfficeRuntimeLease old) {
        try {
            old.close();
        } catch (IOException failure) {
            LOG.warn("[PetOfficePrototype] OFFICE_LOCK_RELEASE_FAILED");
        }
    }

    private boolean submit(Runnable action) {
        try {
            worker.execute(action);
            return true;
        } catch (RejectedExecutionException shutdown) {
            LOG.debug("[PetOfficePrototype] Worker already stopped");
            return false;
        }
    }

    private boolean submitAsset(Runnable action) {
        try {
            assetWorker.execute(action);
            return true;
        } catch (RejectedExecutionException stopped) {
            return false;
        }
    }

    private static void onEdt(Runnable action) {
        if (ApplicationManager.getApplication().isDispatchThread()) {
            action.run();
        } else {
            ApplicationManager.getApplication().invokeLater(action, ModalityState.any());
        }
    }

    @Override
    public void dispose() {
        if (disposed.compareAndSet(false, true)) {
            onEdt(() -> closeWindow(true));
        }
    }

    private final class LivePage {
        private final long attempt;
        private final String page;
        private final PetOfficeSessionPublisher publisher = sessionPublisher;
        private final PetOfficeSceneDelivery delivery;
        private final PetOfficeSharedStorage storage;
        private final AtomicInteger storageRequests = new AtomicInteger();
        private final PetOfficeAppearanceService appearances = new PetOfficeAppearanceService(
                () -> PetOfficeAssetRoot.resolvePets(java.nio.file.Path.of(com.github.claudecodegui.util.PlatformUtils.getHomeDirectory())),
                () -> com.github.claudecodegui.bridge.AiDataProcessGate.getInstance().tryAcquireReadPermit());
        private final AtomicBoolean closed = new AtomicBoolean();
        private final AtomicBoolean refreshing = new AtomicBoolean();
        private final AtomicInteger assetRequests = new AtomicInteger();
        private ScheduledFuture<?> timer;
        private volatile long lastResync;

        private LivePage(long attempt, String page) {
            this.attempt = attempt;
            this.page = page;
            this.delivery = new PetOfficeSceneDelivery(page);
            this.storage = new PetOfficeSharedStorage(runtimeDirectory, lease, () -> current(this), appearances::choices);
        }
    }
}
