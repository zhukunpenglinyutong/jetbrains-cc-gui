package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Configuration Path Manager.
 * Manages paths for all configuration files.
 */
public class ConfigPathManager {
    private static final Logger LOG = Logger.getInstance(ConfigPathManager.class);

    private static final String CONFIG_DIR_NAME = ".codemoss";
    private static final String CONFIG_FILE_NAME = "config.json";
    private static final String BACKUP_FILE_NAME = "config.json.bak";
    private static final String AGENT_FILE_NAME = "agent.json";
    private static final String PROMPT_FILE_NAME = "prompt.json";
    private static final String CLAUDE_DIR_NAME = ".claude";
    private static final String CLAUDE_SETTINGS_FILE_NAME = "settings.json";
    private static final String MANAGED_SETTINGS_FILE_NAME = "managed-settings.json";

    /**
     * Get the configuration file path (~/.codemoss/config.json).
     */
    public String getConfigPath() {
        String homeDir = PlatformUtils.getHomeDirectory();
        return Paths.get(homeDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME).toString();
    }

    /**
     * Get the backup file path.
     */
    public String getBackupPath() {
        String homeDir = PlatformUtils.getHomeDirectory();
        return Paths.get(homeDir, CONFIG_DIR_NAME, BACKUP_FILE_NAME).toString();
    }

    /**
     * Get the configuration directory as a Path object.
     */
    public Path getConfigDir() {
        String homeDir = PlatformUtils.getHomeDirectory();
        return Paths.get(homeDir, CONFIG_DIR_NAME);
    }

    /**
     * Get the configuration file as a Path object.
     */
    public Path getConfigFilePath() {
        return getConfigDir().resolve(CONFIG_FILE_NAME);
    }

    /**
     * Get the agent.json file path.
     */
    public Path getAgentFilePath() {
        return getConfigDir().resolve(AGENT_FILE_NAME);
    }

    /**
     * Get the prompt.json file path.
     */
    public Path getPromptFilePath() {
        return getConfigDir().resolve(PROMPT_FILE_NAME);
    }

    /**
     * Get the Claude settings.json path.
     */
    public Path getClaudeSettingsPath() {
        String homeDir = PlatformUtils.getHomeDirectory();
        return Paths.get(homeDir, CLAUDE_DIR_NAME, CLAUDE_SETTINGS_FILE_NAME);
    }

    /**
     * Get the platform-specific managed-settings.json path.
     * Managed settings are typically configured by enterprise IT administrators.
     * - macOS: /Library/Application Support/ClaudeCode/managed-settings.json
     * - Linux: /etc/claude-code/managed-settings.json
     * - Windows: C:\Program Files\ClaudeCode\managed-settings.json
     */
    public Path getManagedSettingsPath() {
        if (PlatformUtils.isWindows()) {
            return Paths.get("C:", "Program Files", "ClaudeCode", MANAGED_SETTINGS_FILE_NAME);
        } else if (PlatformUtils.isMac()) {
            return Paths.get("/Library", "Application Support", "ClaudeCode", MANAGED_SETTINGS_FILE_NAME);
        } else {
            return Paths.get("/etc", "claude-code", MANAGED_SETTINGS_FILE_NAME);
        }
    }

    /**
     * Ensure the configuration directory exists.
     */
    public void ensureConfigDirectory() throws IOException {
        Path configDir = getConfigDir();
        if (!Files.exists(configDir)) {
            Files.createDirectories(configDir);
            LOG.info("[ConfigPathManager] Created config directory: " + configDir);
        }
    }
}
