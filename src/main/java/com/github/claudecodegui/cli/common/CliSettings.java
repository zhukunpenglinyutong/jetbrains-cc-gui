package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.common.CommonConstants;
import com.github.claudecodegui.settings.ConfigPathManager;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.CodexSettingsManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.GsonHolder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonElement;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * CLI-only settings facade.
 * Keeps CLI runtime/config lookups isolated from SDK bridge environment wiring.
 */
public final class CliSettings {

    private static final Set<String> PROTECTED_CLI_ENV_KEYS = Set.of(
            "PATH",
            "Path",
            "HOME",
            "USERPROFILE",
            CommonConstants.ENV_HOMEDRIVE,
            CommonConstants.ENV_HOMEPATH,
            CliConstants.ENV_CODEX_HOME,
            CliConstants.ENV_CODEX_SANDBOX,
            CliConstants.ENV_CODEX_SANDBOX_MODE,
            CliConstants.ENV_CODEX_SANDBOX_NETWORK_DISABLED,
            CliConstants.ENV_CLAUDE_SESSION_ID,
            CliConstants.ENV_CLAUDE_PERMISSION_DIR,
            CliConstants.ENV_CLAUDE_PERMISSION_SAFETY_NET_MS,
            CliConstants.ENV_IDEA_PROJECT_PATH,
            CliConstants.ENV_PROJECT_PATH
    );

    private CliSettings() {
    }

