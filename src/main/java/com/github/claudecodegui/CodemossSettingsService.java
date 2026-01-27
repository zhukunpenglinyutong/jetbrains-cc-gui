package com.github.claudecodegui;

import com.github.claudecodegui.model.DeleteResult;
import com.github.claudecodegui.settings.*;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Map;

/**
 * Codemoss 配置文件服务(门面模式)
 * 委托具体功能给各个专门的 Manager
 */
public class CodemossSettingsService {

    private static final Logger LOG = Logger.getInstance(CodemossSettingsService.class);
    private static final int CONFIG_VERSION = 2;

    private final Gson gson;

    // Managers
    private final ConfigPathManager pathManager;
    private final ClaudeSettingsManager claudeSettingsManager;
    private final CodexSettingsManager codexSettingsManager;
    private final CodexMcpServerManager codexMcpServerManager;
    private final WorkingDirectoryManager workingDirectoryManager;
    private final AgentManager agentManager;
    private final SkillManager skillManager;
    private final McpServerManager mcpServerManager;
    private final ProviderManager providerManager;
    private final CodexProviderManager codexProviderManager;

    public CodemossSettingsService() {
        this.gson = new GsonBuilder().setPrettyPrinting().serializeNulls().create();

        // 初始化 ConfigPathManager
        this.pathManager = new ConfigPathManager();

        // 初始化 ClaudeSettingsManager
        this.claudeSettingsManager = new ClaudeSettingsManager(gson, pathManager);

        // 初始化 WorkingDirectoryManager
        this.workingDirectoryManager = new WorkingDirectoryManager(
            (ignored) -> {
                try {
                    return readConfig();
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            (config) -> {
                try {
                    writeConfig(config);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            }
        );

        // 初始化 AgentManager
        this.agentManager = new AgentManager(gson, pathManager);

        // 初始化 SkillManager
        this.skillManager = new SkillManager(
            (ignored) -> {
                try {
                    return readConfig();
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            (config) -> {
                try {
                    writeConfig(config);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            claudeSettingsManager
        );

        // 初始化 McpServerManager
        this.mcpServerManager = new McpServerManager(
            gson,
            (ignored) -> {
                try {
                    return readConfig();
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            (config) -> {
                try {
                    writeConfig(config);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            claudeSettingsManager
        );

        // 初始化 ProviderManager
        this.providerManager = new ProviderManager(
            gson,
            (ignored) -> {
                try {
                    return readConfig();
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            (config) -> {
                try {
                    writeConfig(config);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            pathManager,
            claudeSettingsManager
        );

        // 初始化 CodexSettingsManager
        this.codexSettingsManager = new CodexSettingsManager(gson);

        // 初始化 CodexMcpServerManager
        this.codexMcpServerManager = new CodexMcpServerManager(codexSettingsManager);

        // 初始化 CodexProviderManager
        this.codexProviderManager = new CodexProviderManager(
            gson,
            (ignored) -> {
                try {
                    return readConfig();
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            (config) -> {
                try {
                    writeConfig(config);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            },
            pathManager,
            codexSettingsManager
        );
    }

    // ==================== 基础配置管理 ====================

    /**
     * 获取配置文件路径 (~/.codemoss/config.json)
     */
    public String getConfigPath() {
        return pathManager.getConfigPath();
    }

    /**
     * 读取配置文件
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
        pathManager.ensureConfigDirectory();

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
            Path configPath = pathManager.getConfigFilePath();
            if (Files.exists(configPath)) {
                Files.copy(configPath, Paths.get(pathManager.getBackupPath()), StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to backup config: " + e.getMessage());
        }
    }

    /**
     * 创建默认配置
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

    // ==================== Claude Settings 管理 ====================

    public JsonObject getCurrentClaudeConfig() throws IOException {
        JsonObject currentConfig = claudeSettingsManager.getCurrentClaudeConfig();

        // 如果有 codemossProviderId,尝试从 codemoss 配置中获取供应商名称
        if (currentConfig.has("providerId")) {
            String providerId = currentConfig.get("providerId").getAsString();
            try {
                JsonObject config = readConfig();
                if (config.has("claude")) {
                    JsonObject claude = config.getAsJsonObject("claude");
                    if (claude.has("providers")) {
                        JsonObject providers = claude.getAsJsonObject("providers");
                        if (providers.has(providerId)) {
                            JsonObject provider = providers.getAsJsonObject(providerId);
                            if (provider.has("name")) {
                                currentConfig.addProperty("providerName", provider.get("name").getAsString());
                            }
                        }
                    }
                }
            } catch (Exception e) {
                // 忽略错误,供应商名称是可选的
            }
        }

        return currentConfig;
    }

    public Boolean getAlwaysThinkingEnabledFromClaudeSettings() throws IOException {
        return claudeSettingsManager.getAlwaysThinkingEnabled();
    }

    public void setAlwaysThinkingEnabledInClaudeSettings(boolean enabled) throws IOException {
        claudeSettingsManager.setAlwaysThinkingEnabled(enabled);
    }

    public boolean setAlwaysThinkingEnabledInActiveProvider(boolean enabled) throws IOException {
        return providerManager.setAlwaysThinkingEnabledInActiveProvider(enabled);
    }

    public void applyProviderToClaudeSettings(JsonObject provider) throws IOException {
        claudeSettingsManager.applyProviderToClaudeSettings(provider);
    }

    public void applyActiveProviderToClaudeSettings() throws IOException {
        providerManager.applyActiveProviderToClaudeSettings();
    }

    // ==================== Working Directory 管理 ====================

    public String getCustomWorkingDirectory(String projectPath) throws IOException {
        return workingDirectoryManager.getCustomWorkingDirectory(projectPath);
    }

    public void setCustomWorkingDirectory(String projectPath, String customWorkingDir) throws IOException {
        workingDirectoryManager.setCustomWorkingDirectory(projectPath, customWorkingDir);
    }

    public Map<String, String> getAllWorkingDirectories() throws IOException {
        return workingDirectoryManager.getAllWorkingDirectories();
    }

    // ==================== Commit Prompt 配置管理 ====================

    /**
     * 获取 commit AI 提示词
     * @return commit 提示词
     */
    public String getCommitPrompt() throws IOException {
        JsonObject config = readConfig();

        // 检查是否有 commitPrompt 配置
        if (config.has("commitPrompt")) {
            return config.get("commitPrompt").getAsString();
        }

        // 返回默认值（从 i18n 资源包获取）
        return ClaudeCodeGuiBundle.message("commit.defaultPrompt");
    }

    /**
     * 设置 commit AI 提示词
     * @param prompt commit 提示词
     */
    public void setCommitPrompt(String prompt) throws IOException {
        JsonObject config = readConfig();

        // 保存配置
        config.addProperty("commitPrompt", prompt);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set commit prompt: " + prompt);
    }

    // ==================== 🔧 Streaming 配置管理 ====================

    /**
     * 获取流式传输配置
     * @param projectPath 项目路径
     * @return 是否启用流式传输
     */
    public boolean getStreamingEnabled(String projectPath) throws IOException {
        JsonObject config = readConfig();

        // 检查是否有 streaming 配置
        if (!config.has("streaming")) {
            return true;
        }

        JsonObject streaming = config.getAsJsonObject("streaming");

        // 先检查项目特定的配置
        if (projectPath != null && streaming.has(projectPath)) {
            return streaming.get(projectPath).getAsBoolean();
        }

        // 如果没有项目特定的配置，使用全局默认值
        if (streaming.has("default")) {
            return streaming.get("default").getAsBoolean();
        }

        return true;
    }

    /**
     * 设置流式传输配置
     * @param projectPath 项目路径
     * @param enabled 是否启用
     */
    public void setStreamingEnabled(String projectPath, boolean enabled) throws IOException {
        JsonObject config = readConfig();

        // 确保 streaming 对象存在
        JsonObject streaming;
        if (config.has("streaming")) {
            streaming = config.getAsJsonObject("streaming");
        } else {
            streaming = new JsonObject();
            config.add("streaming", streaming);
        }

        // 保存项目特定配置（同时也作为默认值）
        if (projectPath != null) {
            streaming.addProperty(projectPath, enabled);
        }
        streaming.addProperty("default", enabled);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set streaming enabled to " + enabled + " for project: " + projectPath);
    }

    // ==================== Provider 管理 ====================

    public List<JsonObject> getClaudeProviders() throws IOException {
        return providerManager.getClaudeProviders();
    }

    public JsonObject getActiveClaudeProvider() throws IOException {
        return providerManager.getActiveClaudeProvider();
    }

    public void addClaudeProvider(JsonObject provider) throws IOException {
        providerManager.addClaudeProvider(provider);
    }

    public void saveClaudeProvider(JsonObject provider) throws IOException {
        providerManager.saveClaudeProvider(provider);
    }

    public void updateClaudeProvider(String id, JsonObject updates) throws IOException {
        providerManager.updateClaudeProvider(id, updates);
    }

    public DeleteResult deleteClaudeProvider(String id) {
        return providerManager.deleteClaudeProvider(id);
    }

    @Deprecated
    public void deleteClaudeProviderWithException(String id) throws IOException {
        DeleteResult result = deleteClaudeProvider(id);
        if (!result.isSuccess()) {
            throw new IOException(result.getUserFriendlyMessage());
        }
    }

    public void switchClaudeProvider(String id) throws IOException {
        providerManager.switchClaudeProvider(id);
    }

    public List<JsonObject> parseProvidersFromCcSwitchDb(String dbPath) throws IOException {
        return providerManager.parseProvidersFromCcSwitchDb(dbPath);
    }

    public int saveProviders(List<JsonObject> providers) throws IOException {
        return providerManager.saveProviders(providers);
    }

    public boolean isLocalProviderActive() {
        return providerManager.isLocalProviderActive();
    }

    // ==================== MCP Server 管理 ====================

    public List<JsonObject> getMcpServers() throws IOException {
        return mcpServerManager.getMcpServers();
    }

    public List<JsonObject> getMcpServersWithProjectPath(String projectPath) throws IOException {
        return mcpServerManager.getMcpServersWithProjectPath(projectPath);
    }

    public void upsertMcpServer(JsonObject server) throws IOException {
        mcpServerManager.upsertMcpServer(server);
    }

    public void upsertMcpServer(JsonObject server, String projectPath) throws IOException {
        mcpServerManager.upsertMcpServer(server, projectPath);
    }

    public boolean deleteMcpServer(String serverId) throws IOException {
        return mcpServerManager.deleteMcpServer(serverId);
    }

    public Map<String, Object> validateMcpServer(JsonObject server) {
        return mcpServerManager.validateMcpServer(server);
    }

    // ==================== Codex MCP Server 管理 ====================

    public CodexMcpServerManager getCodexMcpServerManager() {
        return codexMcpServerManager;
    }

    public List<JsonObject> getCodexMcpServers() throws IOException {
        return codexMcpServerManager.getMcpServers();
    }

    public void upsertCodexMcpServer(JsonObject server) throws IOException {
        codexMcpServerManager.upsertMcpServer(server);
    }

    public boolean deleteCodexMcpServer(String serverId) throws IOException {
        return codexMcpServerManager.deleteMcpServer(serverId);
    }

    public Map<String, Object> validateCodexMcpServer(JsonObject server) {
        return codexMcpServerManager.validateMcpServer(server);
    }

    // ==================== Skills 管理 ====================

    public List<JsonObject> getSkills() throws IOException {
        return skillManager.getSkills();
    }

    public void upsertSkill(JsonObject skill) throws IOException {
        skillManager.upsertSkill(skill);
    }

    public boolean deleteSkill(String id) throws IOException {
        return skillManager.deleteSkill(id);
    }

    public Map<String, Object> validateSkill(JsonObject skill) {
        return skillManager.validateSkill(skill);
    }

    public void syncSkillsToClaudeSettings() throws IOException {
        skillManager.syncSkillsToClaudeSettings();
    }

    // ==================== Agents 管理 ====================

    public List<JsonObject> getAgents() throws IOException {
        return agentManager.getAgents();
    }

    public void addAgent(JsonObject agent) throws IOException {
        agentManager.addAgent(agent);
    }

    public void updateAgent(String id, JsonObject updates) throws IOException {
        agentManager.updateAgent(id, updates);
    }

    public boolean deleteAgent(String id) throws IOException {
        return agentManager.deleteAgent(id);
    }

    public JsonObject getAgent(String id) throws IOException {
        return agentManager.getAgent(id);
    }

    public String getSelectedAgentId() throws IOException {
        return agentManager.getSelectedAgentId();
    }

    public void setSelectedAgentId(String agentId) throws IOException {
        agentManager.setSelectedAgentId(agentId);
    }

    // ==================== Codex Provider 管理 ====================

    public List<JsonObject> getCodexProviders() throws IOException {
        return codexProviderManager.getCodexProviders();
    }

    public JsonObject getActiveCodexProvider() throws IOException {
        return codexProviderManager.getActiveCodexProvider();
    }

    public void addCodexProvider(JsonObject provider) throws IOException {
        codexProviderManager.addCodexProvider(provider);
    }

    public void saveCodexProvider(JsonObject provider) throws IOException {
        codexProviderManager.saveCodexProvider(provider);
    }

    public void updateCodexProvider(String id, JsonObject updates) throws IOException {
        codexProviderManager.updateCodexProvider(id, updates);
    }

    public DeleteResult deleteCodexProvider(String id) {
        return codexProviderManager.deleteCodexProvider(id);
    }

    public void switchCodexProvider(String id) throws IOException {
        codexProviderManager.switchCodexProvider(id);
    }

    public void applyActiveProviderToCodexSettings() throws IOException {
        codexProviderManager.applyActiveProviderToCodexSettings();
    }

    public JsonObject getCurrentCodexConfig() throws IOException {
        return codexProviderManager.getCurrentCodexConfig();
    }

    public int saveCodexProviders(List<JsonObject> providers) throws IOException {
        return codexProviderManager.saveProviders(providers);
    }
}
