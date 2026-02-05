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
 * Claude Settings 管理器
 * 负责管理 ~/.claude/settings.json 的读写和同步
 */
public class ClaudeSettingsManager {
    private static final Logger LOG = Logger.getInstance(ClaudeSettingsManager.class);

    /**
     * 系统保护字段 - 这些字段不应被供应商配置覆盖，始终从原有配置保留
     */
    private static final Set<String> PROTECTED_SYSTEM_FIELDS = Set.of(
        "mcpServers",           // MCP 服务器配置
        "disabledMcpServers",   // 禁用的 MCP 服务器
        "plugins",              // Skills/Plugins 配置
        "trustedDirectories",   // 信任的目录
        "trustedFiles"          // 信任的文件
    );

    /**
     * 供应商可管理的字段 - 只有这些字段会被供应商配置覆盖
     * 其他用户自定义字段将被保留
     */
    private static final Set<String> PROVIDER_MANAGED_FIELDS = Set.of(
        "env",                      // 环境变量配置
        "model",                    // 模型选择
        "alwaysThinkingEnabled",    // 思考模式
        "codemossProviderId",       // Codemoss 供应商标识
        "ccSwitchProviderId",       // CC-Switch 供应商标识
        "maxContextLengthTokens",   // 最大上下文长度
        "temperature",              // 温度参数
        "topP",                     // Top-P 参数
        "topK"                      // Top-K 参数
    );

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
     * 采用增量合并策略：
     * - 用户自定义字段保留
     * - 供应商管理的字段（env, model 等）整体覆盖
     * - 系统保护字段（mcpServers, plugins 等）不受影响
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

        // ========== 增量合并策略 ==========
        // 从现有配置开始，保留用户的所有自定义配置
        JsonObject claudeSettings = oldClaudeSettings.deepCopy();

        LOG.info("[ClaudeSettingsManager] Applying provider config with incremental merge strategy");
        LOG.info("[ClaudeSettingsManager] Original settings keys: " + oldClaudeSettings.keySet());

        // 1. 只覆盖供应商需要管理的字段
        for (String key : settingsConfig.keySet()) {
            JsonElement value = settingsConfig.get(key);

            // 跳过 null 值
            if (value == null || value.isJsonNull()) {
                continue;
            }

            // 跳过系统保护字段（这些字段由系统管理，供应商不应覆盖）
            if (PROTECTED_SYSTEM_FIELDS.contains(key)) {
                LOG.debug("[ClaudeSettingsManager] Skipping protected system field: " + key);
                continue;
            }

            // 只处理供应商可管理的字段
            if (PROVIDER_MANAGED_FIELDS.contains(key)) {
                // 所有供应商字段（包括 env）都整体覆盖
                claudeSettings.add(key, value);
                LOG.debug("[ClaudeSettingsManager] Set provider field: " + key);
            }
            // 注意：不在 PROVIDER_MANAGED_FIELDS 中的字段会被忽略，不会覆盖用户配置
        }

        // 2. 添加供应商 ID 标识
        if (provider.has("id") && !provider.get("id").isJsonNull()) {
            claudeSettings.addProperty("codemossProviderId", provider.get("id").getAsString());
        }

        LOG.info("[ClaudeSettingsManager] Final settings keys: " + claudeSettings.keySet());
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
