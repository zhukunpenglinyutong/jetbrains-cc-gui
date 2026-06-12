package com.github.claudecodegui.cli.claude;

import com.github.claudecodegui.cli.common.CliConstants;
import com.github.claudecodegui.cli.common.CliSettings;
import com.google.gson.JsonObject;

import java.util.Map;
import java.util.regex.Pattern;

/**
 * Claude CLI 模型映射工具（从用户 ~/.claude/settings.json 的 env 中读取自定义映射）。
 */
final class ClaudeCliModelResolver {

    private static final Pattern ONE_M_SUFFIX = Pattern.compile("(?i)\\[1m\\]$");
    private static final String SUFFIX_1M = "[1m]";

    /** 模型家族枚举，用于统一 resolveMapped 和 readCapabilityOverride 中的分派逻辑。 */
    private enum ModelFamily { OPUS, HAIKU, SONNET, OTHER }

    private static ModelFamily detectFamily(String normalizedModel) {
        if (normalizedModel.contains("opus"))  return ModelFamily.OPUS;
        if (normalizedModel.contains("haiku")) return ModelFamily.HAIKU;
        if (normalizedModel.contains("sonnet")) return ModelFamily.SONNET;
        return ModelFamily.OTHER;
    }

    private ClaudeCliModelResolver() {}

    record Capabilities(
            boolean supportsEffort,
            boolean supportsPartialMessages,
            boolean supportsMcp,
            boolean supportsAddDir
    ) {
    }

    record ResolvedModel(String model, Capabilities capabilities) {
    }

    static ResolvedModel resolveProfile(String selectedModel) {
        return resolveProfile(selectedModel, toJsonObject(CliSettings.readClaudeCliEnvironment()));
    }

    static ResolvedModel resolveProfile(String selectedModel, JsonObject env) {
        String resolvedModel = resolveMapped(selectedModel, env);
        return new ResolvedModel(resolvedModel, resolveCapabilities(selectedModel, resolvedModel, env));
    }

    static String resolveMapped(String selectedModel, JsonObject env) {
        if (selectedModel == null || selectedModel.isBlank() || env == null) {
            return selectedModel;
        }

        String mainModel = readEnvValue(env, CliConstants.ENV_ANTHROPIC_MODEL);
        if (mainModel != null) {
            return mainModel;
        }

        // Check if original model has [1m] suffix (to preserve it after mapping)
        boolean has1mSuffix = ONE_M_SUFFIX.matcher(selectedModel).find();

        String normalized = ONE_M_SUFFIX.matcher(selectedModel).replaceFirst("").toLowerCase();
        if (!normalized.startsWith(CliConstants.MODEL_PREFIX) && !normalized.startsWith(CliConstants.MODEL_PREFIX_ALT)) {
            return selectedModel;
        }

        String mapped = switch (detectFamily(normalized)) {
            case OPUS   -> readEnvValue(env, CliConstants.ENV_ANTHROPIC_DEFAULT_OPUS_MODEL);
            case HAIKU  -> firstNonBlank(
                               readEnvValue(env, CliConstants.ENV_ANTHROPIC_SMALL_FAST_MODEL),
                               readEnvValue(env, CliConstants.ENV_ANTHROPIC_DEFAULT_HAIKU_MODEL));
            case SONNET -> readEnvValue(env, CliConstants.ENV_ANTHROPIC_DEFAULT_SONNET_MODEL);
            case OTHER  -> null;
        };

        if (mapped != null) {
            // Preserve [1m] suffix from original model if the mapped model doesn't already have it
            if (has1mSuffix && !ONE_M_SUFFIX.matcher(mapped).find()) {
                return mapped + SUFFIX_1M;
            }
            return mapped;
        }
        return selectedModel;
    }

    private static Capabilities resolveCapabilities(String selectedModel, String resolvedModel, JsonObject env) {
        boolean canonicalClaude = isCanonicalClaudeModel(resolvedModel);
        boolean supportsEffort = canonicalClaude;
        boolean supportsPartialMessages = true;
        boolean supportsMcp = true;
        boolean supportsAddDir = true;

        String override = readCapabilityOverride(selectedModel, resolvedModel, env);
        if (override != null) {
            supportsEffort = containsCapability(override, "effort")
                    || containsCapability(override, "reasoning_effort")
                    || containsCapability(override, "thinking");
            if (containsCapability(override, "no-effort")
                    || containsCapability(override, "no_reasoning_effort")
                    || containsCapability(override, "none")) {
                supportsEffort = false;
            }
            if (containsCapability(override, "no-mcp")) {
                supportsMcp = false;
            }
            if (containsCapability(override, "no-add-dir")
                    || containsCapability(override, "no_additional_directories")) {
                supportsAddDir = false;
            }
            if (containsCapability(override, "no-partial-messages")
                    || containsCapability(override, "no-partial")) {
                supportsPartialMessages = false;
            }
        }

        return new Capabilities(
                supportsEffort,
                supportsPartialMessages,
                supportsMcp,
                supportsAddDir
        );
    }

    private static boolean isCanonicalClaudeModel(String model) {
        if (model == null) {
            return false;
        }
        return model.trim().toLowerCase().startsWith("claude-");
    }

    private static String readCapabilityOverride(String selectedModel, String resolvedModel, JsonObject env) {
        String explicit = readEnvValue(env, CliConstants.ENV_ANTHROPIC_MODEL_CAPABILITIES);
        if (explicit != null) {
            return explicit;
        }

        String normalized = selectedModel != null ? ONE_M_SUFFIX.matcher(selectedModel).replaceFirst("").toLowerCase() : "";
        return switch (detectFamily(normalized)) {
            case OPUS   -> readEnvValue(env, CliConstants.ENV_ANTHROPIC_DEFAULT_OPUS_MODEL_CAPS);
            case HAIKU  -> firstNonBlank(
                               readEnvValue(env, CliConstants.ENV_ANTHROPIC_SMALL_FAST_MODEL_CAPS),
                               readEnvValue(env, CliConstants.ENV_ANTHROPIC_DEFAULT_HAIKU_MODEL_CAPS));
            case SONNET -> readEnvValue(env, CliConstants.ENV_ANTHROPIC_DEFAULT_SONNET_MODEL_CAPS);
            case OTHER  -> isCanonicalClaudeModel(resolvedModel)
                               ? readEnvValue(env, CliConstants.ENV_ANTHROPIC_DEFAULT_SONNET_MODEL_CAPS)
                               : null;
        };
    }

    private static boolean containsCapability(String capabilities, String expected) {
        if (capabilities == null || expected == null) {
            return false;
        }
        String normalizedExpected = normalizeCapabilityToken(expected);
        for (String token : capabilities.split("[,;\\s]+")) {
            if (normalizeCapabilityToken(token).equals(normalizedExpected)) {
                return true;
            }
        }
        return false;
    }

    private static String normalizeCapabilityToken(String token) {
        return token == null ? "" : token.trim().toLowerCase().replace('-', '_');
    }

    private static String firstNonBlank(String a, String b) {
        return a != null ? a : b;
    }

    private static JsonObject toJsonObject(Map<String, String> env) {
        JsonObject json = new JsonObject();
        if (env == null) return json;
        env.forEach((k, v) -> { if (k != null && v != null) json.addProperty(k, v); });
        return json;
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
