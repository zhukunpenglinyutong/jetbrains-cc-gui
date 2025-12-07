package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;

import com.github.claudecodegui.model.DeleteResult;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.HashMap;

/**
 * Codemoss 配置文件服务
 * 用于读写 ~/.codemoss/config.json
 * 如果不存在则从 ~/.claude/settings.json 导入
 */
public class CodemossSettingsService {

    private static final String CONFIG_DIR_NAME = ".codemoss";
    private static final String CONFIG_FILE_NAME = "config.json";
    private static final String BACKUP_FILE_NAME = "config.json.bak";
    private static final int CONFIG_VERSION = 2;

    private static final String CLAUDE_DIR_NAME = ".claude";
    private static final String CLAUDE_SETTINGS_FILE_NAME = "settings.json";

    private final Gson gson;

    public CodemossSettingsService() {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
    }

    /**
     * 获取配置文件路径 (~/.codemoss/config.json)
     */
    public String getConfigPath() {
        String homeDir = System.getProperty("user.home");
        return Paths.get(homeDir, CONFIG_DIR_NAME, CONFIG_FILE_NAME).toString();
    }

    /**
     * 获取备份文件路径
     */
    private String getBackupPath() {
        String homeDir = System.getProperty("user.home");
        return Paths.get(homeDir, CONFIG_DIR_NAME, BACKUP_FILE_NAME).toString();
    }

    /**
     * 获取配置目录 Path 对象
     */
    private Path getConfigDir() {
        String homeDir = System.getProperty("user.home");
        return Paths.get(homeDir, CONFIG_DIR_NAME);
    }

    /**
     * 获取配置文件 Path 对象
     */
    private Path getConfigFilePath() {
        return getConfigDir().resolve(CONFIG_FILE_NAME);
    }

    /**
     * 确保配置目录存在
     */
    private void ensureConfigDirectory() throws IOException {
        Path configDir = getConfigDir();
        if (!Files.exists(configDir)) {
            Files.createDirectories(configDir);
            System.out.println("[CodemossSettings] Created config directory: " + configDir);
        }
    }

    /**
     * 读取配置文件
     * 优先读取 ~/.codemoss/config.json
     * 如果不存在，则尝试从 ~/.claude/settings.json 导入
     */
    public JsonObject readConfig() throws IOException {

        String configPath = getConfigPath();
        File configFile = new File(configPath);

        if (!configFile.exists()) {
            System.out.println("[CodemossSettings] Config file not found, creating default: " + configPath);
            return createDefaultConfig();
        }

        try (FileReader reader = new FileReader(configFile)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            System.out.println("[CodemossSettings] Successfully read config from: " + configPath);
            return config;
        } catch (Exception e) {
            System.err.println("[CodemossSettings] Failed to read config: " + e.getMessage());
            return createDefaultConfig();
        }
    }

    /**
     * 写入配置文件
     */
    public void writeConfig(JsonObject config) throws IOException {
        ensureConfigDirectory();

        // 备份现有配置
        backupConfig();

        String configPath = getConfigPath();
        try (FileWriter writer = new FileWriter(configPath)) {
            gson.toJson(config, writer);
            System.out.println("[CodemossSettings] Successfully wrote config to: " + configPath);
        } catch (Exception e) {
            System.err.println("[CodemossSettings] Failed to write config: " + e.getMessage());
            throw e;
        }
    }

