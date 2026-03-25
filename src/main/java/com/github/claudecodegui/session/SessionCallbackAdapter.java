package com.github.claudecodegui.session;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.util.JsUtils;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.VirtualFileManager;

import java.util.List;
import java.util.function.BooleanSupplier;

/**
 * Named implementation of ClaudeSession.SessionCallback.
 * Replaces the large anonymous inner class in setupSessionCallbacks().
 * Delegates streaming events to StreamMessageCoalescer and UI events to JavaScript callbacks.
 */
public class SessionCallbackAdapter implements ClaudeSession.SessionCallback {

    private static final Logger LOG = Logger.getInstance(SessionCallbackAdapter.class);
    /** Throttle interval targeting ~30fps to balance responsiveness with UI thread load. */
    private static final int DELTA_THROTTLE_MS = 33;

    /**
     * Callback interface for JavaScript calls from session events.
     */
    public interface JsTarget {
        void callJavaScript(String functionName, String... args);
    }

    private final StreamMessageCoalescer streamCoalescer;
    private final JsTarget jsTarget;
    private final PermissionHandler permissionHandler;
    private final BooleanSupplier slashCommandsFetchedSupplier;
    private final Runnable streamEndCallback;
    private final StreamDeltaThrottler contentDeltaThrottler;
    private final StreamDeltaThrottler thinkingDeltaThrottler;
    private volatile boolean active = true;

    public SessionCallbackAdapter(
            StreamMessageCoalescer streamCoalescer,
            JsTarget jsTarget,
            PermissionHandler permissionHandler,
            BooleanSupplier slashCommandsFetchedSupplier,
            Runnable streamEndCallback
    ) {
        this.streamCoalescer = streamCoalescer;
        this.jsTarget = jsTarget;
        this.permissionHandler = permissionHandler;
        this.slashCommandsFetchedSupplier = slashCommandsFetchedSupplier;
        this.streamEndCallback = streamEndCallback;
        this.contentDeltaThrottler = new StreamDeltaThrottler(
                DELTA_THROTTLE_MS,
                delta -> {
                    if (!isInactive()) {
                        jsTarget.callJavaScript("onContentDelta", JsUtils.escapeJs(delta));
                    }
                }
        );
        this.thinkingDeltaThrottler = new StreamDeltaThrottler(
                DELTA_THROTTLE_MS,
                delta -> {
                    if (!isInactive()) {
                        jsTarget.callJavaScript("onThinkingDelta", JsUtils.escapeJs(delta));
                    }
                }
        );
    }

    public void deactivate() {
        active = false;
        contentDeltaThrottler.dispose();
        thinkingDeltaThrottler.dispose();
    }

    private boolean isInactive() {
        return !active;
    }

    @Override
    public void onMessageUpdate(List<ClaudeSession.Message> messages) {
        if (isInactive()) {
            return;
        }
        streamCoalescer.enqueue(messages);
    }

    @Override
    public void onStateChange(boolean busy, boolean loading, String error) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            // Do not send loading=false during streaming to avoid unexpected loading state resets.
            // State cleanup is handled uniformly by onStreamEnd.
            if (!loading && streamCoalescer.isStreamActive()) {
                LOG.debug("Suppressing showLoading(false) during active streaming");
                return;
            }

