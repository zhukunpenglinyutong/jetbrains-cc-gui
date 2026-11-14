package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.TabStateService;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Loads the history of a tab restored on IDE startup and reports its progress to the webview.
 * Owns the restore state that used to live in {@link ClaudeChatWindow}; this object's monitor
 * replaces the window monitor those methods synchronized on.
 */
final class RestoredHistoryLoader {

    /** The chat window state the restore reads at call time. */
    interface Host {
        ClaudeSession currentSession();

        boolean isFrontendReady();

        boolean isDisposed();

        boolean callJavaScript(String functionName, String... args);

        /** The restored session no longer exists: expose the fresh session that replaced it and persist the tab. */
        void exposeReplacementSession();
    }

    private static final Logger LOG = Logger.getInstance(RestoredHistoryLoader.class);

    private final CodemossSettingsService settingsService;
    private final Host host;
    private final AtomicLong restoredHistoryLoadGeneration = new AtomicLong();
    private final AtomicReference<RestoredHistoryLoadRequest> activeRestoredHistoryLoad =
            new AtomicReference<>();
    private final RestoredHistorySession<ClaudeSession> restoredHistory = new RestoredHistorySession<>();
    private volatile JsonObject restoredHistoryLoadState;

    RestoredHistoryLoader(CodemossSettingsService settingsService, Host host) {
        this.settingsService = settingsService;
        this.host = host;
    }

    /** Binds a freshly restored tab session; its history has not been attempted yet. */
    void bind(ClaudeSession session, String restoredSessionId) {
        restoredHistory.bind(session, restoredSessionId);
        restoredHistoryLoadState = null;
    }

    void dispose() {
        RestoredHistoryLoadRequest historyRequest = activeRestoredHistoryLoad.getAndSet(null);
        if (historyRequest != null) {
            try {
                historyRequest.cancel(RestoredHistoryLoadRequest.CANCELLED);
            } catch (Exception | LinkageError error) {
                LOG.warn("Failed to cancel restored history loading", error);
            }
        }
    }

    synchronized void loadIfNeeded() {
        if (!isRestoredHistorySessionCurrent() || !host.isFrontendReady()) {
            return;
        }
        RestoredHistoryLoadRequest active = activeRestoredHistoryLoad.get();
        if (active != null) {
            publishRestoredHistoryState("loading", active, null, null, 0, false);
            return;
        }
        if (restoredHistory.wasAttempted()) {
            // Activation or a reloaded webview may replay an outcome, but retry
            // remains an explicit user action after failure, timeout or cancel.
            JsonObject previous = restoredHistoryLoadState;
            if (previous != null) {
                host.callJavaScript("updateStartupHistoryLoadState", JsUtils.escapeJs(previous.toString()));
            }
            return;
        }
        if (!settingsService.isLoadHistoryOnStartup()) {
            publishRestoredHistoryState("unloaded", null, null, null, 0, true);
            return;
        }
        startLoad();
    }

    void loadIfNeeded(TabStateService.TabSessionState savedState) {
        if (!TabSessionRestorePolicy.shouldStartHistoryLoad(savedState, host.isFrontendReady(), settingsService.isLoadHistoryOnStartup())
                || host.currentSession() == null || !isNonEmpty(host.currentSession().getSessionId())) {
            return;
        }
        loadIfNeeded();
    }

    void loadManually() {
        if (!host.isFrontendReady() || !isRestoredHistorySessionCurrent()) {
            publishRestoredHistoryState("failed", null, "HISTORY_LOAD_SESSION_CHANGED",
                    "The restored session is no longer active", 0, false);
            return;
        }
        startLoad();
    }

    void cancel(String requestId) {
        RestoredHistoryLoadRequest request = activeRestoredHistoryLoad.get();
        if (request == null || requestId == null || !request.requestId().equals(requestId.trim())) {
            return;
        }
        if (request.cancel(RestoredHistoryLoadRequest.CANCELLED)) {
            request.completeExceptionally(
                    new java.util.concurrent.CancellationException("History loading was cancelled"));
        }
    }

