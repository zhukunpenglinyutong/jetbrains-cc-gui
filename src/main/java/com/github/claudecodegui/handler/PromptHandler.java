package com.github.claudecodegui.handler;

import com.github.claudecodegui.CodemossSettingsService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.List;

/**
 * Prompt library management message handler.
 */
public class PromptHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PromptHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_prompts",
        "add_prompt",
        "update_prompt",
        "delete_prompt"
    };

    private final CodemossSettingsService settingsService;
    private final Gson gson;

    public PromptHandler(HandlerContext context) {
        super(context);
        this.settingsService = context.getSettingsService();
        this.gson = new Gson();
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_prompts":
                handleGetPrompts();
                return true;
            case "add_prompt":
                handleAddPrompt(content);
                return true;
            case "update_prompt":
                handleUpdatePrompt(content);
                return true;
            case "delete_prompt":
                handleDeletePrompt(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Get all prompts.
     */
    private void handleGetPrompts() {
        try {
            List<JsonObject> prompts = settingsService.getPrompts();
            String promptsJson = gson.toJson(prompts);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updatePrompts", escapeJs(promptsJson));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to get prompts: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updatePrompts", escapeJs("[]"));
            });
        }
    }

    /**
     * Add a prompt.
     */
    private void handleAddPrompt(String content) {
        try {
            JsonObject prompt = gson.fromJson(content, JsonObject.class);
            settingsService.addPrompt(prompt);

            // Refresh the list
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetPrompts();
                callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"add\"}"));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to add prompt: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "add");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Update a prompt.
     */
    private void handleUpdatePrompt(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("id") || data.get("id").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'id' field in update request");
                sendErrorResult("update", "Missing 'id' field in request");
                return;
            }
            if (!data.has("updates") || data.get("updates").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'updates' field in update request");
                sendErrorResult("update", "Missing 'updates' field in request");
                return;
            }

            String id = data.get("id").getAsString();
            JsonObject updates = data.getAsJsonObject("updates");

            settingsService.updatePrompt(id, updates);

            // Refresh the list
            ApplicationManager.getApplication().invokeLater(() -> {
                handleGetPrompts();
                callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"update\"}"));
            });
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to update prompt: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "update");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Delete a prompt.
     */
    private void handleDeletePrompt(String content) {
        try {
            JsonObject data = gson.fromJson(content, JsonObject.class);

            if (!data.has("id") || data.get("id").isJsonNull()) {
                LOG.error("[PromptHandler] Missing 'id' field in delete request");
                sendErrorResult("delete", "Missing 'id' field in request");
                return;
            }

            String id = data.get("id").getAsString();

            boolean deleted = settingsService.deletePrompt(id);

            if (deleted) {
                // Refresh the list
                ApplicationManager.getApplication().invokeLater(() -> {
                    handleGetPrompts();
                    callJavaScript("window.promptOperationResult", escapeJs("{\"success\":true,\"operation\":\"delete\"}"));
                });
            } else {
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("success", false);
                errorResult.addProperty("operation", "delete");
                errorResult.addProperty("error", "Prompt not found");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
                });
            }
        } catch (Exception e) {
            LOG.error("[PromptHandler] Failed to delete prompt: " + e.getMessage(), e);
            JsonObject errorResult = new JsonObject();
            errorResult.addProperty("success", false);
            errorResult.addProperty("operation", "delete");
            errorResult.addProperty("error", e.getMessage());
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
            });
        }
    }

    /**
     * Send error result to frontend
     */
    private void sendErrorResult(String operation, String error) {
        JsonObject errorResult = new JsonObject();
        errorResult.addProperty("success", false);
        errorResult.addProperty("operation", operation);
        errorResult.addProperty("error", error);
        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("window.promptOperationResult", escapeJs(gson.toJson(errorResult)));
        });
    }
}