    private void backupConfig() {
        try {
            Path configPath = getConfigFilePath();
            if (Files.exists(configPath)) {
                Files.copy(configPath, Paths.get(getBackupPath()), StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception e) {
            System.err.println("[CodemossSettings] Failed to backup config: " + e.getMessage());
        }
    }

    private Path getClaudeSettingsPath() {
        String homeDir = System.getProperty("user.home");
        return Paths.get(homeDir, CLAUDE_DIR_NAME, CLAUDE_SETTINGS_FILE_NAME);
    }

    private JsonObject createDefaultClaudeSettings() {
        JsonObject settings = new JsonObject();
        settings.add("env", new JsonObject());
        return settings;
    }

    private JsonObject readClaudeSettings() throws IOException {
        Path settingsPath = getClaudeSettingsPath();
        File settingsFile = settingsPath.toFile();

        if (!settingsFile.exists()) {
            return createDefaultClaudeSettings();
        }

        try (FileReader reader = new FileReader(settingsFile)) {
            return JsonParser.parseReader(reader).getAsJsonObject();
        } catch (Exception e) {
            System.err.println("[CodemossSettings] Failed to read ~/.claude/settings.json: " + e.getMessage());
            return createDefaultClaudeSettings();
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
            String apiKey = env.has("ANTHROPIC_AUTH_TOKEN") ? env.get("ANTHROPIC_AUTH_TOKEN").getAsString() : "";
            String baseUrl = env.has("ANTHROPIC_BASE_URL") ? env.get("ANTHROPIC_BASE_URL").getAsString() : "";

            result.addProperty("apiKey", apiKey);
            result.addProperty("baseUrl", baseUrl);
        } else {
            result.addProperty("apiKey", "");
            result.addProperty("baseUrl", "");
        }

        // 如果有 codemossProviderId，尝试获取供应商名称
        if (claudeSettings.has("codemossProviderId")) {
            String providerId = claudeSettings.get("codemossProviderId").getAsString();
            result.addProperty("providerId", providerId);

            // 尝试从 codemoss 配置中获取供应商名称
            try {
                JsonObject config = readConfig();
                if (config.has("claude")) {
                    JsonObject claude = config.getAsJsonObject("claude");
                    if (claude.has("providers")) {
                        JsonObject providers = claude.getAsJsonObject("providers");
                        if (providers.has(providerId)) {
                            JsonObject provider = providers.getAsJsonObject(providerId);
                            if (provider.has("name")) {
                                result.addProperty("providerName", provider.get("name").getAsString());
                            }
                        }
                    }
                }
            } catch (Exception e) {
                // 忽略错误，供应商名称是可选的
            }
        }

        return result;
    }

    private void writeClaudeSettings(JsonObject settings) throws IOException {
        Path settingsPath = getClaudeSettingsPath();
        if (!Files.exists(settingsPath.getParent())) {
            Files.createDirectories(settingsPath.getParent());
        }
        try (FileWriter writer = new FileWriter(settingsPath.toFile())) {
            gson.toJson(settings, writer);
            System.out.println("[CodemossSettings] Synced settings to: " + settingsPath);
        }
    }

    /**
     * 创建默认配置（空配置，不从其他地方导入）
     */
    private JsonObject createDefaultConfig() {
        JsonObject config = new JsonObject();
        config.addProperty("version", CONFIG_VERSION);

        // Claude 配置 - 空的供应商列表
        JsonObject claude = new JsonObject();
        JsonObject providers = new JsonObject();

        claude.addProperty("current", "");
        claude.add("providers", providers);
        config.add("claude", claude);

        return config;
    }

    private JsonObject extractEnvConfig(JsonObject provider) {
        if (provider == null ||
            !provider.has("settingsConfig") ||
            provider.get("settingsConfig").isJsonNull()) {
            return null;
        }
        JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");
        if (!settingsConfig.has("env") || settingsConfig.get("env").isJsonNull()) {
            return null;
        }
        return settingsConfig.getAsJsonObject("env");
    }

    private void setOrRemove(JsonObject env, String key, String value) {
        if (value != null && !value.isEmpty()) {
            env.addProperty(key, value);
        } else {
            env.remove(key);
        }
    }

    /**
     * 获取所有Claude供应商
     */
    public List<JsonObject> getClaudeProviders() throws IOException {
        JsonObject config = readConfig();
        List<JsonObject> result = new ArrayList<>();

        if (!config.has("claude")) {
            return result;
        }

        JsonObject claude = config.getAsJsonObject("claude");
        if (!claude.has("providers")) {
            return result;
        }

        JsonObject providers = claude.getAsJsonObject("providers");
        String currentId = claude.has("current") ? claude.get("current").getAsString() : null;

        for (String key : providers.keySet()) {
            JsonObject provider = providers.getAsJsonObject(key);
            // 兼容旧版配置：若缺失 id 字段则使用 key 作为补充
            if (!provider.has("id")) {
                provider.addProperty("id", key);
            }
            // 添加 isActive 标记
            provider.addProperty("isActive", key.equals(currentId));
            result.add(provider);
        }

        return result;
    }

    /**
     * 获取当前激活的供应商
     */
    public JsonObject getActiveClaudeProvider() throws IOException {
        JsonObject config = readConfig();

        if (!config.has("claude")) {
            return null;
        }

        JsonObject claude = config.getAsJsonObject("claude");
        if (!claude.has("current") || !claude.has("providers")) {
            return null;
        }

        String currentId = claude.get("current").getAsString();
        JsonObject providers = claude.getAsJsonObject("providers");

        if (providers.has(currentId)) {
            JsonObject provider = providers.getAsJsonObject(currentId);
            if (!provider.has("id")) {
                provider.addProperty("id", currentId);
            }
            provider.addProperty("isActive", true);
            return provider;
        }

        return null;
    }

    public void applyProviderToClaudeSettings(JsonObject provider) throws IOException {
        if (provider == null) {
            throw new IllegalArgumentException("Provider cannot be null");
        }

        if (!provider.has("settingsConfig") || provider.get("settingsConfig").isJsonNull()) {
            throw new IllegalArgumentException("Provider is missing settingsConfig");
        }

        JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");
        JsonObject claudeSettings = readClaudeSettings();

        // 同步所有 settingsConfig 中的字段到 claudeSettings
        for (String key : settingsConfig.keySet()) {
            if (settingsConfig.get(key).isJsonNull()) {
                claudeSettings.remove(key);
            } else {
                claudeSettings.add(key, settingsConfig.get(key));
            }
        }

        // 确保 codemossProviderId 字段存在
        if (provider.has("id") && !provider.get("id").isJsonNull()) {
            claudeSettings.addProperty("codemossProviderId", provider.get("id").getAsString());
        }

        writeClaudeSettings(claudeSettings);
    }

    public void applyActiveProviderToClaudeSettings() throws IOException {
        JsonObject activeProvider = getActiveClaudeProvider();
        if (activeProvider == null) {
            System.out.println("[CodemossSettings] No active provider to sync to .claude/settings.json");
            return;
        }
        applyProviderToClaudeSettings(activeProvider);
    }

    /**
     * 添加供应商
     */
    public void addClaudeProvider(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }

        JsonObject config = readConfig();

        // 确保 claude 配置存在
        if (!config.has("claude")) {
            JsonObject claude = new JsonObject();
            claude.add("providers", new JsonObject());
            claude.addProperty("current", "");
            config.add("claude", claude);
        }

        JsonObject claude = config.getAsJsonObject("claude");
        JsonObject providers = claude.getAsJsonObject("providers");

        String id = provider.get("id").getAsString();

        // 检查 ID 是否已存在
        if (providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' already exists");
        }

        // 添加创建时间
        if (!provider.has("createdAt")) {
            provider.addProperty("createdAt", System.currentTimeMillis());
        }

        // 添加供应商（不自动设为 current，用户需要手动点击"启用"按钮来激活）
        providers.add(id, provider);

        writeConfig(config);
        System.out.println("[CodemossSettings] Added provider: " + id + " (not activated, user needs to manually switch)");
    }

    /**
     * 更新供应商
     */
    public void updateClaudeProvider(String id, JsonObject updates) throws IOException {
        JsonObject config = readConfig();

        if (!config.has("claude")) {
            throw new IllegalArgumentException("No claude configuration found");
        }

        JsonObject claude = config.getAsJsonObject("claude");
        JsonObject providers = claude.getAsJsonObject("providers");

        if (!providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' not found");
        }

        JsonObject provider = providers.getAsJsonObject(id);

        // 合并更新
        for (String key : updates.keySet()) {
            // 不允许修改 id
            if (key.equals("id")) {
                continue;
            }
            provider.add(key, updates.get(key));
        }

        writeConfig(config);
        System.out.println("[CodemossSettings] Updated provider: " + id);
    }

    /**
     * 删除供应商（返回 DeleteResult 提供详细错误信息）
     * @param id 供应商 ID
     * @return DeleteResult 包含操作结果和错误详情
     */
    public DeleteResult deleteClaudeProvider(String id) {
        Path configFilePath = null;
        Path backupFilePath = null;

        try {
            JsonObject config = readConfig();
            configFilePath = getConfigFilePath();
            backupFilePath = getConfigDir().resolve(BACKUP_FILE_NAME);

            if (!config.has("claude")) {
                return DeleteResult.failure(
                    DeleteResult.ErrorType.FILE_NOT_FOUND,
                    "No claude configuration found",
                    configFilePath.toString(),
                    "请先添加至少一个供应商配置"
                );
            }

            JsonObject claude = config.getAsJsonObject("claude");
            JsonObject providers = claude.getAsJsonObject("providers");

            if (!providers.has(id)) {
                return DeleteResult.failure(
                    DeleteResult.ErrorType.FILE_NOT_FOUND,
                    "Provider with id '" + id + "' not found",
                    null,
                    "请检查供应商 ID 是否正确"
                );
            }

            // 创建配置备份（用于回滚）
            try {
                Files.copy(configFilePath, backupFilePath, StandardCopyOption.REPLACE_EXISTING);
                System.out.println("[CodemossSettings] Created backup: " + backupFilePath);
            } catch (IOException e) {
                System.err.println("[CodemossSettings] Warning: Failed to create backup: " + e.getMessage());
                // 备份失败不阻止删除操作，但记录警告
            }

            // 删除供应商
            providers.remove(id);

            // 如果删除的是当前激活的供应商，切换到第一个可用的供应商
            String currentId = claude.has("current") ? claude.get("current").getAsString() : null;
            if (id.equals(currentId)) {
                if (providers.size() > 0) {
                    String firstKey = providers.keySet().iterator().next();
                    claude.addProperty("current", firstKey);
                    System.out.println("[CodemossSettings] Switched to provider: " + firstKey);
                } else {
                    claude.addProperty("current", "");
                    System.out.println("[CodemossSettings] No remaining providers");
                }
            }

            // 写入配置
            writeConfig(config);
            System.out.println("[CodemossSettings] Deleted provider: " + id);

            // 删除成功后移除备份
            try {
                Files.deleteIfExists(backupFilePath);
            } catch (IOException e) {
                // 忽略备份文件删除失败
            }

            return DeleteResult.success(id);

        } catch (IOException e) {
            // 尝试从备份恢复
            if (backupFilePath != null && configFilePath != null) {
                try {
                    if (Files.exists(backupFilePath)) {
                        Files.copy(backupFilePath, configFilePath, StandardCopyOption.REPLACE_EXISTING);
                        System.out.println("[CodemossSettings] Restored from backup after failure");
                    }
                } catch (IOException restoreEx) {
                    System.err.println("[CodemossSettings] Failed to restore backup: " + restoreEx.getMessage());
                }
            }

            return DeleteResult.fromException(e, configFilePath != null ? configFilePath.toString() : null);
        }
    }

    /**
     * 删除供应商（兼容旧接口，抛出异常）
     * @deprecated 使用 {@link #deleteClaudeProvider(String)} 获取详细错误信息
     */
    @Deprecated
    public void deleteClaudeProviderWithException(String id) throws IOException {
        DeleteResult result = deleteClaudeProvider(id);
        if (!result.isSuccess()) {
            throw new IOException(result.getUserFriendlyMessage());
        }
    }

    /**
     * 切换供应商
     */
    public void switchClaudeProvider(String id) throws IOException {
        JsonObject config = readConfig();

        if (!config.has("claude")) {
            throw new IllegalArgumentException("No claude configuration found");
        }

        JsonObject claude = config.getAsJsonObject("claude");
        JsonObject providers = claude.getAsJsonObject("providers");

        if (!providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' not found");
        }

        claude.addProperty("current", id);
        writeConfig(config);
        System.out.println("[CodemossSettings] Switched to provider: " + id);
    }

    /**
     * 获取所有 MCP 服务器
     */
    public List<JsonObject> getMcpServers() throws IOException {
        JsonObject config = readConfig();
        List<JsonObject> result = new ArrayList<>();

        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            for (JsonElement elem : servers) {
                if (elem.isJsonObject()) {
                    result.add(elem.getAsJsonObject());
                }
            }
        }
        return result;
    }

