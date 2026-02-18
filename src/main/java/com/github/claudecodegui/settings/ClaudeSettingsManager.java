package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonArray;
import com.intellij.openapi.diagnostic.Logger;

import com.google.gson.JsonElement;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Set;

/**
 * Claude Settings Manager.
 * Manages reading, writing, and syncing of ~/.claude/settings.json.
 */
public class ClaudeSettingsManager {
    private static final Logger LOG = Logger.getInstance(ClaudeSettingsManager.class);

    /**
     * System-protected fields - these should never be overridden by provider configs
     * and are always preserved from the existing configuration.
     */
    private static final Set<String> PROTECTED_SYSTEM_FIELDS = Set.of(
        "mcpServers",           // MCP server configuration
        "disabledMcpServers",   // Disabled MCP servers
        "plugins",              // Skills/Plugins configuration
        "trustedDirectories",   // Trusted directories
        "trustedFiles"          // Trusted files
    );

    /**
     * Provider-managed fields - only these fields will be overridden by provider configs.
     * All other user-customized fields are preserved.
     */
    private static final Set<String> PROVIDER_MANAGED_FIELDS = Set.of(
        "env",                      // Environment variables
        "model",                    // Model selection
        "alwaysThinkingEnabled",    // Thinking mode
        "codemossProviderId",       // Codemoss provider identifier
        "ccSwitchProviderId",       // CC-Switch provider identifier
        "maxContextLengthTokens",   // Maximum context length
        "temperature",              // Temperature parameter
        "topP",                     // Top-P parameter
        "topK"                      // Top-K parameter
    );

    private final Gson gson;
    private final ConfigPathManager pathManager;

    public ClaudeSettingsManager(Gson gson, ConfigPathManager pathManager) {
        this.gson = gson;
        this.pathManager = pathManager;
    }

    /**
     * Create default Claude Settings.
     */
    public JsonObject createDefaultClaudeSettings() {
        JsonObject settings = new JsonObject();
        settings.add("env", new JsonObject());
        return settings;
    }

    /**
     * Read Claude Settings.
     */
    public JsonObject readClaudeSettings() throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        File settingsFile = settingsPath.toFile();

        if (!settingsFile.exists()) {
            return createDefaultClaudeSettings();
        }

