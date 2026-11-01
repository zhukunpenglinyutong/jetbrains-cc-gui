package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.model.SessionTemplate;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/** Tests the UI acceptance boundary for all three session replacement operations. */
public class SessionLifecycleQuiescenceTest {
    private Application previousApplication;

    @Before
    public void runUiDispatchInline() {
        previousApplication = ApplicationManager.getApplication();
        ApplicationManager.setApplication((Application) Proxy.newProxyInstance(Application.class.getClassLoader(),
                new Class<?>[]{Application.class}, (proxy, method, arguments) -> {
                    if (method.getName().equals("invokeLater") && arguments[0] instanceof Runnable task) {
                        task.run();
                    }
                    return method.getReturnType() == boolean.class ? false : null;
                }));
    }

    @After
    public void restoreApplication() {
        ApplicationManager.setApplication(previousApplication);
    }

    @Test
    public void newTemplateAndHistoryWaitForStopThenAcceptAnAlreadyRetiredRuntime() {
        for (Consumer<SessionLifecycleManager> action : operations()) {
            try (Host host = new Host()) {
                ClaudeSession previous = host.session;
                action.accept(manager(host));
                assertSame(previous, host.session);
                assertFalse(host.events.contains("clearMessages"));
                assertFalse(host.invalidated);
                assertTrue(host.events.indexOf("sessionTransitionStarted") < host.events.indexOf("interrupt"));

                // Same successful no-op acknowledgement as a daemon whose idle reaper
                // already removed the runtime. A persistent Java channel is still present.
                assertEquals("persistent-channel", previous.getChannelId());
                host.stopped.complete(null);
                assertNotSame(previous, host.session);
                assertTrue(host.invalidated);
                assertEquals(1, host.events.stream().filter("clearMessages"::equals).count());
                assertFalse(host.events.contains("sessionTransitionFailed"));
            }
        }
    }

    @Test
    public void lateCompletionAndFailureCannotReplaceANewerAcceptedSession() {
        for (boolean failOld : List.of(false, true)) {
            try (Host host = new Host()) {
                host.secondStop = new CompletableFuture<>();
                SessionLifecycleManager manager = manager(host);
                manager.createNewSession("request-A");
                manager.createNewSession("request-B");
                host.secondStop.complete(null);
                ClaudeSession replacement = host.session;
                assertEquals("request-B", host.lastClearToken);
                if (failOld) {
                    host.stopped.completeExceptionally(new IllegalStateException("Old Stop failed late"));
                } else {
                    host.stopped.complete(null);
                }
                assertSame(replacement, host.session);
                assertEquals(1, host.events.stream().filter("clearMessages"::equals).count());
                assertFalse(host.events.contains("sessionTransitionFailed"));
            }
        }
    }

    @Test
    public void acceptancePublishesTheReplacementBeforeFrontendSettingsCanReturn() {
        for (Consumer<SessionLifecycleManager> action : operations()) {
            try (Host host = new Host()) {
                ClaudeSession previous = host.session;
                String oldModel = previous.getModel();
                host.onClear = accepted -> {
                    assertNotSame(previous, accepted);
                    assertSame(accepted, host.context.getSession());
                    // Simulate an immediate settings command from the frontend's
                    // matching clearMessages/onAccepted callback. Bootstrap must
                    // neither apply it to the old binding nor overwrite it later.
                    host.context.getSession().setModelVerbatim("selected-after-acceptance");
                };
                action.accept(manager(host));
                host.stopped.complete(null);
                assertEquals("selected-after-acceptance", host.session.getModel());
                assertEquals(oldModel, previous.getModel());
                assertFalse(host.events.contains("sessionTransitionFailed"));
                if (host.events.contains("setSessionId")) {
                    assertTrue(host.events.indexOf("clearMessages") < host.events.indexOf("setSessionId"));
                }
            }
        }
    }

    @Test
    public void providerChangeAppliesOnlyToTheAcceptedReplacementAndExternalSelectionFencesPendingWork() {
        try (Host host = new Host()) {
            SessionLifecycleManager manager = manager(host);
            manager.createNewSession("change-provider", "codex");
            assertEquals("claude", host.session.getProvider());
            host.stopped.complete(null);
            assertEquals("codex", host.session.getProvider());
            assertEquals("change-provider", host.lastClearToken);
        }
        try (Host host = new Host()) {
            SessionLifecycleManager manager = manager(host);
            ClaudeSession original = host.session;
            manager.createNewSession("superseded-by-codex-history");
            manager.invalidatePendingTransition();
            host.stopped.complete(null);
            assertSame(original, host.session);
            assertFalse(host.events.contains("clearMessages"));
        }
    }

