package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

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
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * CC Switch 配置文件服务
 * 用于读写 ~/.cc-switch/config.json
 */
public class CCSwitchSettingsService {

    private static final String CONFIG_DIR_NAME = ".cc-switch";
    private static final String CONFIG_FILE_NAME = "config.json";
    private static final String BACKUP_FILE_NAME = "config.json.bak";
    private static final int CONFIG_VERSION = 2;

    private static final String CLAUDE_DIR_NAME = ".claude";
    private static final String CLAUDE_SETTINGS_FILE_NAME = "settings.json";

    private final Gson gson;

    public CCSwitchSettingsService() {
        this.gson = new GsonBuilder().setPrettyPrinting().create();
    }

    /**
     * 获取配置文件路径
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
            System.out.println("[CCSwitchSettings] Created config directory: " + configDir);
        }
    }

    /**
     * 读取配置文件
     */
    public JsonObject readConfig() throws IOException {
        String configPath = getConfigPath();
        File configFile = new File(configPath);

        if (!configFile.exists()) {
            System.out.println("[CCSwitchSettings] Config file not found, creating default: " + configPath);
            return createDefaultConfig();
        }

        try (FileReader reader = new FileReader(configFile)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            System.out.println("[CCSwitchSettings] Successfully read config from: " + configPath);
            return config;
        } catch (Exception e) {
            System.err.println("[CCSwitchSettings] Failed to read config: " + e.getMessage());
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
            System.out.println("[CCSwitchSettings] Successfully wrote config to: " + configPath);
        } catch (Exception e) {
            System.err.println("[CCSwitchSettings] Failed to write config: " + e.getMessage());
            throw e;
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
            System.err.println("[CCSwitchSettings] Failed to read ~/.claude/settings.json: " + e.getMessage());
            return createDefaultClaudeSettings();
        }
    }

    private void writeClaudeSettings(JsonObject settings) throws IOException {
        Path settingsPath = getClaudeSettingsPath();
        Files.createDirectories(settingsPath.getParent());
        try (FileWriter writer = new FileWriter(settingsPath.toFile())) {
            gson.toJson(settings, writer);
            System.out.println("[CCSwitchSettings] Synced settings to: " + settingsPath);
        }
    }

    /**
     * 创建默认配置
     */
    private JsonObject createDefaultConfig() {
        JsonObject config = new JsonObject();
        config.addProperty("version", CONFIG_VERSION);

        // Claude 配置
        JsonObject claude = new JsonObject();
        JsonObject providers = new JsonObject();
        JsonObject defaultProvider = createDefaultProvider();
        providers.add("default", defaultProvider);
        claude.add("providers", providers);
        claude.addProperty("current", "default");

        config.add("claude", claude);

        return config;
    }

    /**
     * 创建默认供应商
     */
    private JsonObject createDefaultProvider() {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "default");
        provider.addProperty("name", "Claude官方");
        provider.addProperty("websiteUrl", "https://api.anthropic.com");
        provider.addProperty("category", "official");
        provider.addProperty("createdAt", System.currentTimeMillis());

        JsonObject settingsConfig = new JsonObject();
        JsonObject env = new JsonObject();
        env.addProperty("ANTHROPIC_AUTH_TOKEN", "");
        env.addProperty("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
        settingsConfig.add("env", env);

        provider.add("settingsConfig", settingsConfig);

        return provider;
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

        JsonObject envConfig = extractEnvConfig(provider);
        if (envConfig == null) {
            throw new IllegalArgumentException("Provider is missing env configuration");
        }

        JsonObject claudeSettings = readClaudeSettings();
        JsonObject claudeEnv = claudeSettings.has("env") && claudeSettings.get("env").isJsonObject()
            ? claudeSettings.getAsJsonObject("env")
            : new JsonObject();

        String apiKey = envConfig.has("ANTHROPIC_AUTH_TOKEN") && !envConfig.get("ANTHROPIC_AUTH_TOKEN").isJsonNull()
            ? envConfig.get("ANTHROPIC_AUTH_TOKEN").getAsString()
            : null;
        String baseUrl = envConfig.has("ANTHROPIC_BASE_URL") && !envConfig.get("ANTHROPIC_BASE_URL").isJsonNull()
            ? envConfig.get("ANTHROPIC_BASE_URL").getAsString()
            : null;

        setOrRemove(claudeEnv, "ANTHROPIC_AUTH_TOKEN", apiKey);
        setOrRemove(claudeEnv, "ANTHROPIC_API_KEY", apiKey);
        setOrRemove(claudeEnv, "ANTHROPIC_BASE_URL", baseUrl);

        claudeSettings.add("env", claudeEnv);

        if (provider.has("id") && !provider.get("id").isJsonNull()) {
            claudeSettings.addProperty("ccSwitchProviderId", provider.get("id").getAsString());
        }

        writeClaudeSettings(claudeSettings);
    }

    public void applyActiveProviderToClaudeSettings() throws IOException {
        JsonObject activeProvider = getActiveClaudeProvider();
        if (activeProvider == null) {
            throw new IllegalStateException("No active provider configured");
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

        // 添加供应商
        providers.add(id, provider);

        // 如果没有当前供应商，设置为新添加的
        if (!claude.has("current") || claude.get("current").getAsString().isEmpty()) {
            claude.addProperty("current", id);
        }

        writeConfig(config);
        System.out.println("[CCSwitchSettings] Added provider: " + id);
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
        System.out.println("[CCSwitchSettings] Updated provider: " + id);
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
                System.out.println("[CCSwitchSettings] Created backup: " + backupFilePath);
            } catch (IOException e) {
                System.err.println("[CCSwitchSettings] Warning: Failed to create backup: " + e.getMessage());
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
                    System.out.println("[CCSwitchSettings] Switched to provider: " + firstKey);
                } else {
                    claude.addProperty("current", "");
                    System.out.println("[CCSwitchSettings] No remaining providers");
                }
            }

            // 写入配置
            writeConfig(config);
            System.out.println("[CCSwitchSettings] Deleted provider: " + id);

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
                        System.out.println("[CCSwitchSettings] Restored from backup after failure");
                    }
                } catch (IOException restoreEx) {
                    System.err.println("[CCSwitchSettings] Failed to restore backup: " + restoreEx.getMessage());
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
        System.out.println("[CCSwitchSettings] Switched to provider: " + id);
    }

    /**
     * 备份配置文件
     */
    private void backupConfig() {
        try {
            String configPath = getConfigPath();
            String backupPath = getBackupPath();
            File configFile = new File(configPath);

            if (configFile.exists()) {
                Files.copy(configFile.toPath(), Paths.get(backupPath),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                System.out.println("[CCSwitchSettings] Backed up config to: " + backupPath);
            }
        } catch (Exception e) {
            System.err.println("[CCSwitchSettings] Failed to backup config: " + e.getMessage());
            // 备份失败不应该影响主流程
        }
    }

    /**
     * 初始化配置（确保配置文件存在）
     */
    public void initialize() throws IOException {
        String configPath = getConfigPath();
        File configFile = new File(configPath);

        if (!configFile.exists()) {
            System.out.println("[CCSwitchSettings] Initializing config file: " + configPath);
            JsonObject config = createDefaultConfig();
            writeConfig(config);
        }
    }
}