    public static long getClaudePermissionSafetyNetMs() {
        JsonObject cliSettings = readCliSettings();
        if (cliSettings.has(CommonConstants.SETTING_PERMISSION_TIMEOUT)) {
            try {
                int timeoutSeconds = cliSettings.get(CommonConstants.SETTING_PERMISSION_TIMEOUT).getAsInt();
                return (CodemossSettingsService.clampPermissionDialogTimeoutSeconds(timeoutSeconds)
                        + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
            } catch (Exception ignored) {
            }
        }
        try {
            long timeoutSeconds = CodemossSettingsService.getInstance().getPermissionDialogTimeoutSeconds();
            return (timeoutSeconds + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
        } catch (Exception ignored) {
            return (CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                    + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
        }
    }

    public static String getCodexSandboxMode(String cwd) {
        JsonObject cliSettings = readCliSettings();
        if (cliSettings.has(CommonConstants.SETTING_CODEX_SANDBOX_MODE)) {
            String configured = safeString(cliSettings, CommonConstants.SETTING_CODEX_SANDBOX_MODE);
            if (CliConstants.VALID_SANDBOX_MODES.contains(configured)) {
                return configured;
            }
        }
        try {
            String configured = CodemossSettingsService.getInstance().getCodexSandboxMode(cwd);
            if (CliConstants.VALID_SANDBOX_MODES.contains(configured)) {
                return configured;
            }
        } catch (Exception ignored) {
        }
        return PlatformUtils.isWindows() ? CliConstants.SANDBOX_DANGER_FULL_ACCESS : CliConstants.SANDBOX_WORKSPACE_WRITE;
    }

    public static JsonObject readClaudeGlobalMcpServers() {
        JsonObject cliSettings = readCliSettings();
        if (cliSettings.has(CliConstants.MCP_SERVERS_KEY) && cliSettings.get(CliConstants.MCP_SERVERS_KEY).isJsonObject()) {
            return cliSettings.getAsJsonObject(CliConstants.MCP_SERVERS_KEY).deepCopy();
        }
        return new JsonObject();
    }

    public static JsonObject readClaudeEnv() {
        JsonObject cliSettings = readCliSettings();
        if (cliSettings.has(CommonConstants.SETTING_CLAUDE_ENV) && cliSettings.get(CommonConstants.SETTING_CLAUDE_ENV).isJsonObject()) {
            return cliSettings.getAsJsonObject(CommonConstants.SETTING_CLAUDE_ENV).deepCopy();
        }
        return new JsonObject();
    }

    public static Map<String, String> readClaudeCliEnvironment() {
        Map<String, String> env = new LinkedHashMap<>();
        JsonObject cliOnlyEnv = readClaudeEnv();
        mergeJsonEnvObject(env, cliOnlyEnv);

        try {
            Path settingsPath = Paths.get(PlatformUtils.getHomeDirectory(), CommonConstants.DIR_CLAUDE, CommonConstants.FILE_SETTINGS_JSON);
            if (!Files.exists(settingsPath)) {
                return env;
            }
            JsonObject settings = JsonParser.parseString(Files.readString(settingsPath, StandardCharsets.UTF_8))
                    .getAsJsonObject();
            if (settings != null && settings.has(CommonConstants.TOML_KEY_ENV) && settings.get(CommonConstants.TOML_KEY_ENV).isJsonObject()) {
                mergeJsonEnvObject(env, settings.getAsJsonObject(CommonConstants.TOML_KEY_ENV));
            }
            String apiKeyHelper = safeString(settings, "apiKeyHelper");
            if (apiKeyHelper != null) {
                putIfAllowed(env, CliConstants.ENV_ANTHROPIC_API_KEY_HELPER, apiKeyHelper);
            }
        } catch (Exception ignored) {
        }
        return env;
    }

    public static Map<String, String> readCodexCliEnvironment() {
        Map<String, String> env = new LinkedHashMap<>();
        try {
            CodexSettingsManager manager = new CodexSettingsManager(GsonHolder.GSON);
            Map<String, Object> config = manager.readConfigToml();
            if (config != null) {
                String model = stringValue(config.get(CommonConstants.TOML_KEY_MODEL));
                if (model != null) {
                    putIfAllowed(env, CliConstants.ENV_CODEX_MODEL, model);
                }

                Object envSection = config.get(CommonConstants.TOML_KEY_ENV);
                if (envSection instanceof Map<?, ?> envMap) {
                    mergeObjectEnvMap(env, envMap);
                }

                String providerId = stringValue(config.get(CommonConstants.TOML_KEY_MODEL_PROVIDER));
                Object providers = config.get(CommonConstants.TOML_KEY_MODEL_PROVIDERS);
                if (providerId != null && providers instanceof Map<?, ?> providerMap) {
                    Object providerConfig = providerMap.get(providerId);
                    if (providerConfig instanceof Map<?, ?> providerConfigMap) {
                        String baseUrl = stringValue(providerConfigMap.get(CommonConstants.TOML_KEY_BASE_URL));
                        if (baseUrl != null) {
                            putIfAllowed(env, CliConstants.ENV_OPENAI_BASE_URL, baseUrl);
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }

        try {
            Path authPath = Paths.get(PlatformUtils.getHomeDirectory(), CommonConstants.DIR_CODEX, CommonConstants.FILE_AUTH_JSON);
            if (Files.exists(authPath)) {
                JsonObject auth = JsonParser.parseString(Files.readString(authPath, StandardCharsets.UTF_8))
                        .getAsJsonObject();
                if (auth != null) {
                    mergeKnownCodexAuthEnv(env, auth);
                }
            }
        } catch (Exception ignored) {
        }
        return env;
    }

    private static JsonObject readCliSettings() {
        try {
            Path path = new ConfigPathManager().getCliSettingsFilePath();
            if (!Files.exists(path)) {
                return new JsonObject();
            }
            String content = Files.readString(path, StandardCharsets.UTF_8);
            JsonObject json = JsonParser.parseString(content).getAsJsonObject();
            return json != null ? json : new JsonObject();
        } catch (Exception ignored) {
            return new JsonObject();
        }
    }

    private static String safeString(JsonObject obj, String key) {
        if (obj == null || key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        try {
            String value = obj.get(key).getAsString();
            return value != null ? value.trim() : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void mergeJsonEnvObject(Map<String, String> target, JsonObject env) {
        if (target == null || env == null) {
            return;
        }
        for (Map.Entry<String, JsonElement> entry : env.entrySet()) {
            if (entry.getValue() == null || entry.getValue().isJsonNull()) {
                continue;
            }
            try {
                putIfAllowed(target, entry.getKey(), entry.getValue().getAsString());
            } catch (Exception ignored) {
            }
        }
    }

    private static void mergeObjectEnvMap(Map<String, String> target, Map<?, ?> env) {
        if (target == null || env == null) {
            return;
        }
        for (Map.Entry<?, ?> entry : env.entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null) {
                continue;
            }
            putIfAllowed(target, String.valueOf(entry.getKey()), stringValue(entry.getValue()));
        }
    }

    private static void mergeKnownCodexAuthEnv(Map<String, String> target, JsonObject auth) {
        for (String key : CliConstants.CODEX_AUTH_ENV_KEYS) {
            String value = safeString(auth, key);
            if (value != null) {
                putIfAllowed(target, key, value);
            }
        }
    }

    private static void putIfAllowed(Map<String, String> target, String key, String value) {
        if (target == null || !isAllowedCliEnvKey(key) || value == null || value.isBlank()) {
            return;
        }
        target.put(key, value.trim());
    }

    private static boolean isAllowedCliEnvKey(String key) {
        if (key == null || key.isBlank() || !key.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            return false;
        }
        if (PROTECTED_CLI_ENV_KEYS.contains(key)) {
            return false;
        }
        String upper = key.toUpperCase(Locale.ROOT);
        return !PROTECTED_CLI_ENV_KEYS.contains(upper);
    }

    private static String stringValue(Object value) {
        if (value == null) {
            return null;
        }
        String text = String.valueOf(value).trim();
        return text.isEmpty() ? null : text;
    }
}
