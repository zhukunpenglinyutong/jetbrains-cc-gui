package com.github.claudecodegui.diagnostics;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * F-007/F-008/F-010: Static utility for diagnostic settings.
 * Reads/writes from ~/.codemoss/config.json — no instance needed.
 * Replaces the diagnostic methods that were in CodemossSettingsService.
 */
public final class DiagnosticConfig {

    private static final Logger LOG = Logger.getInstance(DiagnosticConfig.class);
    private static final Gson GSON = new Gson();

    private DiagnosticConfig() {} // utility class

    // ========================================================================
    // F-008: Tracker Path
    // ========================================================================

    public static String getTrackerPath() {
        JsonObject config = readConfig();
        if (config.has("trackerPath")) {
            return config.get("trackerPath").getAsString();
        }
        return "";
    }

    public static void setTrackerPath(String path) {
        JsonObject config = readConfig();
        if (path == null || path.trim().isEmpty()) {
            config.remove("trackerPath");
        } else {
            config.addProperty("trackerPath", path.trim());
        }
        writeConfig(config);
        LOG.info("[DiagnosticConfig] Set tracker path: " + path);
    }

    public static boolean trackerFileExists(String path) {
        return path != null && !path.isEmpty() && Files.exists(Path.of(path));
    }

    // ========================================================================
    // F-010: IPC Sniffer
    // ========================================================================

    public static boolean getIpcSnifferEnabled() {
        JsonObject config = readConfig();
        if (!config.has("ipcSniffer")) return false;
        JsonObject snifferConfig = config.getAsJsonObject("ipcSniffer");
        return snifferConfig.has("enabled") && snifferConfig.get("enabled").getAsBoolean();
    }

    public static void setIpcSnifferEnabled(boolean enabled) {
        JsonObject config = readConfig();
        JsonObject snifferConfig;
        if (config.has("ipcSniffer")) {
            snifferConfig = config.getAsJsonObject("ipcSniffer");
        } else {
            snifferConfig = new JsonObject();
            config.add("ipcSniffer", snifferConfig);
        }
        snifferConfig.addProperty("enabled", enabled);
        writeConfig(config);
        LOG.info("[DiagnosticConfig] Set IPC sniffer enabled: " + enabled);
    }

    // ========================================================================
    // Config I/O (shared with CodemossSettingsService via same file)
    // ========================================================================

    private static Path getConfigPath() {
        return Paths.get(com.github.claudecodegui.util.PlatformUtils.getHomeDirectory(),
                ".codemoss", "config.json");
    }

    private static JsonObject readConfig() {
        try {
            Path configPath = getConfigPath();
            if (Files.exists(configPath)) {
                String content = Files.readString(configPath, StandardCharsets.UTF_8);
                return JsonParser.parseString(content).getAsJsonObject();
            }
        } catch (Exception e) {
            LOG.debug("[DiagnosticConfig] Failed to read config: " + e.getMessage());
        }
        return new JsonObject();
    }

    private static void writeConfig(JsonObject config) {
        try {
            Path configPath = getConfigPath();
            Files.createDirectories(configPath.getParent());
            Files.writeString(configPath, GSON.toJson(config), StandardCharsets.UTF_8);
        } catch (IOException e) {
            LOG.warn("[DiagnosticConfig] Failed to write config: " + e.getMessage());
        }
    }
}
