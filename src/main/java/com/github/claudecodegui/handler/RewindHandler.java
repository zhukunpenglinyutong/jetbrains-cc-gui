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
                        if (success) {
                            LOG.info("[RewindHandler] Rewind successful");
                            ApplicationManager.getApplication().invokeLater(() -> {
                                callJavaScript("addToast", escapeJs("Files restored successfully"), escapeJs("success"));
                            });
                        } else {
                            String error = result.has("error") ? result.get("error").getAsString() : "Unknown error";
                            LOG.warn("[RewindHandler] Rewind failed: " + error);
                            showError("Failed to restore files: " + error);
                        }
                    })
                    .exceptionally(ex -> {
                        LOG.error("[RewindHandler] Rewind exception: " + ex.getMessage(), ex);
                        showError("Rewind operation failed: " + ex.getMessage());
                        return null;
                    });

            } catch (Exception e) {
                LOG.error("[RewindHandler] Failed to parse rewind request: " + e.getMessage(), e);
                showError("Invalid rewind request");
            }
        });
    }

    /**
     * Show an error toast in the frontend.
     */
    private void showError(String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("addToast", escapeJs(message), escapeJs("error"));
        });
    }
}
