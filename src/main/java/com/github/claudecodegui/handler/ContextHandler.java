package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Context usage handler.
 * Handles the get_context_usage event from the frontend to display context window usage breakdown.
 */
public class ContextHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ContextHandler.class);
    private final Gson gson = new Gson();

    private static final String[] SUPPORTED_TYPES = {"get_context_usage"};

    public ContextHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if ("get_context_usage".equals(type)) {
            LOG.info("[ContextHandler] Handling: get_context_usage");
            handleGetContextUsage(content);
            return true;
        }
        return false;
    }

    /**
     * Parse context usage request JSON into its component fields.
     * Returns a 4-element String array: [sessionId, cwd, model, requestId].
     * Any field not present in the JSON will be null.
     */
    static String[] parseContextUsageRequest(Gson gson, String content) {
        String sessionId = null;
        String cwd = null;
        String model = null;
        String requestId = null;

        try {
            if (content != null && !content.isEmpty()) {
                JsonObject request = gson.fromJson(content, JsonObject.class);
                if (request != null) {
                    sessionId = request.has("sessionId") && !request.get("sessionId").isJsonNull()
                            ? request.get("sessionId").getAsString() : null;
                    cwd = request.has("cwd") && !request.get("cwd").isJsonNull()
                            ? request.get("cwd").getAsString() : null;
                    model = request.has("model") && !request.get("model").isJsonNull()
                            ? request.get("model").getAsString() : null;
                    requestId = request.has("requestId") && !request.get("requestId").isJsonNull()
                            ? request.get("requestId").getAsString() : null;
                }
            }
        } catch (Exception e) {
            // Return partial results on parse failure
        }

        return new String[]{sessionId, cwd, model, requestId};
    }

    /**
     * Handle the get_context_usage request.
     * Calls the SDK's getContextUsage API via the daemon and returns the result to the frontend.
     */
    private void handleGetContextUsage(String content) {
        String[] parsed = parseContextUsageRequest(this.gson, content);
        String sessionId = parsed[0];
        String cwd = parsed[1];
        String model = parsed[2];
        String requestId = parsed[3];

        // Fall back to session state if not provided
        if (sessionId == null || sessionId.isEmpty()) {
            sessionId = this.context.getSession().getSessionId();
        }
        if (cwd == null || cwd.isEmpty()) {
            cwd = this.context.getSession().getCwd();
        }

        final String finalSessionId = sessionId;
        final String finalCwd = cwd;
        final String finalModel = model;
        final String finalRequestId = requestId;

        try {
            this.context.getClaudeSDKBridge()
                    .getContextUsage(finalSessionId, finalCwd, finalModel)
                    .thenAccept(result -> {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            try {
                                // If the result indicates failure, route through the error callback
                                // to ensure the dialog is closed properly on the frontend.
                                if (result.has("success") && !result.get("success").getAsBoolean()) {
                                    String errorMsg = "Failed to get context usage";
                                    if (result.has("error") && !result.get("error").isJsonNull()) {
                                        String sdkError = result.get("error").getAsString();
                                        if (!sdkError.isEmpty()) {
                                            errorMsg = sdkError;
                                        }
                                    }
                                    LOG.warn("[ContextHandler] Context usage query failed: " + errorMsg);
                                    callContextUsageError(errorMsg, finalRequestId);
                                    return;
                                }
                                JsonObject response = result.deepCopy();
                                if (finalRequestId != null && !finalRequestId.isEmpty()) {
                                    response.addProperty("requestId", finalRequestId);
                                }
                                String json = this.gson.toJson(response);
                                callJavaScript("showContextUsageDialog", escapeJs(json));
                            } catch (Exception e) {
                                LOG.error("[ContextHandler] Failed to send result to frontend", e);
                                callContextUsageError("Failed to process context usage data", finalRequestId);
                            }
                        });
                    })
                    .exceptionally(ex -> {
                        LOG.error("[ContextHandler] getContextUsage failed", ex);
                        ApplicationManager.getApplication().invokeLater(() -> {
                            callContextUsageError("Failed to get context usage: " + ex.getMessage(), finalRequestId);
                        });
                        return null;
                    });
        } catch (Exception e) {
            LOG.error("[ContextHandler] Unexpected error", e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callContextUsageError("Unexpected error: " + e.getMessage(), finalRequestId);
            });
        }
    }

    private void callContextUsageError(String message, String requestId) {
        if (requestId != null && !requestId.isEmpty()) {
            callJavaScript("onContextUsageError", escapeJs(message), escapeJs(requestId));
            return;
        }
        callJavaScript("onContextUsageError", escapeJs(message));
    }
}