    @Test
    public void failedStopPreservesBindingCallbacksAndMessagesAndRefreshesBeforeFailureSignal() throws Exception {
        for (Consumer<SessionLifecycleManager> action : operations()) {
            try (Host host = new Host()) {
                ClaudeSession previous = host.session;
                action.accept(manager(host));
                previous.getState().addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT,
                        "Output received while Stop was pending", null));
                host.stopped.completeExceptionally(new IllegalStateException("Native cleanup is still pending"));

                assertTrue(host.failure.await(5, TimeUnit.SECONDS));
                assertSame(previous, host.session);
                assertEquals("previous-session", host.session.getSessionId());
                assertFalse(host.invalidated);
                assertFalse(host.events.contains("clearMessages"));
                assertTrue(host.events.indexOf("updateMessages") < host.events.indexOf("sessionTransitionFailed"));
                assertTrue(host.lastSnapshot.contains("Output received while Stop was pending"));
                assertEquals(2, host.session.getMessages().size());
            }
        }
    }

    private static List<Consumer<SessionLifecycleManager>> operations() {
        SessionTemplate template = new SessionTemplate("fixture", "claude", "opus", "default", "high", "/fixture", false);
        return List.of(SessionLifecycleManager::createNewSession,
                manager -> manager.createNewSessionFromTemplate(template),
                manager -> manager.loadHistorySession("next-session", "/fixture", "claude", "opus"));
    }

    private static SessionLifecycleManager manager(Host host) {
        return new SessionLifecycleManager(host) {
            @Override public String determineWorkingDirectory() { return "/fixture"; }
            @Override public void fetchSlashCommandsOnStartup() { }
        };
    }

    private static final class Host implements SessionLifecycleManager.SessionHost, AutoCloseable {
        private final CompletableFuture<Void> stopped = new CompletableFuture<>();
        private CompletableFuture<Void> secondStop;
        private int stopCalls;
        private final List<String> events = new CopyOnWriteArrayList<>();
        private final CountDownLatch failure = new CountDownLatch(1);
        private final HandlerContext context = new HandlerContext(null, null, null, null, null);
        private final StreamMessageCoalescer coalescer;
        private ClaudeSession session;
        private boolean invalidated;
        private String lastSnapshot = "";
        private String lastClearToken;
        private Consumer<ClaudeSession> onClear = ignored -> { };

        Host() {
            session = new ClaudeSession(null, null, null, null) {
                @Override public CompletableFuture<Void> interrupt() {
                    events.add("interrupt");
                    return stopCalls++ == 0 || secondStop == null ? stopped : secondStop;
                }
            };
            session.setProvider("claude");
            session.setSessionInfo("previous-session", "/fixture");
            session.getState().setChannelId("persistent-channel");
            session.getState().addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "Original request", null));
            context.setSession(session);
            coalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
                @Override public boolean callJavaScript(String name, String... args) {
                    Host.this.callJavaScript(name, args);
                    return true;
                }
                @Override public boolean isDisposed() { return false; }
                @Override public HandlerContext getHandlerContext() { return context; }
            });
        }

        @Override public Project getProject() { return null; }
        @Override public ClaudeSDKBridge getClaudeSDKBridge() { return null; }
        @Override public CodexSDKBridge getCodexSDKBridge() { return null; }
        @Override public Map<String, MarkerCliBridge> getCliBridges() { return Map.of(); }
        @Override public ClaudeSession getSession() { return session; }
        @Override public void setSession(ClaudeSession value) { session = value; }
        @Override public HandlerContext getHandlerContext() { return context; }
        @Override public StreamMessageCoalescer getStreamCoalescer() { return coalescer; }
        @Override public void clearPendingPermissionRequests() { }
        @Override public void clearPermissionDecisionMemory() { }
        @Override public void callJavaScript(String name, String... args) {
            events.add(name);
            if (name.equals("updateMessages")) { lastSnapshot = args[0]; }
            if (name.equals("clearMessages")) {
                if (args.length > 1) { lastClearToken = args[1]; }
                onClear.accept(session);
            }
            if (name.equals("sessionTransitionFailed")) { failure.countDown(); }
        }
        @Override public boolean isDisposed() { return false; }
        @Override public JBCefBrowser getBrowser() { return null; }
        @Override public void setupSessionCallbacks() {
            session.setCallback((ClaudeSession.SessionCallback) Proxy.newProxyInstance(
                    ClaudeSession.SessionCallback.class.getClassLoader(), new Class<?>[]{ClaudeSession.SessionCallback.class},
                    (proxy, method, args) -> {
                        if (method.getName().equals("onSessionIdReceived")) { events.add("setSessionId"); }
                        return null;
                    }));
        }
        @Override public void invalidateSessionCallbacks() { invalidated = true; }
        @Override public void setSlashCommandsFetched(boolean value) { }
        @Override public void setFetchedSlashCommandsCount(int count) { }
        @Override public void close() { coalescer.dispose(); }
    }
}
