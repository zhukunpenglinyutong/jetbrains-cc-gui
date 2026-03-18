package com.github.claudecodegui.handler;

import com.github.claudecodegui.skill.SlashCommandRegistry;
import com.github.claudecodegui.util.EditorFileUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Handles model and provider selection, reasoning effort, and slash command refresh.
 */
public class ModelProviderHandler {

    private static final Logger LOG = Logger.getInstance(ModelProviderHandler.class);

    static final Map<String, Integer> MODEL_CONTEXT_LIMITS = new HashMap<>();
    static {
        // Claude models
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-6", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-6", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-haiku-4-5", 200_000);
        // Codex/OpenAI models
        MODEL_CONTEXT_LIMITS.put("gpt-5.4", 1_000_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.4-mini", 400_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.3-codex", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.2-codex", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1-codex-max", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1-codex-mini", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.2", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1-codex", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4o", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4o-mini", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4-turbo", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4", 8_192);
        MODEL_CONTEXT_LIMITS.put("o3", 200_000);
        MODEL_CONTEXT_LIMITS.put("o3-mini", 200_000);
        MODEL_CONTEXT_LIMITS.put("o1", 200_000);
        MODEL_CONTEXT_LIMITS.put("o1-mini", 128_000);
        MODEL_CONTEXT_LIMITS.put("o1-preview", 128_000);
    }

    private final HandlerContext context;
    private final UsagePushService usagePushService;
    private final Gson gson = new Gson();

    public ModelProviderHandler(HandlerContext context, UsagePushService usagePushService) {
        this.context = context;
        this.usagePushService = usagePushService;
    }

    /**
     * Handle set model request.
     * Sends a confirmation callback to the frontend after setting, ensuring frontend-backend state sync.
     *
     * Capacity calculation optimization: when the frontend selects a base model (e.g. claude-sonnet-4-6),
     * the actual model configuration is looked up from settings (e.g. ANTHROPIC_DEFAULT_SONNET_MODEL),
     * to support custom model names with capacity suffixes (e.g. claude-sonnet-4-6[1M]).
     */
    public void handleSetModel(String content) {
        try {
            String model = content;
            if (content != null && !content.isEmpty()) {
                try {
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("model")) {
                        model = json.get("model").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the model
                }
            }

            LOG.info("[ModelProviderHandler] Setting model to: " + model);

            // Try to get the actual configured model name from settings (supports capacity suffix)
            String actualModel = resolveActualModelName(model);
            String finalModelName;
            if (actualModel != null && !actualModel.equals(model)) {
                LOG.info("[ModelProviderHandler] Resolved to actual model: " + actualModel);
                context.setCurrentModel(actualModel);
                finalModelName = actualModel;
            } else {
                context.setCurrentModel(model);
                finalModelName = model;
            }

            if (context.getSession() != null) {
                context.getSession().setModel(finalModelName);
                LOG.info("[ModelProviderHandler] Updated session model to: " + finalModelName);
            }

            // Update status bar with basic model name
            com.github.claudecodegui.notifications.ClaudeNotifier.setModel(context.getProject(), model);

            // Calculate the context limit for the new model
            int newMaxTokens = getModelContextLimit(finalModelName);
            LOG.info("[ModelProviderHandler] Model context limit: " + newMaxTokens + " tokens for model: " + finalModelName);

            // Send confirmation callback to frontend, ensuring frontend-backend state sync
            final String confirmedModel = model;
            final String confirmedProvider = context.getCurrentProvider();
            ApplicationManager.getApplication().invokeLater(() -> {
                // Send model confirmation
                context.callJavaScript("window.onModelConfirmed", context.escapeJs(confirmedModel), context.escapeJs(confirmedProvider));

                // Recalculate and push usage update, ensuring maxTokens is updated for the new model
                usagePushService.pushUsageUpdateAfterModelChange(newMaxTokens);
            });
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to set model: " + e.getMessage(), e);
        }
    }

    /**
     * Handle set provider request.
     */
    public void handleSetProvider(String content) {
        try {
            String provider = content;
            if (content != null && !content.isEmpty()) {
                try {
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("provider")) {
                        provider = json.get("provider").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the provider
                }
            }

            LOG.info("[ModelProviderHandler] Setting provider to: " + provider);
            context.setCurrentProvider(provider);

            if (context.getSession() != null) {
                context.getSession().setProvider(provider);
            }

            // Refresh slash commands for the new provider
            refreshSlashCommandsForProvider(provider);

            usagePushService.refreshContextBar();
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to set provider: " + e.getMessage(), e);
        }
    }

    /**
     * Handle set reasoning effort request (Codex only).
     */
    public void handleSetReasoningEffort(String content) {
        try {
            String effort = content;
            if (content != null && !content.isEmpty()) {
                try {
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("reasoningEffort")) {
                        effort = json.get("reasoningEffort").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the effort
                }
            }

            LOG.info("[ModelProviderHandler] Setting reasoning effort to: " + effort);

            if (context.getSession() != null) {
                context.getSession().setReasoningEffort(effort);
            }
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to set reasoning effort: " + e.getMessage(), e);
        }
    }

    /**
     * Refreshes slash commands after provider switch using local registry.
     */
    private void refreshSlashCommandsForProvider(String provider) {
        String cwd = null;
        if (context.getSession() != null) {
            cwd = context.getSession().getCwd();
        }
        if (cwd == null) {
            cwd = context.getProject().getBasePath();
        }

        final String finalCwd = cwd;
        CompletableFuture.runAsync(() -> {
            String currentFilePath = EditorFileUtils.getCurrentEditorFilePath(context.getProject());
            var commands = SlashCommandRegistry.getCommands(provider, finalCwd, currentFilePath);
            String json = SlashCommandRegistry.toJson(commands);

            final String codexJson;
            if ("codex".equalsIgnoreCase(provider)) {
                var codexSkills = SlashCommandRegistry.getCodexSkills(finalCwd);
                codexJson = SlashCommandRegistry.toJson(codexSkills);
                LOG.info("[ModelProviderHandler] Codex skills refreshed: " + codexSkills.size() + " skills");
            } else {
                codexJson = null;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    context.callJavaScript("updateSlashCommands", context.escapeJs(json));

                    // Push Codex $ skills when switching to codex provider
                    if (codexJson != null) {
                        context.callJavaScript("window.updateDollarCommands", context.escapeJs(codexJson));
                    }
                } catch (Exception e) {
                    LOG.warn("[ModelProviderHandler] Failed to refresh slash commands: " + e.getMessage());
                }
            });
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[ModelProviderHandler] Failed to refresh slash commands asynchronously: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Resolve the actual model name used from settings.
     * Supports reading model names with capacity suffixes from ANTHROPIC_MODEL or ANTHROPIC_DEFAULT_*_MODEL.
     *
     * @param baseModel the base model ID selected by frontend (e.g. claude-sonnet-4-6, claude-haiku-4-5)
     * @return the actual model name configured in settings, or null if not configured
     */
    private String resolveActualModelName(String baseModel) {
        try {
            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            com.google.gson.JsonObject config = settingsService.readConfig();

            if (config == null || !config.has("activeProvider")) {
                return null;
            }

            String activeProviderId = config.get("activeProvider").getAsString();
            if (!"claude-code".equals(activeProviderId)) {
                return null;
            }

            if (!config.has("providers") || !config.get("providers").isJsonArray()) {
                return null;
            }

            com.google.gson.JsonArray providers = config.getAsJsonArray("providers");
            for (com.google.gson.JsonElement providerElement : providers) {
                if (!providerElement.isJsonObject()) continue;
                com.google.gson.JsonObject provider = providerElement.getAsJsonObject();

                if (!provider.has("id") || !"claude-code".equals(provider.get("id").getAsString())) {
                    continue;
                }

                if (!provider.has("settingsConfig") || !provider.get("settingsConfig").isJsonObject()) {
                    continue;
                }

                com.google.gson.JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");
                if (!settingsConfig.has("env") || !settingsConfig.get("env").isJsonObject()) {
                    continue;
                }

                com.google.gson.JsonObject env = settingsConfig.getAsJsonObject("env");

                // Look up corresponding environment variable by base model ID
                String actualModel = null;

                // First check ANTHROPIC_MODEL (main model configuration)
                if (env.has("ANTHROPIC_MODEL") && !env.get("ANTHROPIC_MODEL").isJsonNull()) {
                    String mainModel = env.get("ANTHROPIC_MODEL").getAsString();
                    if (mainModel != null && !mainModel.trim().isEmpty()) {
                        actualModel = mainModel.trim();
                    }
                }

                // If main model not configured, look up corresponding default model config by base model ID
                if (actualModel == null) {
                    if (baseModel.contains("sonnet") && env.has("ANTHROPIC_DEFAULT_SONNET_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").getAsString();
                    } else if (baseModel.contains("opus") && env.has("ANTHROPIC_DEFAULT_OPUS_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").getAsString();
                    } else if (baseModel.contains("haiku") && env.has("ANTHROPIC_DEFAULT_HAIKU_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").getAsString();
                    }
                }

                if (actualModel != null && !actualModel.trim().isEmpty()) {
                    return actualModel.trim();
                }
            }
        } catch (Exception e) {
            LOG.error("[ModelProviderHandler] Failed to resolve actual model name: " + e.getMessage());
        }

        return null;
    }

    /**
     * Get model context limit.
     * Supports parsing capacity suffix from model name, for example:
     * - claude-sonnet-4-6[1M] -> 1,000,000 tokens
     * - claude-opus-4-6[2M] -> 2,000,000 tokens
     * - claude-haiku-4-5[500k] -> 500,000 tokens
     * - claude-sonnet-4-6 [1.5M] -> 1,500,000 tokens (supports spaces and decimals)
     * - Case insensitive (1m and 1M both work)
     */
    public static int getModelContextLimit(String model) {
        if (model == null || model.isEmpty()) {
            return 200_000;
        }

        // Regex: matches trailing [number+unit], supports optional spaces, decimals, case insensitive
        java.util.regex.Pattern pattern = java.util.regex.Pattern.compile("\\s*\\[([0-9.]+)([kKmM])\\]\\s*$");
        java.util.regex.Matcher matcher = pattern.matcher(model);

        if (matcher.find()) {
            try {
                double value = Double.parseDouble(matcher.group(1));
                String unit = matcher.group(2).toLowerCase();

                if ("m".equals(unit)) {
                    return (int)(value * 1_000_000);
                } else if ("k".equals(unit)) {
                    return (int)(value * 1_000);
                }
            } catch (NumberFormatException e) {
                LOG.error("Failed to parse capacity from model name: " + model);
            }
        }

        // If no capacity suffix, try to look up from predefined mapping
        return MODEL_CONTEXT_LIMITS.getOrDefault(model, 200_000);
    }
}
