package com.github.claudecodegui.cli.common;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * CLI-only settings facade.
 * Keeps CLI runtime/config lookups isolated from SDK bridge environment wiring.
 */
public final class CliSettings {

    private CliSettings() {
    }

    public static long getClaudePermissionSafetyNetMs() {
        JsonObject cliSettings = readCliSettings();
        if (cliSettings.has("permissionDialogTimeoutSeconds")) {
            try {
                int timeoutSeconds = cliSettings.get("permissionDialogTimeoutSeconds").getAsInt();
                return (CodemossSettingsService.clampPermissionDialogTimeoutSeconds(timeoutSeconds)
                        + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
            } catch (Exception ignored) {
            }
        }
        try {
            long timeoutSeconds = new CodemossSettingsService().getPermissionDialogTimeoutSeconds();
            return (timeoutSeconds + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
        } catch (Exception ignored) {
            return (CodemossSettingsService.DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS
                    + CodemossSettingsService.PERMISSION_SAFETY_NET_BUFFER_SECONDS) * 1000L;
        }
    }

    public static String getCodexSandboxMode(String cwd) {
        JsonObject cliSettings = readCliSettings();
        if (cliSettings.has("codexSandboxMode")) {
            String configured = safeString(cliSettings, "codexSandboxMode");
            if ("read-only".equals(configured)
                    || "workspace-write".equals(configured)
                    || "danger-full-access".equals(configured)) {
                return configured;
            }
        }
        try {
            String configured = new CodemossSettingsService().getCodexSandboxMode(cwd);
            if ("read-only".equals(configured)
                    || "workspace-write".equals(configured)
                    || "danger-full-access".equals(configured)) {
                return configured;
            }
        } catch (Exception ignored) {
        }
        return PlatformUtils.isWindows() ? "danger-full-access" : "workspace-write";
    }

    public static JsonObject readClaudeGlobalMcpServers() {
        JsonObject cliSettings = readCliSettings();
        if (cliSettings.has("mcpServers") && cliSettings.get("mcpServers").isJsonObject()) {
            return cliSettings.getAsJsonObject("mcpServers").deepCopy();
        }
        return new JsonObject();
    }

    public static JsonObject readClaudeEnv() {
        JsonObject cliSettings = readCliSettings();
        if (cliSettings.has("claudeEnv") && cliSettings.get("claudeEnv").isJsonObject()) {
            return cliSettings.getAsJsonObject("claudeEnv").deepCopy();
        }
        return new JsonObject();
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
}