    /**
     * 更新或插入 MCP 服务器
     */
    public void upsertMcpServer(JsonObject server) throws IOException {
        if (!server.has("id")) {
            throw new IllegalArgumentException("Server must have an id");
        }

        JsonObject config = readConfig();
        JsonArray servers;

        if (config.has("mcpServers")) {
            servers = config.getAsJsonArray("mcpServers");
        } else {
            servers = new JsonArray();
            config.add("mcpServers", servers);
        }

        String id = server.get("id").getAsString();
        boolean found = false;

        // 查找并更新
        for (int i = 0; i < servers.size(); i++) {
            JsonObject s = servers.get(i).getAsJsonObject();
            if (s.has("id") && s.get("id").getAsString().equals(id)) {
                servers.set(i, server); // 替换
                found = true;
                break;
            }
        }

        if (!found) {
            servers.add(server);
        }

        writeConfig(config);
        System.out.println("[CodemossSettings] Upserted MCP server: " + id);
    }

    /**
     * 删除 MCP 服务器
     */
    public boolean deleteMcpServer(String serverId) throws IOException {
        JsonObject config = readConfig();
        if (!config.has("mcpServers")) {
            return false;
        }

        JsonArray servers = config.getAsJsonArray("mcpServers");
        boolean removed = false;
        JsonArray newServers = new JsonArray();

        for (JsonElement elem : servers) {
            JsonObject s = elem.getAsJsonObject();
            if (s.has("id") && s.get("id").getAsString().equals(serverId)) {
                removed = true;
            } else {
                newServers.add(s);
            }
        }

        if (removed) {
            config.add("mcpServers", newServers);
            writeConfig(config);
            System.out.println("[CodemossSettings] Deleted MCP server: " + serverId);
        }

        return removed;
    }

