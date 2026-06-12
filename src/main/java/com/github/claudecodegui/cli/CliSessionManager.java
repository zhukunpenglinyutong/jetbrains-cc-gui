package com.github.claudecodegui.cli;

import com.github.claudecodegui.cli.claude.ClaudeCliSession;
import com.github.claudecodegui.cli.codex.CodexCliSession;
import com.github.claudecodegui.cli.common.CliConstants;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.ui.toolwindow.TabPerformanceLogger;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiFunction;
import java.util.function.Function;

/**
 * CLI 模式统一入口。每个 Tab 拥有独立的 ClaudeCliSession / CodexCliSession。
 * 完全不依赖 SDK / ai-bridge。
 */
public class CliSessionManager {

    private static final Logger LOG = Logger.getInstance(CliSessionManager.class);

    private final ConcurrentHashMap<String, ClaudeCliSession> claudeSessions = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, CodexCliSession> codexSessions = new ConcurrentHashMap<>();

    public CompletableFuture<SDKResult> send(CliSendRequest request, MessageCallback callback) {
        return switch (request.provider()) {
            case CliConstants.PROVIDER_CLAUDE -> sendClaude(request, callback);
            case CliConstants.PROVIDER_CODEX -> sendCodex(request, callback);
            default -> CompletableFuture.failedFuture(
                    new IllegalArgumentException("Unknown CLI provider: " + request.provider()));
        };
    }

    public void interrupt(String tabId, String provider) {
        switch (normalizeInterruptProvider(provider)) {
            case CliConstants.PROVIDER_CLAUDE -> {
                ClaudeCliSession s = claudeSessions.get(tabId);
                if (s != null) { s.interrupt(); }
            }
            case CliConstants.PROVIDER_CODEX -> {
                CodexCliSession s = codexSessions.get(tabId);
                if (s != null) { s.interrupt(); }
            }
            default -> {}
        }
    }

    public void disposeTab(String tabId) {
        long startNanos = System.nanoTime();
        ClaudeCliSession cs = claudeSessions.remove(tabId);
        if (cs != null) {
            long claudeDisposeStartNanos = System.nanoTime();
            cs.dispose();
            LOG.info("[TabPerf] Claude CLI session dispose returned in "
                    + TabPerformanceLogger.elapsedMillis(claudeDisposeStartNanos) + "ms: tab=" + tabId);
        }
        CodexCliSession xs = codexSessions.remove(tabId);
        if (xs != null) {
            long codexDisposeStartNanos = System.nanoTime();
            xs.dispose();
            LOG.info("[TabPerf] Codex CLI session dispose returned in "
                    + TabPerformanceLogger.elapsedMillis(codexDisposeStartNanos) + "ms: tab=" + tabId);
        }
        LOG.info("[TabPerf] CliSessionManager.disposeTab returned in "
                + TabPerformanceLogger.elapsedMillis(startNanos) + "ms: tab=" + tabId);
    }

    // ── private ──────────────────────────────────────────────────────────────

    private CompletableFuture<SDKResult> sendClaude(CliSendRequest request, MessageCallback callback) {
        return sendToSession(request, callback, claudeSessions, ClaudeCliSession::new,
                (session, cb) -> session.send(request, cb));
    }

    private CompletableFuture<SDKResult> sendCodex(CliSendRequest request, MessageCallback callback) {
        return sendToSession(request, callback, codexSessions, CodexCliSession::new,
                (session, cb) -> session.send(request, cb));
    }

    private <S> CompletableFuture<SDKResult> sendToSession(
            CliSendRequest request,
            MessageCallback callback,
            ConcurrentHashMap<String, S> sessions,
            Function<String, S> sessionFactory,
            BiFunction<S, CliSessionCallback, CompletableFuture<Void>> sender
    ) {
        S session = sessions.computeIfAbsent(request.tabId(), sessionFactory);
        return sender.apply(session, adapt(callback))
                .thenApply(v -> SDKResult.success(null))
                .exceptionally(ex -> {
                    SDKResult r = SDKResult.error(ex.getMessage());
                    callback.onError(ex.getMessage());
                    callback.onComplete(r);
                    return r;
                });
    }

    static String normalizeInterruptProvider(String provider) {
        return switch (provider) {
            case CliConstants.PROVIDER_CODEX -> CliConstants.PROVIDER_CODEX;
            default -> CliConstants.PROVIDER_CLAUDE;
        };
    }

    /** 将 CliSessionCallback 适配为 MessageCallback，统一回调格式。 */
    private static CliSessionCallback adapt(MessageCallback callback) {
        return new CliSessionCallback() {
            @Override
            public void onMessage(String type, String content) {
                callback.onMessage(type, content);
            }
            @Override
            public void onError(String error) {
                callback.onError(error);
            }
            @Override
            public void onComplete(boolean success, String finalResult, String error) {
                SDKResult result = success ? SDKResult.success(finalResult) : SDKResult.error(error);
                result.success = success;
                result.finalResult = finalResult;
                result.error = error;
                callback.onComplete(result);
            }

            @Override
            public void onInterrupted(String finalResult, String message) {
                SDKResult result = SDKResult.error(message);
                result.success = false;
                result.interrupted = true;
                result.finalResult = finalResult;
                result.error = message;
                callback.onComplete(result);
            }
        };
    }
}