            jsTarget.callJavaScript("showLoading", String.valueOf(loading));
            // Show error in status bar only (not as toast) to avoid duplicate notifications.
            // The primary error display is the ERROR message in chat list (from onError path).
            if (error != null && !error.isEmpty()) {
                jsTarget.callJavaScript("updateStatus", JsUtils.escapeJs("Error: " + error));
            }
            if (!busy && !loading) {
                VirtualFileManager.getInstance().asyncRefresh(null);
            }
        });
    }

    @Override
    public void onStatusMessage(String message) {
        if (isInactive() || message == null || message.trim().isEmpty()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("updateStatus", JsUtils.escapeJs(message));
        });
    }

    @Override
    public void onSessionIdReceived(String sessionId) {
        if (isInactive()) {
            return;
        }
        LOG.info("Session ID: " + sessionId);
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("setSessionId", JsUtils.escapeJs(sessionId));
        });
    }

    @Override
    public void onPermissionRequested(PermissionRequest request) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            permissionHandler.showPermissionDialog(request);
        });
    }

    @Override
    public void onThinkingStatusChanged(boolean isThinking) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("showThinkingStatus", String.valueOf(isThinking));
            LOG.debug("Thinking status changed: " + isThinking);
        });
    }

    @Override
    public void onSlashCommandsReceived(List<String> slashCommands) {
        // No longer send old-format (string array) commands to the frontend.
        // Reasons:
        // 1. The full command list (with descriptions) was already fetched from getSlashCommands() during init.
        // 2. The commands received here are in old format (names only, no descriptions).
        // 3. Sending to frontend would overwrite the full command list, losing descriptions.
        int incomingCount = slashCommands != null ? slashCommands.size() : 0;
        LOG.debug("onSlashCommandsReceived called (old format, ignored). incoming=" + incomingCount);

        if (slashCommands != null && !slashCommands.isEmpty() && !slashCommandsFetchedSupplier.getAsBoolean()) {
            LOG.debug("Received " + incomingCount + " slash commands (old format), but keeping existing commands with descriptions");
        }
    }

    @Override
    public void onSummaryReceived(String summary) {
        LOG.debug("Summary received: " + (summary != null ? summary.substring(0, Math.min(50, summary.length())) : "null"));
    }

    @Override
    public void onNodeLog(String log) {
        LOG.debug("Node log: " + (log != null ? log.substring(0, Math.min(100, log.length())) : "null"));
    }

    // ===== Streaming callback methods =====

    @Override
    public void onStreamStart() {
        if (isInactive()) {
            return;
        }
        contentDeltaThrottler.reset();
        thinkingDeltaThrottler.reset();
        streamCoalescer.onStreamStart();
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("showLoading", "true");
            jsTarget.callJavaScript("onStreamStart");
            LOG.debug("Stream started - notified frontend with loading=true");
        });
    }

    @Override
    public void onStreamEnd() {
        if (isInactive()) {
            return;
        }
        contentDeltaThrottler.flushNow();
        thinkingDeltaThrottler.flushNow();
        streamCoalescer.onStreamEnd();
        streamCoalescer.flush(() -> {
            if (isInactive()) {
                return;
            }
            jsTarget.callJavaScript("onStreamEnd");
            jsTarget.callJavaScript("showLoading", "false");
            if (streamEndCallback != null) {
                streamEndCallback.run();
            }
            LOG.debug("Stream ended - flushed messages before notifying frontend");
        });
    }

    @Override
    public void onContentDelta(String delta) {
        if (isInactive()) {
            return;
        }
        contentDeltaThrottler.append(delta);
    }

    @Override
    public void onThinkingDelta(String delta) {
        if (isInactive()) {
            return;
        }
        thinkingDeltaThrottler.append(delta);
    }

    @Override
    public void onUsageUpdate(int usedTokens, int maxTokens) {
        if (isInactive()) {
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            if (isInactive()) {
                return;
            }
            double percentage = maxTokens > 0 ? (usedTokens * 100.0 / maxTokens) : 0.0;
            String json = String.format("{\"percentage\":%.2f,\"usedTokens\":%d,\"maxTokens\":%d}",
                    percentage, usedTokens, maxTokens);
            jsTarget.callJavaScript("onUsageUpdate", JsUtils.escapeJs(json));
            LOG.debug("Usage update sent to frontend: " + usedTokens + "/" + maxTokens);
        });
    }

    @Override
    public void onUserMessageUuidPatched(String content, String uuid) {
        if (isInactive()) {
            return;
        }
        jsTarget.callJavaScript("patchMessageUuid", JsUtils.escapeJs(content), JsUtils.escapeJs(uuid));
    }

    /**
     * Dispose internal resources. Call when the parent window is disposed.
     */
    public void dispose() {
        deactivate();
    }
}