    public Map<String, Object> validateMcpServer(JsonObject server) {
        List<String> errors = new ArrayList<>();

        if (!server.has("name") || server.get("name").getAsString().isEmpty()) {
            errors.add("服务器名称不能为空");
        }

        if (server.has("server")) {
            JsonObject serverSpec = server.getAsJsonObject("server");
            String type = serverSpec.has("type") ? serverSpec.get("type").getAsString() : "stdio";

            if ("stdio".equals(type)) {
                if (!serverSpec.has("command") || serverSpec.get("command").getAsString().isEmpty()) {
                    errors.add("命令不能为空");
                }
            } else if ("http".equals(type) || "sse".equals(type)) {
                if (!serverSpec.has("url") || serverSpec.get("url").getAsString().isEmpty()) {
                    errors.add("URL 不能为空");
                } else {
                    String url = serverSpec.get("url").getAsString();
                     try {
                        new java.net.URL(url);
                    } catch (Exception e) {
                        errors.add("URL 格式无效");
                    }
                }
            } else {
                errors.add("不支持的连接类型: " + type);
            }
        } else {
            errors.add("缺少服务器配置详情");
        }

        Map<String, Object> result = new HashMap<>();
        result.put("valid", errors.isEmpty());
        result.put("errors", errors);
        return result;
    }

