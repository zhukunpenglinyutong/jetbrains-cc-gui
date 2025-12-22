package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.intellij.openapi.diagnostic.Logger;

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

    private static final Logger LOG = Logger.getInstance(CodemossSettingsService.class);
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
            LOG.info("[CodemossSettings] Created config directory: " + configDir);
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
            LOG.info("[CodemossSettings] Config file not found, creating default: " + configPath);
            return createDefaultConfig();
        }

        try (FileReader reader = new FileReader(configFile)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            LOG.info("[CodemossSettings] Successfully read config from: " + configPath);
            return config;
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to read config: " + e.getMessage());
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
            LOG.info("[CodemossSettings] Successfully wrote config to: " + configPath);
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to write config: " + e.getMessage());
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
            LOG.warn("[CodemossSettings] Failed to backup config: " + e.getMessage());
        }
    }

    /**
     * 同步 MCP 服务器配置到 Claude settings.json
     * Claude CLI 在运行时会从 ~/.claude/settings.json 读取MCP配置
     */
    private void syncMcpToClaudeSettings() throws IOException {
        try {
            String homeDir = System.getProperty("user.home");

            // 读取 ~/.claude.json
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (!claudeJsonFile.exists()) {
                return;
            }

            JsonObject claudeJson = JsonParser.parseReader(new FileReader(claudeJsonFile)).getAsJsonObject();

            // 读取 ~/.claude/settings.json
            JsonObject settings = readClaudeSettings();

            // 同步 mcpServers
            if (claudeJson.has("mcpServers")) {
                settings.add("mcpServers", claudeJson.get("mcpServers"));
            }

            // 同步 disabledMcpServers
            if (claudeJson.has("disabledMcpServers")) {
                settings.add("disabledMcpServers", claudeJson.get("disabledMcpServers"));
            }

            // 写回 settings.json
            writeClaudeSettings(settings);

            LOG.info("[CodemossSettings] Synced MCP configuration to ~/.claude/settings.json");
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to sync MCP to Claude settings: " + e.getMessage());
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
            LOG.warn("[CodemossSettings] Failed to read ~/.claude/settings.json: " + e.getMessage());
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

            // 兼容两种认证方式：优先 ANTHROPIC_AUTH_TOKEN，回退到 ANTHROPIC_API_KEY
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
            LOG.info("[CodemossSettings] Synced settings to: " + settingsPath);
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

    /**
     * 获取自定义工作目录配置
     * @param projectPath 项目根路径
     * @return 自定义工作目录，如果未配置则返回 null
     */
    public String getCustomWorkingDirectory(String projectPath) throws IOException {
        JsonObject config = readConfig();

        if (!config.has("workingDirectories") || config.get("workingDirectories").isJsonNull()) {
            return null;
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");

        if (workingDirs.has(projectPath) && !workingDirs.get(projectPath).isJsonNull()) {
            return workingDirs.get(projectPath).getAsString();
        }

        return null;
    }

    /**
     * 设置自定义工作目录
     * @param projectPath 项目根路径
     * @param customWorkingDir 自定义工作目录（相对于项目根路径或绝对路径）
     */
    public void setCustomWorkingDirectory(String projectPath, String customWorkingDir) throws IOException {
        JsonObject config = readConfig();

        // 确保 workingDirectories 节点存在
        if (!config.has("workingDirectories")) {
            config.add("workingDirectories", new JsonObject());
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");

        if (customWorkingDir == null || customWorkingDir.trim().isEmpty()) {
            // 如果传入空值，移除配置
            workingDirs.remove(projectPath);
        } else {
            // 设置自定义工作目录
            workingDirs.addProperty(projectPath, customWorkingDir.trim());
        }

        writeConfig(config);
        LOG.info("[CodemossSettings] Set custom working directory for " + projectPath + ": " + customWorkingDir);
    }

    /**
     * 获取所有工作目录配置
     * @return Map<projectPath, customWorkingDir>
     */
    public Map<String, String> getAllWorkingDirectories() throws IOException {
        Map<String, String> result = new HashMap<>();
        JsonObject config = readConfig();

        if (!config.has("workingDirectories") || config.get("workingDirectories").isJsonNull()) {
            return result;
        }

        JsonObject workingDirs = config.getAsJsonObject("workingDirectories");
        for (String key : workingDirs.keySet()) {
            result.put(key, workingDirs.get(key).getAsString());
        }

        return result;
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
        JsonObject oldClaudeSettings = readClaudeSettings();

        // 创建新的配置对象（完整替换，而不是合并）
        JsonObject claudeSettings = new JsonObject();

        // 1. 复制 settingsConfig 中的所有字段到新配置
        for (String key : settingsConfig.keySet()) {
            if (!settingsConfig.get(key).isJsonNull()) {
                claudeSettings.add(key, settingsConfig.get(key));
            }
        }

        // 2. 保留系统字段（这些字段不应该被供应商配置覆盖）
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

    public void applyActiveProviderToClaudeSettings() throws IOException {
        JsonObject activeProvider = getActiveClaudeProvider();
        if (activeProvider == null) {
            LOG.info("[CodemossSettings] No active provider to sync to .claude/settings.json");
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
        LOG.info("[CodemossSettings] Added provider: " + id + " (not activated, user needs to manually switch)");
    }

    /**
     * 保存供应商（如果存在则更新，不存在则添加）
     */
    public void saveClaudeProvider(JsonObject provider) throws IOException {
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

        // 如果已存在，保留原有的 createdAt
        if (providers.has(id)) {
            JsonObject existing = providers.getAsJsonObject(id);
            if (existing.has("createdAt") && !provider.has("createdAt")) {
                provider.addProperty("createdAt", existing.get("createdAt").getAsLong());
            }
        } else {
            if (!provider.has("createdAt")) {
                provider.addProperty("createdAt", System.currentTimeMillis());
            }
        }

        // 如果 provider 中没有 source 字段，但数据库中有，说明是更新（或者是转换）
        // 如果这是一个"转换"操作，provider 中显式删除了 source，那么这里添加时也不会有 source
        // 关键：provider 参数就是最终要保存的状态。
        
        // 覆盖保存
        providers.add(id, provider);
        writeConfig(config);
    }

    /**
     * 解析 cc-switch.db 中的供应商配置
     * 使用 Node.js 脚本读取数据库（跨平台兼容，避免 JDBC 类加载器问题）
     * @param dbPath db文件路径
     * @return 解析出的供应商列表
     */
    public List<JsonObject> parseProvidersFromCcSwitchDb(String dbPath) throws IOException {
        List<JsonObject> result = new ArrayList<>();

        LOG.info("[Backend] 正在通过 Node.js 读取 cc-switch 数据库: " + dbPath);

        // 获取 ai-bridge 目录路径（自动处理解压）
        String aiBridgePath = getAiBridgePath();
        String scriptPath = new File(aiBridgePath, "read-cc-switch-db.js").getAbsolutePath();

        LOG.info("[Backend] 脚本路径: " + scriptPath);

        // 检查脚本是否存在
        if (!new File(scriptPath).exists()) {
            throw new IOException("读取脚本不存在: " + scriptPath);
        }

        try {
            // 优先使用用户在设置页面配置的 Node.js 路径
            String nodePath = null;
            try {
                com.intellij.ide.util.PropertiesComponent props = com.intellij.ide.util.PropertiesComponent.getInstance();
                String savedNodePath = props.getValue("claude.code.node.path");
                if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                    // 验证用户配置的路径是否有效
                    File nodeFile = new File(savedNodePath.trim());
                    if (nodeFile.exists() && nodeFile.canExecute()) {
                        nodePath = savedNodePath.trim();
                        LOG.info("[Backend] 使用用户配置的 Node.js 路径: " + nodePath);
                    } else {
                        LOG.info("[Backend] 用户配置的 Node.js 路径无效，将自动检测: " + savedNodePath);
                    }
                }
            } catch (Exception e) {
                LOG.info("[Backend] 读取用户配置的 Node.js 路径失败: " + e.getMessage());
            }

            // 如果用户没有配置或配置无效，使用 NodeDetector 自动检测
            if (nodePath == null) {
                com.github.claudecodegui.bridge.NodeDetector nodeDetector = new com.github.claudecodegui.bridge.NodeDetector();
                nodePath = nodeDetector.findNodeExecutable();
                LOG.info("[Backend] 自动检测到的 Node.js 路径: " + nodePath);
            }

            // 构建 Node.js 命令
            ProcessBuilder pb = new ProcessBuilder(nodePath, scriptPath, dbPath);
            pb.directory(new File(aiBridgePath));
            pb.redirectErrorStream(true); // 合并错误输出到标准输出

            LOG.info("[Backend] 执行命令: " + nodePath + " " + scriptPath + " " + dbPath);

            // 启动进程
            Process process = pb.start();

            // 读取输出
            StringBuilder output = new StringBuilder();
            try (java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(process.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line);
                }
            }

            // 等待进程完成
            int exitCode = process.waitFor();

            String jsonOutput = output.toString();
            LOG.info("[Backend] Node.js 输出: " + jsonOutput);

            if (exitCode != 0) {
                throw new IOException("Node.js 脚本执行失败 (退出码: " + exitCode + "): " + jsonOutput);
            }

            // 解析 JSON 输出
            JsonObject response = gson.fromJson(jsonOutput, JsonObject.class);

            if (response == null || !response.has("success")) {
                throw new IOException("无效的 Node.js 脚本响应: " + jsonOutput);
            }

            if (!response.get("success").getAsBoolean()) {
                String errorMsg = response.has("error") ? response.get("error").getAsString() : "未知错误";
                throw new IOException("Node.js 脚本执行失败: " + errorMsg);
            }

            // 提取供应商列表
            if (response.has("providers")) {
                JsonArray providersArray = response.getAsJsonArray("providers");
                for (JsonElement element : providersArray) {
                    if (element.isJsonObject()) {
                        result.add(element.getAsJsonObject());
                    }
                }
            }

            int count = response.has("count") ? response.get("count").getAsInt() : result.size();
            LOG.info("[Backend] 成功从数据库读取 " + count + " 个 Claude 供应商配置");

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Node.js 脚本执行被中断", e);
        } catch (Exception e) {
            String errorMsg = "通过 Node.js 读取数据库失败: " + e.getMessage();
            LOG.warn("[Backend] " + errorMsg);
            LOG.error("Error occurred", e);
            throw new IOException(errorMsg, e);
        }

        return result;
    }

    /**
     * 获取 ai-bridge 目录路径（使用 BridgeDirectoryResolver 自动处理解压）
     */
    private String getAiBridgePath() throws IOException {
        com.github.claudecodegui.bridge.BridgeDirectoryResolver resolver =
                new com.github.claudecodegui.bridge.BridgeDirectoryResolver();

        File aiBridgeDir = resolver.findSdkDir();

        if (aiBridgeDir == null || !aiBridgeDir.exists()) {
            throw new IOException("无法找到 ai-bridge 目录，请检查插件安装");
        }

        LOG.info("[Backend] ai-bridge 目录: " + aiBridgeDir.getAbsolutePath());
        return aiBridgeDir.getAbsolutePath();
    }

    /**
     * 批量保存供应商配置
     * @param providers 供应商列表
     * @return 成功保存的数量
     */
    public int saveProviders(List<JsonObject> providers) throws IOException {
        int count = 0;
        for (JsonObject provider : providers) {
            try {
                saveClaudeProvider(provider);
                count++;
            } catch (Exception e) {
                LOG.warn("Failed to save provider " + provider.get("id") + ": " + e.getMessage());
            }
        }
        return count;
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
            
            // 如果值为 null (JsonNull)，则删除该字段
            if (updates.get(key).isJsonNull()) {
                provider.remove(key);
            } else {
                provider.add(key, updates.get(key));
            }
        }

        writeConfig(config);
        LOG.info("[CodemossSettings] Updated provider: " + id);
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
                LOG.info("[CodemossSettings] Created backup: " + backupFilePath);
            } catch (IOException e) {
                LOG.warn("[CodemossSettings] Warning: Failed to create backup: " + e.getMessage());
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
                    LOG.info("[CodemossSettings] Switched to provider: " + firstKey);
                } else {
                    claude.addProperty("current", "");
                    LOG.info("[CodemossSettings] No remaining providers");
                }
            }

            // 写入配置
            writeConfig(config);
            LOG.info("[CodemossSettings] Deleted provider: " + id);

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
                        LOG.info("[CodemossSettings] Restored from backup after failure");
                    }
                } catch (IOException restoreEx) {
                    LOG.warn("[CodemossSettings] Failed to restore backup: " + restoreEx.getMessage());
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
        LOG.info("[CodemossSettings] Switched to provider: " + id);
    }

    /**
     * 获取所有 MCP 服务器
     * 优先从 ~/.claude.json 读取（Claude CLI 标准位置）
     * 回退到 ~/.codemoss/config.json
     */
    public List<JsonObject> getMcpServers() throws IOException {
        List<JsonObject> result = new ArrayList<>();

        // 1. 尝试从 ~/.claude.json 读取（Claude CLI 标准位置）
        try {
            String homeDir = System.getProperty("user.home");
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    if (claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()) {
                        JsonObject mcpServers = claudeJson.getAsJsonObject("mcpServers");

                        // 读取禁用的服务器列表
                        java.util.Set<String> disabledServers = new java.util.HashSet<>();
                        if (claudeJson.has("disabledMcpServers") && claudeJson.get("disabledMcpServers").isJsonArray()) {
                            JsonArray disabledArray = claudeJson.getAsJsonArray("disabledMcpServers");
                            for (JsonElement elem : disabledArray) {
                                if (elem.isJsonPrimitive()) {
                                    disabledServers.add(elem.getAsString());
                                }
                            }
                        }

                        // 将对象格式转换为列表格式
                        for (String serverId : mcpServers.keySet()) {
                            JsonElement serverElem = mcpServers.get(serverId);
                            if (serverElem.isJsonObject()) {
                                JsonObject server = serverElem.getAsJsonObject();

                                // 确保有 id 和 name 字段
                                if (!server.has("id")) {
                                    server.addProperty("id", serverId);
                                }
                                if (!server.has("name")) {
                                    server.addProperty("name", serverId);
                                }

                                // 将 type, command, args, env 等包装到 server 字段中
                                if (!server.has("server")) {
                                    JsonObject serverSpec = new JsonObject();

                                    // 复制相关字段到 server 规格
                                    if (server.has("type")) {
                                        serverSpec.add("type", server.get("type"));
                                    }
                                    if (server.has("command")) {
                                        serverSpec.add("command", server.get("command"));
                                    }
                                    if (server.has("args")) {
                                        serverSpec.add("args", server.get("args"));
                                    }
                                    if (server.has("env")) {
                                        serverSpec.add("env", server.get("env"));
                                    }
                                    if (server.has("url")) {
                                        serverSpec.add("url", server.get("url"));
                                    }

                                    server.add("server", serverSpec);
                                }

                                // 设置启用/禁用状态
                                boolean isEnabled = !disabledServers.contains(serverId);
                                server.addProperty("enabled", isEnabled);

                                result.add(server);
                            }
                        }

                        LOG.info("[CodemossSettings] Loaded " + result.size() + " MCP servers from ~/.claude.json (disabled: " + disabledServers.size() + ")");
                        return result;
                    }
                } catch (Exception e) {
                    LOG.warn("[CodemossSettings] Failed to read ~/.claude.json: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Error accessing ~/.claude.json: " + e.getMessage());
        }

        // 2. 回退到 ~/.codemoss/config.json（数组格式）
        JsonObject config = readConfig();
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
            for (JsonElement elem : servers) {
                if (elem.isJsonObject()) {
                    result.add(elem.getAsJsonObject());
                }
            }
        }

        LOG.info("[CodemossSettings] Loaded " + result.size() + " MCP servers from ~/.codemoss/config.json");
        return result;
    }

    /**
     * 更新或插入 MCP 服务器
     * 优先更新 ~/.claude.json（Claude CLI 标准位置）
     * 回退到 ~/.codemoss/config.json
     */
    public void upsertMcpServer(JsonObject server) throws IOException {
        if (!server.has("id")) {
            throw new IllegalArgumentException("Server must have an id");
        }

        String serverId = server.get("id").getAsString();
        boolean isEnabled = !server.has("enabled") || server.get("enabled").getAsBoolean();

        // 1. 尝试更新 ~/.claude.json
        try {
            String homeDir = System.getProperty("user.home");
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    // 确保 mcpServers 对象存在
                    if (!claudeJson.has("mcpServers") || !claudeJson.get("mcpServers").isJsonObject()) {
                        claudeJson.add("mcpServers", new JsonObject());
                    }
                    JsonObject mcpServers = claudeJson.getAsJsonObject("mcpServers");

                    // 提取 server 规格
                    JsonObject serverSpec;
                    if (server.has("server") && server.get("server").isJsonObject()) {
                        serverSpec = server.getAsJsonObject("server").deepCopy();
                    } else {
                        serverSpec = new JsonObject();
                    }

                    // 更新或添加服务器
                    mcpServers.add(serverId, serverSpec);

                    // 更新 disabledMcpServers 列表
                    if (!claudeJson.has("disabledMcpServers") || !claudeJson.get("disabledMcpServers").isJsonArray()) {
                        claudeJson.add("disabledMcpServers", new JsonArray());
                    }
                    JsonArray disabledArray = claudeJson.getAsJsonArray("disabledMcpServers");

                    // 移除旧的禁用状态
                    JsonArray newDisabled = new JsonArray();
                    for (JsonElement elem : disabledArray) {
                        if (!elem.getAsString().equals(serverId)) {
                            newDisabled.add(elem);
                        }
                    }

                    // 如果禁用，添加到禁用列表
                    if (!isEnabled) {
                        newDisabled.add(serverId);
                    }

                    claudeJson.add("disabledMcpServers", newDisabled);

                    // 写回文件
                    try (FileWriter writer = new FileWriter(claudeJsonFile)) {
                        gson.toJson(claudeJson, writer);
                        LOG.info("[CodemossSettings] Upserted MCP server in ~/.claude.json: " + serverId + " (enabled: " + isEnabled + ")");

                        // 同步到 settings.json
                        syncMcpToClaudeSettings();

                        return;
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Error updating ~/.claude.json: " + e.getMessage());
        }

        // 2. 回退到 ~/.codemoss/config.json
        JsonObject config = readConfig();
        JsonArray servers;

        if (config.has("mcpServers")) {
            servers = config.getAsJsonArray("mcpServers");
        } else {
            servers = new JsonArray();
            config.add("mcpServers", servers);
        }

        boolean found = false;

        // 查找并更新
        for (int i = 0; i < servers.size(); i++) {
            JsonObject s = servers.get(i).getAsJsonObject();
            if (s.has("id") && s.get("id").getAsString().equals(serverId)) {
                servers.set(i, server); // 替换
                found = true;
                break;
            }
        }

        if (!found) {
            servers.add(server);
        }

        writeConfig(config);
        LOG.info("[CodemossSettings] Upserted MCP server in ~/.codemoss/config.json: " + serverId);
    }

    /**
     * 删除 MCP 服务器
     * 优先从 ~/.claude.json 删除（Claude CLI 标准位置）
     * 回退到 ~/.codemoss/config.json
     */
    public boolean deleteMcpServer(String serverId) throws IOException {
        boolean removed = false;

        // 1. 尝试从 ~/.claude.json 删除
        try {
            String homeDir = System.getProperty("user.home");
            Path claudeJsonPath = Paths.get(homeDir, ".claude.json");
            File claudeJsonFile = claudeJsonPath.toFile();

            if (claudeJsonFile.exists()) {
                try (FileReader reader = new FileReader(claudeJsonFile)) {
                    JsonObject claudeJson = JsonParser.parseReader(reader).getAsJsonObject();

                    if (claudeJson.has("mcpServers") && claudeJson.get("mcpServers").isJsonObject()) {
                        JsonObject mcpServers = claudeJson.getAsJsonObject("mcpServers");

                        if (mcpServers.has(serverId)) {
                            // 删除服务器
                            mcpServers.remove(serverId);

                            // 同时从 disabledMcpServers 中移除（如果存在）
                            if (claudeJson.has("disabledMcpServers") && claudeJson.get("disabledMcpServers").isJsonArray()) {
                                JsonArray disabledServers = claudeJson.getAsJsonArray("disabledMcpServers");
                                JsonArray newDisabled = new JsonArray();
                                for (JsonElement elem : disabledServers) {
                                    if (!elem.getAsString().equals(serverId)) {
                                        newDisabled.add(elem);
                                    }
                                }
                                claudeJson.add("disabledMcpServers", newDisabled);
                            }

                            // 写回文件
                            try (FileWriter writer = new FileWriter(claudeJsonFile)) {
                                gson.toJson(claudeJson, writer);
                                LOG.info("[CodemossSettings] Deleted MCP server from ~/.claude.json: " + serverId);

                                // 同步到 settings.json
                                syncMcpToClaudeSettings();

                                removed = true;
                                return true;
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Error deleting from ~/.claude.json: " + e.getMessage());
        }

        // 2. 回退到 ~/.codemoss/config.json
        JsonObject config = readConfig();
        if (config.has("mcpServers")) {
            JsonArray servers = config.getAsJsonArray("mcpServers");
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
                LOG.info("[CodemossSettings] Deleted MCP server from ~/.codemoss/config.json: " + serverId);
            }
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
                        new java.net.URI(url).toURL();
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

        LOG.info("[CodemossSettings] Loaded " + result.size() + " skills");
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

        LOG.info("[CodemossSettings] Upserted skill: " + id);
    }

    /**
     * 删除 Skill
     */
    public boolean deleteSkill(String id) throws IOException {
        JsonObject config = readConfig();

        if (!config.has("skills")) {
            LOG.info("[CodemossSettings] No skills found");
            return false;
        }

        JsonObject skills = config.getAsJsonObject("skills");
        if (!skills.has(id)) {
            LOG.info("[CodemossSettings] Skill not found: " + id);
            return false;
        }

        // 删除 Skill
        skills.remove(id);

        // 写入配置
        writeConfig(config);

        // 同步到 Claude settings
        syncSkillsToClaudeSettings();

        LOG.info("[CodemossSettings] Deleted skill: " + id);
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

        LOG.info("[CodemossSettings] Synced " + plugins.size() + " enabled skills to Claude settings");
    }
}
