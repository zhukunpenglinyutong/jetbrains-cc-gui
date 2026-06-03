package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.CompletableFuture;

/**
 * Handles window-level events from the frontend:
 * heartbeat, tab status changes, session lifecycle signals.
 */
public class WindowEventHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(WindowEventHandler.class);
    private static final String[] SUPPORTED_TYPES = {
        "heartbeat", "tab_loading_changed", "tab_status_changed",
        "create_new_session", "frontend_ready", "refresh_slash_commands",
        "recover_context_window"
    };

    /**
     * Callback interface for window-level operations.
     */
    public interface Callback {
        void onHeartbeat(String content);
        void onTabLoadingChanged(boolean loading);
        void onTabStatusChanged(String status);
        void onCreateNewSession();
        void onFrontendReady();
        void onRefreshSlashCommands();
    }

    private final Callback callback;

    public WindowEventHandler(HandlerContext context, Callback callback) {
        super(context);
        this.callback = callback;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "heartbeat":
                callback.onHeartbeat(content);
                return true;
            case "tab_loading_changed":
                handleTabLoadingChanged(content);
                return true;
            case "tab_status_changed":
                handleTabStatusChanged(content);
                return true;
            case "create_new_session":
                callback.onCreateNewSession();
                return true;
            case "frontend_ready":
                callback.onFrontendReady();
                return true;
            case "refresh_slash_commands":
                callback.onRefreshSlashCommands();
                return true;
            case "recover_context_window":
                handleContextWindowRecovery(content);
                return true;
            default:
                return false;
        }
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    private void handleTabLoadingChanged(String content) {
        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            boolean loading = json.has("loading") && json.get("loading").getAsBoolean();
            callback.onTabLoadingChanged(loading);
        } catch (Exception e) {
            LOG.warn("[TabLoading] Failed to parse loading state: " + e.getMessage());
        }
    }

    private void handleTabStatusChanged(String content) {
        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            String statusStr = json.has("status") ? json.get("status").getAsString() : "idle";
            callback.onTabStatusChanged(statusStr);
        } catch (Exception e) {
            LOG.warn("[TabStatus] Failed to parse tab status: " + e.getMessage());
        }
    }

    private void handleContextWindowRecovery(String content) {
        ClaudeSession session = context.getSession();
        if (session == null) {
            sendContextRecoveryError("No active session is available");
            return;
        }
        if (!"opencode".equals(session.getProvider())) {
            sendContextRecoveryError("Context-window recovery is only available for opencode sessions");
            return;
        }
        if (context.getOpenCodeSDKBridge() == null) {
            sendContextRecoveryError("opencode bridge is not available");
            return;
        }

        String sessionId = session.getSessionId();
        String cwd = session.getCwd();
        if ((cwd == null || cwd.trim().isEmpty()) && context.getProject() != null) {
            cwd = context.getProject().getBasePath();
        }
        String failedPrompt = parseFailedPrompt(content);
        final String recoveryCwd = cwd;

        CompletableFuture.runAsync(() -> {
            JsonObject result = context.getOpenCodeSDKBridge()
                    .buildRecoveryPrompt(sessionId, recoveryCwd, failedPrompt);
            context.callJavaScript("onContextRecoveryPrompt", context.escapeJs(result.toString()));
        }).exceptionally(error -> {
            sendContextRecoveryError(error.getMessage() != null ? error.getMessage() : "Failed to build recovery prompt");
            return null;
        });
    }

    private String parseFailedPrompt(String content) {
        if (content == null || content.trim().isEmpty()) {
            return "";
        }
        try {
            JsonObject json = new Gson().fromJson(content, JsonObject.class);
            if (json != null && json.has("failedPrompt") && !json.get("failedPrompt").isJsonNull()) {
                return json.get("failedPrompt").getAsString();
            }
        } catch (Exception e) {
            LOG.warn("[ContextRecovery] Failed to parse recovery payload: " + e.getMessage());
        }
        return "";
    }

    private void sendContextRecoveryError(String message) {
        JsonObject result = new JsonObject();
        result.addProperty("success", false);
        result.addProperty("error", message != null ? message : "Failed to build recovery prompt");
        context.callJavaScript("onContextRecoveryPrompt", context.escapeJs(result.toString()));
    }
}