    // ==================== Skills 管理 ====================

    /**
     * 获取所有 Skills 配置
     * 从 ~/.codemoss/config.json 读取
     */
    public List<JsonObject> getSkills() throws IOException {
        List<JsonObject> result = new ArrayList<>();
        JsonObject config = readConfig();

        if (!config.has("skills")) {
            return result;
        }

        JsonObject skills = config.getAsJsonObject("skills");
        for (String key : skills.keySet()) {
            JsonObject skill = skills.getAsJsonObject(key);
            // 确保 ID 存在
            if (!skill.has("id")) {
                skill.addProperty("id", key);
            }
            result.add(skill);
        }

        System.out.println("[CodemossSettings] Loaded " + result.size() + " skills");
        return result;
    }

    /**
     * 添加或更新 Skill
     */
    public void upsertSkill(JsonObject skill) throws IOException {
        if (!skill.has("id")) {
            throw new IllegalArgumentException("Skill must have an id");
        }

        String id = skill.get("id").getAsString();

        // 验证 Skill 配置
        java.util.Map<String, Object> validation = validateSkill(skill);
        if (!(boolean) validation.get("valid")) {
            @SuppressWarnings("unchecked")
            List<String> errors = (List<String>) validation.get("errors");
            throw new IllegalArgumentException("Invalid skill configuration: " + String.join(", ", errors));
        }

        JsonObject config = readConfig();

        // 确保 skills 节点存在
        if (!config.has("skills")) {
            config.add("skills", new JsonObject());
        }

        JsonObject skills = config.getAsJsonObject("skills");

        // 添加或更新 Skill
        skills.add(id, skill);

        // 写入配置
        writeConfig(config);

        // 同步到 Claude settings
        syncSkillsToClaudeSettings();

        System.out.println("[CodemossSettings] Upserted skill: " + id);
    }

