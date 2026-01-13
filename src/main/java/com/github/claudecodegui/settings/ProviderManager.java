package com.github.claudecodegui.settings;

import com.github.claudecodegui.ClaudeCodeGuiBundle;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.model.DeleteResult;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * Provider 管理器
 * 负责管理 Claude 供应商配置
 */
public class ProviderManager {
    private static final Logger LOG = Logger.getInstance(ProviderManager.class);
    private static final String BACKUP_FILE_NAME = "config.json.bak";
    public static final String LOCAL_SETTINGS_PROVIDER_ID = "__local_settings_json__";

    private final Gson gson;
    private final Function<Void, JsonObject> configReader;
    private final java.util.function.Consumer<JsonObject> configWriter;
    private final ConfigPathManager pathManager;
    private final ClaudeSettingsManager claudeSettingsManager;

    public ProviderManager(
            Gson gson,
            Function<Void, JsonObject> configReader,
            java.util.function.Consumer<JsonObject> configWriter,
            ConfigPathManager pathManager,
            ClaudeSettingsManager claudeSettingsManager) {
        this.gson = gson;
        this.configReader = configReader;
        this.configWriter = configWriter;
        this.pathManager = pathManager;
        this.claudeSettingsManager = claudeSettingsManager;
    }

    /**
     * 获取所有Claude供应商
     */
    public List<JsonObject> getClaudeProviders() {
        JsonObject config = configReader.apply(null);
        List<JsonObject> result = new ArrayList<>();

        if (!config.has("claude")) {
            JsonObject claude = new JsonObject();
            claude.add("providers", new JsonObject());
            claude.addProperty("current", "");
            config.add("claude", claude);
        }

        JsonObject claude = config.getAsJsonObject("claude");
        String currentId = claude.has("current") ? claude.get("current").getAsString() : null;

        // Add local provider using the extracted method
        result.add(createLocalProviderObject(LOCAL_SETTINGS_PROVIDER_ID.equals(currentId)));

        if (!claude.has("providers")) {
            return result;
        }

        JsonObject providers = claude.getAsJsonObject("providers");

        for (String key : providers.keySet()) {
            JsonObject provider = providers.getAsJsonObject(key);
            if (!provider.has("id")) {
                provider.addProperty("id", key);
            }
            provider.addProperty("isActive", key.equals(currentId));
            result.add(provider);
        }

        return result;
    }

    /**
     * 获取当前激活的供应商
     */
    public JsonObject getActiveClaudeProvider() {
        JsonObject config = configReader.apply(null);

        if (!config.has("claude")) {
            return null;
        }

        JsonObject claude = config.getAsJsonObject("claude");
        String currentId = claude.has("current") ? claude.get("current").getAsString() : null;

        // Return local provider using the extracted method
        if (LOCAL_SETTINGS_PROVIDER_ID.equals(currentId)) {
            return createLocalProviderObject(true);
        }

        if (!claude.has("providers")) {
            return null;
        }

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

    /**
     * 添加供应商
     */
    public void addClaudeProvider(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }

        JsonObject config = configReader.apply(null);

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

        // 添加供应商(不自动设为 current,用户需要手动点击"启用"按钮来激活)
        providers.add(id, provider);

        configWriter.accept(config);
        LOG.info("[ProviderManager] Added provider: " + id + " (not activated, user needs to manually switch)");
    }

    /**
     * 保存供应商(如果存在则更新,不存在则添加)
     */
    public void saveClaudeProvider(JsonObject provider) throws IOException {
        if (!provider.has("id")) {
            throw new IllegalArgumentException("Provider must have an id");
        }

        JsonObject config = configReader.apply(null);

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

        // 如果已存在,保留原有的 createdAt
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

        // 覆盖保存
        providers.add(id, provider);
        configWriter.accept(config);
    }

    /**
     * 更新供应商
     */
    public void updateClaudeProvider(String id, JsonObject updates) throws IOException {
        JsonObject config = configReader.apply(null);

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

            // 如果值为 null (JsonNull),则删除该字段
            if (updates.get(key).isJsonNull()) {
                provider.remove(key);
            } else {
                provider.add(key, updates.get(key));
            }
        }