    private synchronized void startLoad() {
        ClaudeSession restoringSession = host.currentSession();
        if (restoringSession == null || !isRestoredHistorySessionCurrent()) {
            return;
        }
        String restoringSessionId = restoringSession.getSessionId();
        long generation = restoredHistoryLoadGeneration.get() + 1;
        RestoredHistoryLoadRequest request = new RestoredHistoryLoadRequest(generation,
                () -> isRestoredHistoryRequestCurrent(generation, restoringSession, restoringSessionId));
        if (!activeRestoredHistoryLoad.compareAndSet(null, request)) {
            RestoredHistoryLoadRequest active = activeRestoredHistoryLoad.get();
            if (active != null) {
                publishRestoredHistoryState("loading", active, null, null, 0, false);
            }
            return;
        }
        restoredHistoryLoadGeneration.set(generation);
        restoredHistory.markAttempted();

        publishRestoredHistoryState("loading", request, null, null, 0, false);
        long loadStartedNanos = System.nanoTime();
        CompletableFuture<Void> loadFuture;
        try {
            loadFuture = restoringSession.loadFromServer(request);
        } catch (RuntimeException error) {
            completeRestoredHistoryLoad(request, restoringSession, restoringSessionId, error, loadStartedNanos);
            return;
        }
        int timeoutSeconds = settingsService.getHistoryLoadTimeoutSeconds();
        request.bind(loadFuture, AppExecutorUtil.getAppScheduledExecutorService(), timeoutSeconds);
        loadFuture.whenComplete((ignored, error) -> {
            completeRestoredHistoryLoad(request, restoringSession, restoringSessionId, error, loadStartedNanos);
        });
    }