    /**
     * 删除 Skill
     */
    public boolean deleteSkill(String id) throws IOException {
        JsonObject config = readConfig();

        if (!config.has("skills")) {
            System.out.println("[CodemossSettings] No skills found");
            return false;
        }

        JsonObject skills = config.getAsJsonObject("skills");
        if (!skills.has(id)) {
            System.out.println("[CodemossSettings] Skill not found: " + id);
            return false;
        }

        // 删除 Skill
        skills.remove(id);

        // 写入配置
        writeConfig(config);

        // 同步到 Claude settings
        syncSkillsToClaudeSettings();

        System.out.println("[CodemossSettings] Deleted skill: " + id);
        return true;
    }

    /**
     * 验证 Skill 配置
     * Skills 是包含 SKILL.md 文件的文件夹，ID 必须是 hyphen-case 格式
     */
    public java.util.Map<String, Object> validateSkill(JsonObject skill) {
        List<String> errors = new ArrayList<>();

        // 验证 ID（必须是 hyphen-case：小写字母、数字、连字符）
        if (!skill.has("id") || skill.get("id").isJsonNull() ||
                skill.get("id").getAsString().trim().isEmpty()) {
            errors.add("Skill ID 不能为空");
        } else {
            String id = skill.get("id").getAsString();
            // Skill ID 格式：只允许小写字母、数字、连字符（hyphen-case）
            if (!id.matches("^[a-z0-9-]+$")) {
                errors.add("Skill ID 只能包含小写字母、数字和连字符（hyphen-case）");
            }
        }

        // 验证名称
        if (!skill.has("name") || skill.get("name").isJsonNull() ||
                skill.get("name").getAsString().trim().isEmpty()) {
            errors.add("Skill 名称不能为空");
        }

        // 验证路径（必须是包含 SKILL.md 的文件夹路径）
        if (!skill.has("path") || skill.get("path").isJsonNull() ||
                skill.get("path").getAsString().trim().isEmpty()) {
            errors.add("Skill 路径不能为空");
        }

        // 验证类型（目前只支持 local）
        if (skill.has("type") && !skill.get("type").isJsonNull()) {
            String type = skill.get("type").getAsString();
            if (!"local".equals(type)) {
                errors.add("不支持的 Skill 类型: " + type + "（目前只支持 local）");
            }
        }

        java.util.Map<String, Object> result = new java.util.HashMap<>();
        result.put("valid", errors.isEmpty());
        result.put("errors", errors);
        return result;
    }

    /**
     * 同步 Skills 到 Claude settings.json
     * 将启用的 Skills 转换为 SDK plugins 格式
     */
    public void syncSkillsToClaudeSettings() throws IOException {
        List<JsonObject> skills = getSkills();
        JsonObject claudeSettings = readClaudeSettings();

        // 构建 plugins 数组
        com.google.gson.JsonArray plugins = new com.google.gson.JsonArray();
        for (JsonObject skill : skills) {
            // 只同步启用的 Skills
            boolean enabled = !skill.has("enabled") || skill.get("enabled").isJsonNull() ||
                    skill.get("enabled").getAsBoolean();
            if (!enabled) {
                continue;
            }

            // 转换为 SDK 的 SdkPluginConfig 格式
            JsonObject plugin = new JsonObject();
            plugin.addProperty("type", "local");
            plugin.addProperty("path", skill.get("path").getAsString());
            plugins.add(plugin);
        }

        // 更新 plugins 字段
        claudeSettings.add("plugins", plugins);

        // 写入 Claude settings
        writeClaudeSettings(claudeSettings);

        System.out.println("[CodemossSettings] Synced " + plugins.size() + " enabled skills to Claude settings");
    }
}
