package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.CompletableFuture;

/**
 * Rewind handler for restoring files to a previous state.
 * Handles the rewind_files event from the frontend.
 */
public class RewindHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(RewindHandler.class);
    private static final Gson gson = new Gson();

    private static final String[] SUPPORTED_TYPES = {
        "rewind_files"
    };

    public RewindHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("rewind_files".equals(type)) {
            LOG.info("[RewindHandler] Handling: rewind_files, content: " + content);
            handleRewindFiles(content);
            return true;
        }
        return false;
    }

    /**
     * Handle the rewind_files request.
     * Parses the request and calls the SDK to rewind files.
     */
    private void handleRewindFiles(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                // Parse request
                JsonObject request = gson.fromJson(content, JsonObject.class);
                String sessionId = request.has("sessionId") ? request.get("sessionId").getAsString() : null;
                String userMessageId = request.has("userMessageId") ? request.get("userMessageId").getAsString() : null;

                if (sessionId == null || sessionId.isEmpty()) {
                    LOG.warn("[RewindHandler] Missing sessionId");
                    showError("Session ID is required for rewind operation");
                    return;
                }

                if (userMessageId == null || userMessageId.isEmpty()) {
                    LOG.warn("[RewindHandler] Missing userMessageId");
                    showError("User message ID is required for rewind operation");
                    return;
                }

                LOG.info("[RewindHandler] Rewinding files - Session: " + sessionId + ", Message: " + userMessageId);

                String cwd = null;
                if (context.getSession() != null) {
                    cwd = context.getSession().getCwd();
                }
                if ((cwd == null || cwd.isEmpty()) && context.getProject() != null) {
                    cwd = context.getProject().getBasePath();
                }

                // Call the SDK to rewind files
                context.getClaudeSDKBridge().rewindFiles(sessionId, userMessageId, cwd)
                    .thenAccept(result -> {
                        boolean success = result.has("success") && result.get("success").getAsBoolean();
                        LOG.info("[RewindHandler] Rewind result: success=" + success + ", result=" + result);

                        // Build the result JSON for the frontend callback
                        JsonObject callbackResult = new JsonObject();
                        callbackResult.addProperty("success", success);

                        if (success) {
                            LOG.info("[RewindHandler] Rewind successful");
                            // Pass filesRestored if available (SDK may return it)
                            if (result.has("filesRestored")) {
                                callbackResult.addProperty("filesRestored", result.get("filesRestored").getAsInt());
                            }
                        } else {
                            String error = result.has("error") ? result.get("error").getAsString() : "Unknown error";
                            LOG.warn("[RewindHandler] Rewind failed: " + error);
                            callbackResult.addProperty("message", "Failed to restore files: " + error);
                        }

                        // Call the frontend callback to update UI state
                        String callbackJson = gson.toJson(callbackResult);
                        LOG.info("[RewindHandler] >>> Calling onRewindResult with: " + callbackJson);
                        ApplicationManager.getApplication().invokeLater(() -> {
                            LOG.info("[RewindHandler] >>> invokeLater executing, calling callJavaScript...");
                            callJavaScript("onRewindResult", escapeJs(callbackJson));
                            LOG.info("[RewindHandler] >>> callJavaScript completed");
                        });
                    })
                    .exceptionally(ex -> {
                        LOG.error("[RewindHandler] Rewind exception: " + ex.getMessage(), ex);

                        // Build error result for frontend callback
                        JsonObject errorResult = new JsonObject();
                        errorResult.addProperty("success", false);
                        errorResult.addProperty("message", "Rewind operation failed: " + ex.getMessage());

                        String errorJson = gson.toJson(errorResult);
                        LOG.info("[RewindHandler] >>> Calling onRewindResult (exception) with: " + errorJson);
                        ApplicationManager.getApplication().invokeLater(() -> {
                            LOG.info("[RewindHandler] >>> invokeLater (exception) executing...");
                            callJavaScript("onRewindResult", escapeJs(errorJson));
                            LOG.info("[RewindHandler] >>> callJavaScript (exception) completed");
                        });
                        return null;
                    });

            } catch (Exception e) {
                LOG.error("[RewindHandler] Failed to parse rewind request: " + e.getMessage(), e);
                showError("Invalid rewind request");
            }
        });
    }

    /**
     * Send error result to the frontend, which will update UI state and show error toast.
     */
    private void showError(String message) {
        JsonObject errorResult = new JsonObject();
        errorResult.addProperty("success", false);
        errorResult.addProperty("message", message);

        String errorJson = gson.toJson(errorResult);
        LOG.info("[RewindHandler] >>> showError calling onRewindResult with: " + errorJson);
        ApplicationManager.getApplication().invokeLater(() -> {
            LOG.info("[RewindHandler] >>> showError invokeLater executing...");
            callJavaScript("onRewindResult", escapeJs(errorJson));
            LOG.info("[RewindHandler] >>> showError callJavaScript completed");
        });
    }
}
