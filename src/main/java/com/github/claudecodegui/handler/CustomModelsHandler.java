package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.settings.ConfigPathManager;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Handles plugin-level custom model management.
 * Custom models are stored in ~/.codemoss/custom-models.json
 */
public class CustomModelsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CustomModelsHandler.class);
    private static final String[] SUPPORTED_TYPES = {
        "save_custom_models",
    };

    private final ConfigPathManager pathManager;

    public CustomModelsHandler(HandlerContext context) {
        super(context);
        this.pathManager = new ConfigPathManager();
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "save_custom_models":
                handleSaveCustomModels(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Save plugin-level custom models to custom-models.json.
     * Expected content format: {"claude": [...], "codex": [...]}
     */
    private void handleSaveCustomModels(String content) {
        try {
            JsonObject request = JsonParser.parseString(content).getAsJsonObject();

            // Read existing custom models
            JsonObject existingModels = new JsonObject();
            Path customModelsPath = pathManager.getCustomModelsFilePath();
            if (Files.exists(customModelsPath)) {
                String existingContent = Files.readString(customModelsPath);
                if (existingContent != null && !existingContent.trim().isEmpty()) {
                    existingModels = JsonParser.parseString(existingContent).getAsJsonObject();
                }
            }

            // Update with new models
            if (request.has("claude")) {
                existingModels.add("claude", request.getAsJsonArray("claude"));
            }
            if (request.has("codex")) {
                existingModels.add("codex", request.getAsJsonArray("codex"));
            }

            // Ensure directory exists
            Path configDir = pathManager.getConfigDir();
            if (!Files.exists(configDir)) {
                Files.createDirectories(configDir);
            }

            // Write to file
            Files.writeString(customModelsPath, existingModels.toString());
            LOG.info("[CustomModelsHandler] Saved custom models to: " + customModelsPath);

        } catch (IOException e) {
            LOG.error("[CustomModelsHandler] Failed to save custom models: " + e.getMessage(), e);
        } catch (Exception e) {
            LOG.error("[CustomModelsHandler] Failed to parse custom models request: " + e.getMessage(), e);
        }
    }
}
