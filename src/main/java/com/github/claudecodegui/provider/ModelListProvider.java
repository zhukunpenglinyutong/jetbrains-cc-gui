package com.github.claudecodegui.provider;

import com.github.claudecodegui.model.ModelInfo;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.ConfigPathManager;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Provides model lists for model selection dialogs.
 * Synchronized with frontend model definitions in webview/src/components/ChatInputBox/types.ts
 */
public class ModelListProvider {
    private static final Logger LOG = Logger.getInstance(ModelListProvider.class);

    // Claude models (synchronized with CLAUDE_MODELS in types.ts)
    private static final ModelInfo[] CLAUDE_MODELS = {
        new ModelInfo("claude-sonnet-4-6", "Sonnet 4.6", "200K"),
        new ModelInfo("claude-opus-4-7", "Opus 4.7", "200K"),
        new ModelInfo("claude-opus-4-6", "Opus 4.6", "200K"),
        new ModelInfo("claude-haiku-4-5", "Haiku 4.5", "200K"),
        new ModelInfo("claude-sonnet-4-6[1m]", "Sonnet 4.6", "1M"),
        new ModelInfo("claude-opus-4-7[1m]", "Opus 4.7", "1M"),
        new ModelInfo("claude-opus-4-6[1m]", "Opus 4.6", "1M"),
    };

    // Codex/GPT models (synchronized with CODEX_MODELS in types.ts)
    private static final ModelInfo[] CODEX_MODELS = {
        new ModelInfo("gpt-5.5", "GPT-5.5", "Latest frontier"),
        new ModelInfo("gpt-5.4", "GPT-5.4", "1M"),
        new ModelInfo("gpt-5.2-codex", "GPT-5.2-Codex", "258K"),
        new ModelInfo("gpt-5.1-codex-max", "GPT-5.1-Codex-Max", "258K"),
        new ModelInfo("gpt-5.4-mini", "GPT-5.4-Mini", "128K"),
        new ModelInfo("gpt-5.3-codex", "GPT-5.3-Codex", "258K"),
        new ModelInfo("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", "258K"),
        new ModelInfo("gpt-5.2", "GPT-5.2", "258K"),
        new ModelInfo("gpt-5.1-codex-mini", "GPT-5.1-Codex-Mini", "128K"),
        new ModelInfo("o3", "O3", "200K"),
        new ModelInfo("o3-mini", "O3 Mini", "200K"),
        new ModelInfo("o1", "O1", "200K"),
        new ModelInfo("o1-mini", "O1 Mini", "128K"),
        new ModelInfo("o1-preview", "O1 Preview", "128K"),
    };

    private final CodemossSettingsService settingsService;
    private final ConfigPathManager pathManager;

    public ModelListProvider() {
        this.settingsService = new CodemossSettingsService();
        this.pathManager = new ConfigPathManager();
    }

    /**
     * Get all available models (Claude + Codex + custom).
     */
    public List<ModelInfo> getAllModels() {
        List<ModelInfo> models = new ArrayList<>();

        // Add Claude models
        for (ModelInfo model : CLAUDE_MODELS) {
            models.add(model);
        }

        // Add Codex models
        for (ModelInfo model : CODEX_MODELS) {
            models.add(model);
        }

        // Add custom models from providers
        models.addAll(getCustomModelsFromProviders());

        // Add plugin-level custom models (from custom-models.json)
        models.addAll(getPluginLevelCustomModels());

        return models;
    }

    /**
     * Get Claude models only.
     */
    public List<ModelInfo> getClaudeModels() {
        List<ModelInfo> models = new ArrayList<>();
        for (ModelInfo model : CLAUDE_MODELS) {
            models.add(model);
        }
        return models;
    }

    /**
     * Get Codex models only.
     */
    public List<ModelInfo> getCodexModels() {
        List<ModelInfo> models = new ArrayList<>();
        for (ModelInfo model : CODEX_MODELS) {
            models.add(model);
        }
        return models;
    }

