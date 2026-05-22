package com.github.claudecodegui.cli.claude;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Claude CLI 模型映射工具（从用户 ~/.claude/settings.json 的 env 中读取自定义映射）。
 */
final class ClaudeCliModelResolver {

    private static final Logger LOG = Logger.getInstance(ClaudeCliModelResolver.class);

    private ClaudeCliModelResolver() {}

    static String resolve(String selectedModel) {
        try {
            JsonObject settings = new CodemossSettingsService().readClaudeSettings();
            if (settings == null || !settings.has("env") || !settings.get("env").isJsonObject()) {
                return selectedModel;
            }
            return resolveMapped(selectedModel, settings.getAsJsonObject("env"));
        } catch (Exception e) {
            LOG.warn("[ClaudeCliModelResolver] Failed: " + e.getMessage());
            return selectedModel;
        }
    }

    static String resolveMapped(String selectedModel, JsonObject env) {
        if (selectedModel == null || selectedModel.isBlank() || env == null) {
            return selectedModel;
        }

        String mainModel = readEnvValue(env, "ANTHROPIC_MODEL");
        if (mainModel != null) {
            return mainModel;
        }

        String normalized = selectedModel.replaceFirst("(?i)\\[1m\\]$", "").toLowerCase();
        if (!normalized.startsWith("claude-") && !normalized.startsWith("claude_")) {
            return selectedModel;
        }

        if (normalized.contains("opus")) {
            String m = readEnvValue(env, "ANTHROPIC_DEFAULT_OPUS_MODEL");
            return m != null ? m : selectedModel;
        }
        if (normalized.contains("haiku")) {
            String m = readEnvValue(env, "ANTHROPIC_SMALL_FAST_MODEL");
            if (m == null) {
                m = readEnvValue(env, "ANTHROPIC_DEFAULT_HAIKU_MODEL");
            }
            return m != null ? m : selectedModel;
        }
        if (normalized.contains("sonnet")) {
            String m = readEnvValue(env, "ANTHROPIC_DEFAULT_SONNET_MODEL");
            return m != null ? m : selectedModel;
        }
        return selectedModel;
    }

    private static String readEnvValue(JsonObject env, String key) {
        if (env == null || key == null || !env.has(key) || env.get(key).isJsonNull()) {
            return null;
        }
        String value = env.get(key).getAsString();
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
