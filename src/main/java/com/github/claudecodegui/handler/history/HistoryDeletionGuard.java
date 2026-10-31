package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.Collection;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;

/**
 * Decides whether history deletion may touch a session, and reports the outcome.
 *
 * <p>Codex threads keep a persistent native writer. Deletion must never remove
 * rollouts under a live writer, and a refusal must reach the webview so it does
 * not leave the session as if it had been deleted.</p>
 */
final class HistoryDeletionGuard {

    static final String SESSION_RUNNING = "SESSION_RUNNING";
    static final String SELECTED_DATA_CHANGED = "SELECTED_DATA_CHANGED";
    static final String DELETE_FAILED = "DELETE_FAILED";

    private static final Gson GSON = new Gson();
    /** Text of codex-appserver-service#assertIdleForRelease, the native refusal for pending work. */
    private static final String NATIVE_BUSY_REFUSAL = "pending work";
    /** Node bounds the release itself; this ceiling keeps a deletion from waiting forever. */
    private static final long RELEASE_TIMEOUT_MILLIS = 30_000;

    private HistoryDeletionGuard() {
    }

    /**
     * Stop or release the active session before its files are deleted.
     * Non-Codex sessions are interrupted; a Codex owner is only released while idle.
     */
    static CompletableFuture<Void> quiesce(
            ClaudeSession session,
            Collection<String> sessionIds,
            String currentProvider,
            CodexSDKBridge bridge
    ) {
        return quiesce(session, sessionIds, currentProvider, bridge, RELEASE_TIMEOUT_MILLIS);
    }

    static CompletableFuture<Void> quiesce(
            ClaudeSession session,
            Collection<String> sessionIds,
            String currentProvider,
            CodexSDKBridge bridge,
            long releaseTimeoutMillis
    ) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return CompletableFuture.completedFuture(null);
        }
        String activeSessionId = session == null || !Objects.equals(session.getProvider(), currentProvider)
                ? null : session.getSessionId();
        if ("codex".equals(currentProvider)) {
            for (String target : sessionIds) {
                if (CodexHistoryActivity.isOwnedElsewhere(target, activeSessionId, bridge)) {
                    return refused(SESSION_RUNNING);
                }
            }
        }
        if (activeSessionId == null || !sessionIds.contains(activeSessionId)) {
            return CompletableFuture.completedFuture(null);
        }
        if (!"codex".equals(currentProvider)) {
            return session.interrupt();
        }
        if (session.isBusy() || session.getState().getExecutionState().hasLiveTurn()) {
            return refused(SESSION_RUNNING);
        }
        if (bridge == null) {
            return CompletableFuture.completedFuture(null);
        }
        String channelId = session.getChannelId();
        String cwd = session.getCwd();
        // Time out a copy: completing the bridge's own future early would skip its channel cleanup.
        return bridge.releaseIdleCodexThread(channelId, cwd, activeSessionId)
                .copy()
                .orTimeout(releaseTimeoutMillis, TimeUnit.MILLISECONDS)
                .handle((result, error) -> {
                    // The bridge refuses an owner with pending work; never fall back to interrupting it.
                    if (error != null || result == null || result.has("error")) {
                        String code = isBusyRefusal(error, result) ? SESSION_RUNNING : DELETE_FAILED;
                        throw new CompletionException(new IOException(code));
                    }
                    if (!Objects.equals(activeSessionId, session.getSessionId())
                            || !Objects.equals(currentProvider, session.getProvider())
                            || !Objects.equals(channelId, session.getChannelId())) {
                        throw new CompletionException(new IOException(SELECTED_DATA_CHANGED));
                    }
                    return null;
                });
    }

    /**
     * Hold Codex writer leases for the duration of the file deletion.
     *
     * @return a callback releasing the leases; a no-op outside Codex
     * @throws CompletionException with {@link #SESSION_RUNNING} when a writer appeared meanwhile
     */
    static Runnable reserve(Collection<String> sessionIds, String currentProvider, CodexSDKBridge bridge) {
        if (!"codex".equals(currentProvider) || bridge == null) {
            return () -> { };
        }
        Runnable release = bridge.reserveCodexThreadsForDeletion(sessionIds);
        if (release == null) {
            throw new CompletionException(new IOException(SESSION_RUNNING));
        }
        return release;
    }

    /**
     * Refuse when the active Codex session started a turn after its idle release.
     * That send can claim the writer before the release forgets the channel, which
     * drops its lease, so the deletion reservation alone would not see it.
     */
    static void assertStillIdle(ClaudeSession session, Collection<String> sessionIds, String currentProvider) {
        if (!"codex".equals(currentProvider) || session == null || !"codex".equals(session.getProvider())) {
            return;
        }
        String activeSessionId = session.getSessionId();
        if (activeSessionId != null && sessionIds.contains(activeSessionId)
                && (session.isBusy() || session.getState().getExecutionState().hasLiveTurn())) {
            throw new CompletionException(new IOException(SESSION_RUNNING));
        }
    }

    /** Map a deletion failure to the code the webview translates. */
    static String errorCode(Throwable error) {
        Throwable cause = error;
        while (cause instanceof CompletionException && cause.getCause() != null) {
            cause = cause.getCause();
        }
        String message = cause == null ? null : cause.getMessage();
        if (SESSION_RUNNING.equals(message) || SELECTED_DATA_CHANGED.equals(message)) {
            return message;
        }
        return DELETE_FAILED;
    }

    /**
     * Build the webview callback that reports one deletion request.
     *
     * @param deletedSessionIds requested ids whose files are gone
     * @param errorCode null when every requested session was deleted
     */
    static String resultScript(HistoryDeleteRequest request, Collection<String> deletedSessionIds, String errorCode) {
        JsonObject result = new JsonObject();
        if (request.requestId() != null) {
            result.addProperty("requestId", request.requestId());
        }
        result.addProperty("provider", request.provider());
        result.add("sessionIds", toJsonArray(request.sessionIds()));
        result.add("deletedSessionIds", toJsonArray(deletedSessionIds));
        result.addProperty("success", errorCode == null);
        if (errorCode != null) {
            result.addProperty("errorCode", errorCode);
        }
        return "if (window.onHistoryDeleteResult) { window.onHistoryDeleteResult('"
                + JsUtils.escapeJs(GSON.toJson(result)) + "'); }";
    }

    private static JsonArray toJsonArray(Collection<String> values) {
        JsonArray array = new JsonArray();
        values.forEach(array::add);
        return array;
    }

    private static boolean isBusyRefusal(Throwable error, JsonObject result) {
        Throwable cause = error;
        while (cause instanceof CompletionException && cause.getCause() != null) {
            cause = cause.getCause();
        }
        String message = cause != null ? cause.getMessage()
                : result != null && result.has("error") && result.get("error").isJsonPrimitive()
                ? result.get("error").getAsString() : null;
        return message != null && (message.contains(NATIVE_BUSY_REFUSAL) || message.contains(SESSION_RUNNING));
    }

    private static CompletableFuture<Void> refused(String code) {
        return CompletableFuture.failedFuture(new IOException(code));
    }
}