    private synchronized void completeRestoredHistoryLoad(RestoredHistoryLoadRequest request, ClaudeSession restoringSession,
                                             String restoringSessionId, Throwable error, long loadStartedNanos) {
        if (!activeRestoredHistoryLoad.compareAndSet(request, null)) {
            return;
        }
        if (request.wasCommitted()) {
            restoredHistory.markCommitted(restoringSession, restoringSessionId);
        }
        long elapsedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - loadStartedNanos);
        ApplicationManager.getApplication().invokeLater(() -> onRestoredHistoryLoadFinished(
                request, restoringSession, restoringSessionId, error, elapsedMillis));
    }

    private void onRestoredHistoryLoadFinished(RestoredHistoryLoadRequest request, ClaudeSession restoringSession,
                                              String restoringSessionId, Throwable error, long elapsedMillis) {
        if (host.isDisposed() || host.currentSession() != restoringSession || activeRestoredHistoryLoad.get() != null
                || restoredHistoryLoadGeneration.get() != request.generation()) {
            return;
        }
        if (request.wasCommitted() && !isNonEmpty(restoringSession.getSessionId())) {
            host.exposeReplacementSession();
            host.callJavaScript("historyLoadComplete", "0");
            publishRestoredHistoryState("missing", request, "HISTORY_LOAD_NOT_FOUND",
                    "The session history no longer exists. A new session is ready.", 0, false);
            restoredHistory.complete(restoringSession, restoringSessionId);
            return;
        }
        if (!restoringSessionId.equals(restoringSession.getSessionId())) {
            return;
        }
        if (request.wasCommitted()) {
            int messageCount = restoringSession.getMessages().size();
            LOG.info("[TabRestore] Restored history load completed: provider="
                    + restoringSession.getProvider() + ", status=loaded, elapsedMs=" + elapsedMillis);
            host.callJavaScript("historyLoadComplete", String.valueOf(messageCount));
            publishRestoredHistoryState("loaded", request, null, null, messageCount, false);
            restoredHistory.complete(restoringSession, restoringSessionId);
            return;
        }
        String errorCode = request.cancellationCode();
        if (errorCode == null) {
            errorCode = error == null ? RestoredHistoryLoadRequest.SUPERSEDED : historyLoadErrorCode(error);
        }
        String message = error != null ? errorMessage(error) : "History was not committed; retry loading";
        String status = (RestoredHistoryLoadRequest.TIMEOUT.equals(errorCode)
                || "HISTORY_LOAD_PROVIDER_TIMEOUT".equals(errorCode)) ? "timeout"
                : RestoredHistoryLoadRequest.CANCELLED.equals(errorCode) ? "cancelled" : "failed";
        LOG.warn("[TabRestore] Restored history load ended: provider="
                + restoringSession.getProvider() + ", status=" + status
                + ", errorCode=" + errorCode + ", elapsedMs=" + elapsedMillis, error);
        host.callJavaScript("historyLoadComplete");
        publishRestoredHistoryState(status, request, errorCode, message, 0, true);
    }

    /** A session swap supersedes the restore, so neither its late outcome nor a replay reaches the new session. */
    synchronized void retire() {
        RestoredHistoryLoadRequest active = activeRestoredHistoryLoad.getAndSet(null);
        if (active != null) {
            active.cancel(RestoredHistoryLoadRequest.SUPERSEDED);
        }
        restoredHistoryLoadGeneration.incrementAndGet();
        restoredHistory.retire();
        restoredHistoryLoadState = null;
    }

    /** Settles a pending restore once an ordinary reload of the same session committed its transcript. */
    void settleIfCommitted(ClaudeSession reloaded, long committedBefore) {
        if (reloaded.getCommittedHistoryLoadCount() > committedBefore) {
            settleRestoredHistoryAfterOrdinaryLoad(reloaded);
        }
    }

    /** A committed same-session reload fulfils the pending restore and replaces its stale banner. */
    private synchronized void settleRestoredHistoryAfterOrdinaryLoad(ClaudeSession loadedSession) {
        String loadedSessionId = loadedSession.getSessionId();
        if (host.currentSession() != loadedSession || !restoredHistory.settleByOrdinaryLoad(loadedSession, loadedSessionId)) {
            return;
        }
        RestoredHistoryLoadRequest active = activeRestoredHistoryLoad.getAndSet(null);
        if (active != null) {
            active.cancel(RestoredHistoryLoadRequest.SUPERSEDED);
        }
        restoredHistoryLoadGeneration.incrementAndGet();
        publishRestoredHistoryState("loaded", null, null, null, loadedSession.getMessages().size(), false);
        restoredHistory.complete(loadedSession, loadedSessionId);
    }

    private boolean isRestoredHistoryRequestCurrent(long generation, ClaudeSession expectedSession,
                                                    String expectedSessionId) {
        RestoredHistoryLoadRequest active = activeRestoredHistoryLoad.get();
        return !host.isDisposed() && active != null && active.generation() == generation
                && host.currentSession() == expectedSession && expectedSessionId.equals(expectedSession.getSessionId());
    }

    private boolean isRestoredHistorySessionCurrent() {
        ClaudeSession current = host.currentSession();
        return current != null && restoredHistory.isCurrent(current, current.getSessionId());
    }

    private void publishRestoredHistoryState(String status, RestoredHistoryLoadRequest request,
                                             String errorCode, String message, int messageCount,
                                             boolean retryable) {
        JsonObject payload = new JsonObject();
        payload.addProperty("status", status);
        payload.addProperty("sessionId", restoredHistory.sessionId());
        payload.addProperty("requestId", request != null ? request.requestId() : "");
        payload.addProperty("generation", request != null ? request.generation() : restoredHistoryLoadGeneration.get());
        payload.addProperty("messageCount", messageCount);
        payload.addProperty("retryable", retryable);
        if (errorCode != null) {
            payload.addProperty("errorCode", errorCode);
        }
        if (message != null) {
            payload.addProperty("message", message);
        }
        restoredHistoryLoadState = payload;
        host.callJavaScript("updateStartupHistoryLoadState", JsUtils.escapeJs(payload.toString()));
    }

    private static String errorMessage(Throwable error) {
        Throwable current = error;
        while (current.getCause() != null
                && (current instanceof java.util.concurrent.CompletionException
                || current instanceof java.util.concurrent.ExecutionException)) {
            current = current.getCause();
        }
        return current.getMessage() != null ? current.getMessage() : current.getClass().getSimpleName();
    }

    static String historyLoadErrorCode(Throwable error) {
        Throwable current = error;
        while (current != null) {
            if (current instanceof com.github.claudecodegui.session.SessionMessageOrchestrator.HistoryLoadNotCommittedException) {
                return RestoredHistoryLoadRequest.SUPERSEDED;
            }
            if (current instanceof java.util.concurrent.TimeoutException) {
                return "HISTORY_LOAD_PROVIDER_TIMEOUT";
            }
            if (current instanceof java.nio.file.AccessDeniedException || current instanceof SecurityException) {
                return "HISTORY_LOAD_PERMISSION_DENIED";
            }
            if (current instanceof java.nio.file.NoSuchFileException) {
                return "HISTORY_LOAD_NOT_FOUND";
            }
            if (current instanceof com.google.gson.JsonParseException) {
                return "HISTORY_LOAD_INVALID_DATA";
            }
            if (current instanceof java.io.IOException) {
                String ioMessage = current.getMessage();
                if (ioMessage != null && ioMessage.toLowerCase(java.util.Locale.ROOT).contains("not found")) {
                    return "HISTORY_LOAD_NOT_FOUND";
                }
                return "HISTORY_LOAD_IO_ERROR";
            }
            String detail = current.getMessage();
            if (detail != null) {
                String normalized = detail.toLowerCase(java.util.Locale.ROOT);
                if (normalized.contains("timed out") || normalized.contains("timeout")) {
                    return "HISTORY_LOAD_PROVIDER_TIMEOUT";
                }
            }
            current = current.getCause();
        }
        return "HISTORY_LOAD_PROVIDER_ERROR";
    }

    private static boolean isNonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }
}