    /**
     * Get custom models from active provider configurations.
     * Reads customModels field from both Claude and Codex providers.
     */
    private List<ModelInfo> getCustomModelsFromProviders() {
        List<ModelInfo> customModels = new ArrayList<>();

        try {
            // Get custom models from active Claude provider
            JsonObject activeClaudeProvider = settingsService.getActiveClaudeProvider();
            if (activeClaudeProvider != null && activeClaudeProvider.has("customModels")) {
                JsonArray claudeCustomModels = activeClaudeProvider.getAsJsonArray("customModels");
                for (int i = 0; i < claudeCustomModels.size(); i++) {
                    JsonObject modelJson = claudeCustomModels.get(i).getAsJsonObject();
                    if (modelJson.has("id") && modelJson.has("label")) {
                        String id = modelJson.get("id").getAsString();
                        String label = modelJson.get("label").getAsString();
                        String description = modelJson.has("description") ?
                            modelJson.get("description").getAsString() : "";
                        customModels.add(new ModelInfo(id, label, description));
                    }
                }
            }

            // Get custom models from active Codex provider
            try {
                JsonObject activeCodexProvider = settingsService.getActiveCodexProvider();
                if (activeCodexProvider != null && activeCodexProvider.has("customModels")) {
                    JsonArray codexCustomModels = activeCodexProvider.getAsJsonArray("customModels");
                    for (int i = 0; i < codexCustomModels.size(); i++) {
                        JsonObject modelJson = codexCustomModels.get(i).getAsJsonObject();
                        if (modelJson.has("id") && modelJson.has("label")) {
                            String id = modelJson.get("id").getAsString();
                            String label = modelJson.get("label").getAsString();
                            String description = modelJson.has("description") ?
                                modelJson.get("description").getAsString() : "";
                            customModels.add(new ModelInfo(id, label, description));
                        }
                    }
                }
            } catch (java.io.IOException e) {
                LOG.debug("[ModelListProvider] Failed to read active Codex provider: " + e.getMessage());
            }
        } catch (Exception e) {
            LOG.warn("[ModelListProvider] Failed to read custom models from providers: " + e.getMessage());
        }

        return customModels;
    }

    /**
     * Get plugin-level custom models from custom-models.json.
     * These are custom models added by the user that are not provider-specific.
     */
    private List<ModelInfo> getPluginLevelCustomModels() {
        List<ModelInfo> customModels = new ArrayList<>();

        try {
            Path customModelsPath = pathManager.getCustomModelsFilePath();
            if (!Files.exists(customModelsPath)) {
                return customModels;
            }

            String content = Files.readString(customModelsPath);
            if (content == null || content.trim().isEmpty()) {
                return customModels;
            }

            JsonObject root = JsonParser.parseString(content).getAsJsonObject();

            // Read Claude custom models
            if (root.has("claude")) {
                JsonArray claudeModels = root.getAsJsonArray("claude");
                for (int i = 0; i < claudeModels.size(); i++) {
                    JsonObject modelJson = claudeModels.get(i).getAsJsonObject();
                    if (modelJson.has("id") && modelJson.has("label")) {
                        String id = modelJson.get("id").getAsString();
                        String label = modelJson.get("label").getAsString();
                        String description = modelJson.has("description") ?
                            modelJson.get("description").getAsString() : "";
                        customModels.add(new ModelInfo(id, label, description));
                    }
                }
            }

            // Read Codex custom models
            if (root.has("codex")) {
                JsonArray codexModels = root.getAsJsonArray("codex");
                for (int i = 0; i < codexModels.size(); i++) {
                    JsonObject modelJson = codexModels.get(i).getAsJsonObject();
                    if (modelJson.has("id") && modelJson.has("label")) {
                        String id = modelJson.get("id").getAsString();
                        String label = modelJson.get("label").getAsString();
                        String description = modelJson.has("description") ?
                            modelJson.get("description").getAsString() : "";
                        customModels.add(new ModelInfo(id, label, description));
                    }
                }
            }
        } catch (IOException e) {
            LOG.debug("[ModelListProvider] Failed to read plugin-level custom models: " + e.getMessage());
        } catch (Exception e) {
            LOG.warn("[ModelListProvider] Failed to parse plugin-level custom models: " + e.getMessage());
        }

        return customModels;
    }

    /**
     * Get the default model ID.
     */
    public String getDefaultModelId() {
        return "claude-sonnet-4-6";
    }

    /**
     * Find a model by ID.
     */
    public ModelInfo findModelById(String modelId) {
        for (ModelInfo model : getAllModels()) {
            if (model.getId().equals(modelId)) {
                return model;
            }
        }
        return null;
    }
}
