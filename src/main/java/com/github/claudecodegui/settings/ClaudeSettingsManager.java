package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonArray;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * Claude Settings 管理器
 * 负责管理 ~/.claude/settings.json 的读写和同步
 */
public class ClaudeSettingsManager {
    private static final Logger LOG = Logger.getInstance(ClaudeSettingsManager.class);

    private final Gson gson;
    private final ConfigPathManager pathManager;

    public ClaudeSettingsManager(Gson gson, ConfigPathManager pathManager) {
        this.gson = gson;
        this.pathManager = pathManager;
    }

    /**
     * 创建默认的 Claude Settings
     */
    public JsonObject createDefaultClaudeSettings() {
        JsonObject settings = new JsonObject();
        settings.add("env", new JsonObject());
        return settings;
    }

    /**
     * 读取 Claude Settings
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
     * 写入 Claude Settings
     */
    public void writeClaudeSettings(JsonObject settings) throws IOException {
        Path settingsPath = pathManager.getClaudeSettingsPath();
        if (!Files.exists(settingsPath.getParent())) {
            Files.createDirectories(settingsPath.getParent());
        }

        // 强制写入 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC 配置
        // 确保 env 对象存在
        if (!settings.has("env") || settings.get("env").isJsonNull()) {
            settings.add("env", new JsonObject());
        }
        JsonObject env = settings.getAsJsonObject("env");
        // 强制设置为字符串类型的 "1"
        env.addProperty("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");

        try (FileWriter writer = new FileWriter(settingsPath.toFile())) {
            gson.toJson(settings, writer);
            LOG.info("[ClaudeSettingsManager] Synced settings to: " + settingsPath);
        }
    }

    /**
     * 同步 MCP 服务器配置到 Claude settings.json
     * Claude CLI 在运行时会从 ~/.claude/settings.json 读取MCP配置
     */
    public void syncMcpToClaudeSettings() throws IOException {
        try {
            String homeDir = System.getProperty("user.home");

            // 读取 ~/.claude.json
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

                // 尝试读取最近的备份
                File backup = new File(claudeJsonFile.getParent(), ".claude.json.backup");
                if (backup.exists()) {
                    LOG.info("[ClaudeSettingsManager] Found backup file, you may need to restore it manually");
                }
                return;
            }

            // 读取 ~/.claude/settings.json
            JsonObject settings = readClaudeSettings();

            // 同步 mcpServers
            if (claudeJson.has("mcpServers")) {
                settings.add("mcpServers", claudeJson.get("mcpServers"));
                LOG.info("[ClaudeSettingsManager] Synced mcpServers to settings.json");
            }

            // 同步 disabledMcpServers
            if (claudeJson.has("disabledMcpServers")) {
                settings.add("disabledMcpServers", claudeJson.get("disabledMcpServers"));
                JsonArray disabledServers = claudeJson.getAsJsonArray("disabledMcpServers");
                LOG.info("[ClaudeSettingsManager] Synced " + disabledServers.size()
                    + " disabled MCP servers to settings.json");
            }

            // 写回 settings.json
            writeClaudeSettings(settings);

            LOG.info("[ClaudeSettingsManager] Successfully synced MCP configuration to ~/.claude/settings.json");
        } catch (Exception e) {
            LOG.error("[ClaudeSettingsManager] Failed to sync MCP to Claude settings: " + e.getMessage(), e);
            throw new IOException("Failed to sync MCP settings", e);
        }
    }

    /**
     * 获取当前 Claude CLI 使用的配置 (~/.claude/settings.json)
     * 用于在设置页面展示当前应用的配置
     */
    public JsonObject getCurrentClaudeConfig() throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        JsonObject result = new JsonObject();

        // 提取 env 中的关键配置
        if (claudeSettings.has("env")) {
            JsonObject env = claudeSettings.getAsJsonObject("env");

            // 兼容两种认证方式:优先 ANTHROPIC_AUTH_TOKEN,回退到 ANTHROPIC_API_KEY
            String apiKey = "";
            String authType = "none";

            if (env.has("ANTHROPIC_AUTH_TOKEN") && !env.get("ANTHROPIC_AUTH_TOKEN").getAsString().isEmpty()) {
                apiKey = env.get("ANTHROPIC_AUTH_TOKEN").getAsString();
                authType = "auth_token";  // Bearer 认证
            } else if (env.has("ANTHROPIC_API_KEY") && !env.get("ANTHROPIC_API_KEY").getAsString().isEmpty()) {
                apiKey = env.get("ANTHROPIC_API_KEY").getAsString();
                authType = "api_key";  // x-api-key 认证
            }

            String baseUrl = env.has("ANTHROPIC_BASE_URL") ? env.get("ANTHROPIC_BASE_URL").getAsString() : "";

            result.addProperty("apiKey", apiKey);
            result.addProperty("authType", authType);  // 添加认证类型标识
            result.addProperty("baseUrl", baseUrl);
        } else {
            result.addProperty("apiKey", "");
            result.addProperty("authType", "none");
            result.addProperty("baseUrl", "");
        }

        // 如果有 codemossProviderId,尝试获取供应商名称
        if (claudeSettings.has("codemossProviderId")) {
            String providerId = claudeSettings.get("codemossProviderId").getAsString();
            result.addProperty("providerId", providerId);
        }

        return result;
    }

    /**
     * 获取 alwaysThinkingEnabled 配置
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
     * 设置 alwaysThinkingEnabled 配置
     */
    public void setAlwaysThinkingEnabled(boolean enabled) throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        claudeSettings.addProperty("alwaysThinkingEnabled", enabled);
        writeClaudeSettings(claudeSettings);
    }

    /**
     * 应用供应商配置到 Claude settings.json
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

        // 创建新的配置对象(完整替换,而不是合并)
        JsonObject claudeSettings = new JsonObject();

        // 1. 复制 settingsConfig 中的所有字段到新配置
        for (String key : settingsConfig.keySet()) {
            if (!settingsConfig.get(key).isJsonNull()) {
                claudeSettings.add(key, settingsConfig.get(key));
            }
        }

        // 2. 保留系统字段(这些字段不应该被供应商配置覆盖)
        // 保留 MCP 服务器配置
        if (oldClaudeSettings.has("mcpServers")) {
            claudeSettings.add("mcpServers", oldClaudeSettings.get("mcpServers"));
        }
        if (oldClaudeSettings.has("disabledMcpServers")) {
            claudeSettings.add("disabledMcpServers", oldClaudeSettings.get("disabledMcpServers"));
        }
        // 保留 Skills/Plugins 配置
        if (oldClaudeSettings.has("plugins")) {
            claudeSettings.add("plugins", oldClaudeSettings.get("plugins"));
        }

        // 3. 添加供应商 ID 标识
        if (provider.has("id") && !provider.get("id").isJsonNull()) {
            claudeSettings.addProperty("codemossProviderId", provider.get("id").getAsString());
        }

        writeClaudeSettings(claudeSettings);
    }

    /**
     * 同步 Skills 到 Claude settings.json
     */
    public void syncSkillsToClaudeSettings(JsonArray plugins) throws IOException {
        JsonObject claudeSettings = readClaudeSettings();
        claudeSettings.add("plugins", plugins);
        writeClaudeSettings(claudeSettings);
    }
}