        configWriter.accept(config);
        LOG.info("[ProviderManager] Updated provider: " + id);
    }

    /**
     * 删除供应商(返回 DeleteResult 提供详细错误信息)
     * @param id 供应商 ID
     * @return DeleteResult 包含操作结果和错误详情
     */
    public DeleteResult deleteClaudeProvider(String id) {
        Path configFilePath = null;
        Path backupFilePath = null;

        try {
            JsonObject config = configReader.apply(null);
            configFilePath = pathManager.getConfigFilePath();
            backupFilePath = pathManager.getConfigDir().resolve(BACKUP_FILE_NAME);

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

            // 创建配置备份(用于回滚)
            try {
                Files.copy(configFilePath, backupFilePath, StandardCopyOption.REPLACE_EXISTING);
                LOG.info("[ProviderManager] Created backup: " + backupFilePath);
            } catch (IOException e) {
                LOG.warn("[ProviderManager] Warning: Failed to create backup: " + e.getMessage());
                // 备份失败不阻止删除操作,但记录警告
            }

            // 删除供应商
            providers.remove(id);

            // 如果删除的是当前激活的供应商,切换到第一个可用的供应商
            String currentId = claude.has("current") ? claude.get("current").getAsString() : null;
            if (id.equals(currentId)) {
                if (providers.size() > 0) {
                    String firstKey = providers.keySet().iterator().next();
                    claude.addProperty("current", firstKey);
                    LOG.info("[ProviderManager] Switched to provider: " + firstKey);
                } else {
                    claude.addProperty("current", "");
                    LOG.info("[ProviderManager] No remaining providers");
                }
            }

            // 写入配置
            configWriter.accept(config);
            LOG.info("[ProviderManager] Deleted provider: " + id);

            // 删除成功后移除备份
            try {
                Files.deleteIfExists(backupFilePath);
            } catch (IOException e) {
                // 忽略备份文件删除失败
            }

            return DeleteResult.success(id);

        } catch (Exception e) {
            // 尝试从备份恢复
            if (backupFilePath != null && configFilePath != null) {
                try {
                    if (Files.exists(backupFilePath)) {
                        Files.copy(backupFilePath, configFilePath, StandardCopyOption.REPLACE_EXISTING);
                        LOG.info("[ProviderManager] Restored from backup after failure");
                    }
                } catch (IOException restoreEx) {
                    LOG.warn("[ProviderManager] Failed to restore backup: " + restoreEx.getMessage());
                }
            }

            return DeleteResult.fromException(e, configFilePath != null ? configFilePath.toString() : null);
        }
    }

    /**
     * 切换供应商
     */
    public void switchClaudeProvider(String id) throws IOException {
        JsonObject config = configReader.apply(null);

        if (!config.has("claude")) {
            throw new IllegalArgumentException("No claude configuration found");
        }

        JsonObject claude = config.getAsJsonObject("claude");
        JsonObject providers = claude.getAsJsonObject("providers");

        if (!providers.has(id)) {
            throw new IllegalArgumentException("Provider with id '" + id + "' not found");
        }

        claude.addProperty("current", id);
        configWriter.accept(config);
        LOG.info("[ProviderManager] Switched to provider: " + id);
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
     * 设置 alwaysThinkingEnabled 在当前激活的供应商中
     */
    public boolean setAlwaysThinkingEnabledInActiveProvider(boolean enabled) throws IOException {
        JsonObject config = configReader.apply(null);
        if (!config.has("claude") || config.get("claude").isJsonNull()) {
            return false;
        }

        JsonObject claude = config.getAsJsonObject("claude");
        if (!claude.has("current") || claude.get("current").isJsonNull()) {
            return false;
        }

        String currentId = claude.get("current").getAsString();
        if (currentId == null || currentId.trim().isEmpty()) {
            return false;
        }

        if (!claude.has("providers") || claude.get("providers").isJsonNull()) {
            return false;
        }

        JsonObject providers = claude.getAsJsonObject("providers");
        if (!providers.has(currentId) || providers.get(currentId).isJsonNull()) {
            return false;
        }

        JsonObject provider = providers.getAsJsonObject(currentId);
        JsonObject settingsConfig;
        if (provider.has("settingsConfig") && provider.get("settingsConfig").isJsonObject()) {
            settingsConfig = provider.getAsJsonObject("settingsConfig");
        } else {
            settingsConfig = new JsonObject();
            provider.add("settingsConfig", settingsConfig);
        }

        settingsConfig.addProperty("alwaysThinkingEnabled", enabled);
        configWriter.accept(config);
        return true;
    }

    /**
     * 应用激活的供应商到 Claude settings.json
     */
    public void applyActiveProviderToClaudeSettings() throws IOException {
        JsonObject config = configReader.apply(null);

        if (config.has("claude") &&
            config.getAsJsonObject("claude").has("current") &&
            LOCAL_SETTINGS_PROVIDER_ID.equals(config.getAsJsonObject("claude").get("current").getAsString())) {
            LOG.info("[ProviderManager] Local settings.json provider active, skipping sync to settings.json");
            return;
        }

        JsonObject activeProvider = getActiveClaudeProvider();
        if (activeProvider == null) {
            LOG.info("[ProviderManager] No active provider to sync to .claude/settings.json");
            return;
        }
        claudeSettingsManager.applyProviderToClaudeSettings(activeProvider);
    }

    /**
     * 解析 cc-switch.db 中的供应商配置
     * 使用 Node.js 脚本读取数据库(跨平台兼容,避免 JDBC 类加载器问题)
     * @param dbPath db文件路径
     * @return 解析出的供应商列表
     */
    public List<JsonObject> parseProvidersFromCcSwitchDb(String dbPath) throws IOException {
        List<JsonObject> result = new ArrayList<>();

        LOG.info("[ProviderManager] 正在通过 Node.js 读取 cc-switch 数据库: " + dbPath);

        // 获取 ai-bridge 目录路径(自动处理解压)
        String aiBridgePath = getAiBridgePath();
        String scriptPath = new File(aiBridgePath, "read-cc-switch-db.js").getAbsolutePath();

        LOG.info("[ProviderManager] 脚本路径: " + scriptPath);

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
                        LOG.info("[ProviderManager] 使用用户配置的 Node.js 路径: " + nodePath);
                    } else {
                        LOG.info("[ProviderManager] 用户配置的 Node.js 路径无效,将自动检测: " + savedNodePath);
                    }
                }
            } catch (Exception e) {
                LOG.info("[ProviderManager] 读取用户配置的 Node.js 路径失败: " + e.getMessage());
            }

            // 如果用户没有配置或配置无效,使用 NodeDetector 自动检测
            if (nodePath == null) {
                NodeDetector nodeDetector = new NodeDetector();
                nodePath = nodeDetector.findNodeExecutable();
                LOG.info("[ProviderManager] 自动检测到的 Node.js 路径: " + nodePath);
            }

            // 构建 Node.js 命令
            ProcessBuilder pb = new ProcessBuilder(nodePath, scriptPath, dbPath);
            pb.directory(new File(aiBridgePath));
            pb.redirectErrorStream(true); // 合并错误输出到标准输出

            LOG.info("[ProviderManager] 执行命令: " + nodePath + " " + scriptPath + " " + dbPath);

            // 启动进程
            Process process = pb.start();

            // 读取输出
            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line);
                }
            }

            // 等待进程完成
            int exitCode = process.waitFor();

            String jsonOutput = output.toString();
            LOG.info("[ProviderManager] Node.js 输出: " + jsonOutput);

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
            LOG.info("[ProviderManager] 成功从数据库读取 " + count + " 个 Claude 供应商配置");

        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Node.js 脚本执行被中断", e);
        } catch (Exception e) {
            String errorMsg = "通过 Node.js 读取数据库失败: " + e.getMessage();
            LOG.warn("[ProviderManager] " + errorMsg);
            LOG.error("Error occurred", e);
            throw new IOException(errorMsg, e);
        }

        return result;
    }

    /**
     * 获取 ai-bridge 目录路径(使用 BridgeDirectoryResolver 自动处理解压)
     */
    private String getAiBridgePath() throws IOException {
        // 使用共享的 BridgeDirectoryResolver 实例，以便正确检测解压状态
        com.github.claudecodegui.bridge.BridgeDirectoryResolver resolver =
                com.github.claudecodegui.startup.BridgePreloader.getSharedResolver();

        File aiBridgeDir = resolver.findSdkDir();

        // 如果返回 null，可能是正在后台解压中，等待解压完成
        if (aiBridgeDir == null) {
            if (resolver.isExtractionInProgress()) {
                LOG.info("[ProviderManager] ai-bridge 正在解压中，等待完成...");
                try {
                    // 等待解压完成（最多等待 60 秒）
                    Boolean ready = resolver.getExtractionFuture().get(60, java.util.concurrent.TimeUnit.SECONDS);
                    if (ready != null && ready) {
                        aiBridgeDir = resolver.getSdkDir();
                    }
                } catch (java.util.concurrent.TimeoutException e) {
                    throw new IOException("ai-bridge 解压超时，请稍后重试", e);
                } catch (Exception e) {
                    throw new IOException("等待 ai-bridge 解压时发生错误: " + e.getMessage(), e);
                }
            }
        }

        if (aiBridgeDir == null || !aiBridgeDir.exists()) {
            throw new IOException("无法找到 ai-bridge 目录,请检查插件安装");
        }

        LOG.info("[ProviderManager] ai-bridge 目录: " + aiBridgeDir.getAbsolutePath());
        return aiBridgeDir.getAbsolutePath();
    }

    /**
     * 提取环境配置
     */
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

    /**
     * Create local provider object with internationalized name and description
     * @param isActive whether this provider is currently active
     * @return JsonObject representing the local provider
     */
    private JsonObject createLocalProviderObject(boolean isActive) {
        JsonObject localProvider = new JsonObject();
        localProvider.addProperty("id", LOCAL_SETTINGS_PROVIDER_ID);
        localProvider.addProperty("name", ClaudeCodeGuiBundle.message("provider.local.name"));
        localProvider.addProperty("isActive", isActive);
        localProvider.addProperty("isLocalProvider", true);
        return localProvider;
    }

    public boolean isLocalSettingsProvider(String providerId) {
        return LOCAL_SETTINGS_PROVIDER_ID.equals(providerId);
    }

    public boolean isLocalProviderActive() {
        JsonObject config = configReader.apply(null);
        if (!config.has("claude")) {
            return false;
        }
        JsonObject claude = config.getAsJsonObject("claude");
        if (!claude.has("current")) {
            return false;
        }
        return LOCAL_SETTINGS_PROVIDER_ID.equals(claude.get("current").getAsString());
    }
}