        try (FileReader reader = new FileReader(settingsFile)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("[ClaudeSettingsManager] Failed to read ~/.claude/settings.json: " + e.getMessage());
            return createDefaultClaudeSettings();
        }
    }

    /**
     * Write Claude Settings.
     */
    public void writeClaudeSettings(JsonObject settings) throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        if (!Files.exists(settingsPath.getParent())) {
            Files.createDirectories(settingsPath.getParent());
        }

        // Force-write CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC setting
        // Ensure the env object exists
        if (!settings.has("env") || settings.get("env").isJsonNull()) {
            settings.add("env", new JsonObject());
        }
        JsonObject env = settings.getAsJsonObject("env");
        // Force-set to string value "1"
        env.addProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

        try (FileWriter writer = new FileWriter(settingsPath.toFile())) {
            gson.toJson(settings, writer);
            LOG.info("[ClaudeSettingsManager] Synced settings to: " + settingsPath);
        }
    }

    /**
     * Sync MCP server configuration to Claude settings.json.
     * The Claude CLI reads MCP config from ~/.claude/settings.json at runtime.
     */
    public void syncMcpToClaudeSettings() throws IOException {
        try {
            String homeDir = System.getProperty("user.home");

            // Read ~/.claude.json
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (!claudeJsonFile.exists()) {
                LOG.info("[ClaudeSettingsManager] ~/.claude.json not found, skipping MCP sync");
                return;
            }

            JsonObject claudeJson;
            try (FileReader reader = new FileReader(claudeJsonFile)) {
                claudeJson = JsonParser.parseReader(reader).getAsJsonObject();
            } catch (Exception e) {
                LOG.error("[ClaudeSettingsManager] Failed to parse ~/.claude.json: " + e.getMessage(), e);
                LOG.error("[ClaudeSettingsManager] This may indicate a corrupted JSON file. Please check ~/.claude.json");

                // Try to read the most recent backup
                File backup = new File(claudeJsonFile.getParent(), ".claude.json.backup");
                if (backup.exists()) {
                    LOG.info("[ClaudeSettingsManager] Found backup file, you may need to restore it manually");
                }
                return;
            }

            // Read ~/.claude/settings.json
            JsonObject settings = readClaudeSettings();

            // Sync mcpServers
            if (claudeJson.has("mcpServers")) {
                settings.add("mcpServers", claudeJson.get("mcpServers"));
                LOG.info("[ClaudeSettingsManager] Synced mcpServers to settings.json");
            }

            // Sync disabledMcpServers
            if (claudeJson.has("disabledMcpServers")) {
                settings.add("disabledMcpServers", claudeJson.get("disabledMcpServers"));
                JsonArray disabledServers = claudeJson.getAsJsonArray("disabledMcpServers");
                LOG.info("[ClaudeSettingsManager] Synced " + disabledServers.size()
                    + " disabled MCP servers to settings.json");
            }

            // Write back to settings.json
            writeClaudeSettings(settings);

            LOG.info("[ClaudeSettingsManager] Successfully synced MCP configuration to ~/.claude/settings.json");
        } catch (Exception e) {
            LOG.error("[ClaudeSettingsManager] Failed to sync MCP to Claude settings: " + e.getMessage(), e);
            throw new IOException("Failed to sync MCP settings", e);
        }
    }

    /**
     * Get the current configuration used by Claude CLI (~/.claude/settings.json).
     * Used to display the currently applied configuration on the settings page.
     */
    public JsonObject getCurrentClaudeConfig() throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        JsonObject result = new JsonObject();

        // Extract key settings from the env object
        if (claudeSettings.has("env")) {
            JsonObject env = claudeSettings.getAsJsonObject("env");

            // Support both auth methods: prefer ANTHROPIC_AUTH_TOKEN, fall back to ANTHROPIC_API_KEY
            String apiKey = "";
            String authType = "none";

            if (env.has("ANTHROPIC_AUTH_TOKEN") && !env.get("ANTHROPIC_AUTH_TOKEN").getAsString().isEmpty()) {
                apiKey = env.get("ANTHROPIC_AUTH_TOKEN").getAsString();
                authType = "auth_token";  // Bearer authentication
            } else if (env.has("ANTHROPIC_API_KEY") && !env.get("ANTHROPIC_API_KEY").getAsString().isEmpty()) {
                apiKey = env.get("ANTHROPIC_API_KEY").getAsString();
                authType = "api_key";  // x-api-key authentication
            }

            String baseUrl = env.has("ANTHROPIC_BASE_URL") ? env.get("ANTHROPIC_BASE_URL").getAsString() : "";

            result.addProperty("apiKey", apiKey);
            result.addProperty("authType", authType);  // Add auth type identifier
            result.addProperty("baseUrl", baseUrl);
        } else {
            result.addProperty("apiKey", "");
            result.addProperty("authType", "none");
            result.addProperty("baseUrl", "");
        }

        // If codemossProviderId exists, try to retrieve the provider name
        if (claudeSettings.has("codemossProviderId")) {
            String providerId = claudeSettings.get("codemossProviderId").getAsString();
            result.addProperty("providerId", providerId);
        }

        return result;
    }

    /**
     * Get the alwaysThinkingEnabled setting.
     */
    public Boolean getAlwaysThinkingEnabled() throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        if (!claudeSettings.has("alwaysThinkingEnabled") || claudeSettings.get("alwaysThinkingEnabled").isJsonNull()) {
            return null;
        }
        try {
            return claudeSettings.get("alwaysThinkingEnabled").getAsBoolean();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Set the alwaysThinkingEnabled setting.
     */
    public void setAlwaysThinkingEnabled(boolean enabled) throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        claudeSettings.addProperty("alwaysThinkingEnabled", enabled);
        writeClaudeSettings(claudeSettings);
    }

    /**
     * Apply provider configuration to Claude settings.json.
     * Uses an incremental merge strategy:
     * - User-customized fields are preserved
     * - Provider-managed fields (env, model, etc.) are fully overwritten
     * - System-protected fields (mcpServers, plugins, etc.) are not affected
     */
    public void applyProviderToClaudeSettings(JsonObject provider) throws IOException {
        if (provider == null) {
            throw new IllegalArgumentException("Provider cannot be null");
        }

        if (!provider.has("settingsConfig") || provider.get("settingsConfig").isJsonNull()) {
            throw new IllegalArgumentException("Provider is missing settingsConfig");
        }

        JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");
        JsonObject oldClaudeSettings = readClaudeSettings();

        // ========== Incremental merge strategy ==========
        // Start from existing config to preserve all user customizations
        JsonObject claudeSettings = oldClaudeSettings.deepCopy();

        LOG.info("[ClaudeSettingsManager] Applying provider config with incremental merge strategy");
        LOG.info("[ClaudeSettingsManager] Original settings keys: " + oldClaudeSettings.keySet());

        // 1. Only overwrite fields managed by the provider
        for (String key : settingsConfig.keySet()) {
            JsonElement value = settingsConfig.get(key);

            // Skip null values
            if (value == null || value.isJsonNull()) {
                continue;
            }

            // Skip system-protected fields (managed by the system, providers should not override)
            if (PROTECTED_SYSTEM_FIELDS.contains(key)) {
                LOG.debug("[ClaudeSettingsManager] Skipping protected system field: " + key);
                continue;
            }

            // Only process provider-managed fields
            if (PROVIDER_MANAGED_FIELDS.contains(key)) {
                // All provider fields (including env) are fully overwritten
                claudeSettings.add(key, value);
                LOG.debug("[ClaudeSettingsManager] Set provider field: " + key);
            }
            // Note: fields not in PROVIDER_MANAGED_FIELDS are ignored and won't override user config
        }

        // 2. Add provider ID identifier
        if (provider.has("id") && !provider.get("id").isJsonNull()) {
            claudeSettings.addProperty("codemossProviderId", provider.get("id").getAsString());
        }

        LOG.info("[ClaudeSettingsManager] Final settings keys: " + claudeSettings.keySet());
        writeClaudeSettings(claudeSettings);
    }

    /**
     * Sync Skills to Claude settings.json.
     */
    public void syncSkillsToClaudeSettings(JsonArray plugins) throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        claudeSettings.add("plugins", plugins);
        writeClaudeSettings(claudeSettings);
    }
}
