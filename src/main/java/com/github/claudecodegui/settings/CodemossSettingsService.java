package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.ConflictStrategy;
import com.github.claudecodegui.model.DeleteResult;
import com.github.claudecodegui.model.PromptScope;
import com.github.claudecodegui.dependency.DependencyManager;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.io.File;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Codemoss configuration service (Facade pattern).
 * Delegates specific functionality to specialized managers.
 *
 * @author melon
 */
public class CodemossSettingsService {

    /**
     * log.
     */
    private static final Logger LOG = Logger.getInstance(CodemossSettingsService.class);
    /**
     * config version.
     */
    private static final int CONFIG_VERSION = 2;
    /**
     * codex sandbox mode workspace write.
     */
    private static final String CODEX_SANDBOX_MODE_WORKSPACE_WRITE = "workspace-write";
    /**
     * codex sandbox mode danger full access.
     */
    private static final String CODEX_SANDBOX_MODE_DANGER_FULL_ACCESS = "danger-full-access";
    /**
     * ui font config key.
     */
    private static final String UI_FONT_CONFIG_KEY = "uiFont";
    /**
     * ui font mode key.
     */
    private static final String UI_FONT_MODE_KEY = "mode";
    /**
     * ui font custom path key.
     */
    private static final String UI_FONT_CUSTOM_PATH_KEY = "customFontPath";
    /**
     * valid ui font modes.
     */
    private static final Set<String> VALID_UI_FONT_MODES = Set.of(
            FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR,
            FontConfigService.UI_FONT_MODE_CUSTOM_FILE
    );
    /**
     * codex runtime access inactive.
     */
    public static final String CODEX_RUNTIME_ACCESS_INACTIVE = "inactive";
    /**
     * codex runtime access managed.
     */
    public static final String CODEX_RUNTIME_ACCESS_MANAGED = "managed";
    /**
     * codex runtime access cli login.
     */
    public static final String CODEX_RUNTIME_ACCESS_CLI_LOGIN = "cli_login";
    /**
     * commit ai key.
     */
    private static final String COMMIT_AI_KEY = "commitAi";
    /**
     * prompt enhancer key.
     */
    private static final String PROMPT_ENHANCER_KEY = "promptEnhancer";
    /**
     * ai feature provider key.
     */
    private static final String AI_FEATURE_PROVIDER_KEY = "provider";
    /**
     * ai feature models key.
     */
    private static final String AI_FEATURE_MODELS_KEY = "models";
    /**
     * ai feature effective provider key.
     */
    private static final String AI_FEATURE_EFFECTIVE_PROVIDER_KEY = "effectiveProvider";
    /**
     * ai feature resolution source key.
     */
    private static final String AI_FEATURE_RESOLUTION_SOURCE_KEY = "resolutionSource";
    /**
     * ai feature availability key.
     */
    private static final String AI_FEATURE_AVAILABILITY_KEY = "availability";
    /**
     * ai feature provider claude.
     */
    private static final String AI_FEATURE_PROVIDER_CLAUDE = "claude";
    /**
     * ai feature provider codex.
     */
    private static final String AI_FEATURE_PROVIDER_CODEX = "codex";
    /**
     * ai feature resolution manual.
     */
    private static final String AI_FEATURE_RESOLUTION_MANUAL = "manual";
    /**
     * ai feature resolution auto.
     */
    private static final String AI_FEATURE_RESOLUTION_AUTO = "auto";
    /**
     * ai feature resolution unavailable.
     */
    private static final String AI_FEATURE_RESOLUTION_UNAVAILABLE = "unavailable";
    /**
     * default prompt enhancer claude model.
     */
    private static final String DEFAULT_PROMPT_ENHANCER_CLAUDE_MODEL = "claude-sonnet-4-6";
    /**
     * default prompt enhancer codex model.
     */
    private static final String DEFAULT_PROMPT_ENHANCER_CODEX_MODEL = "gpt-5.5";
    /**
     * default commit ai claude model.
     */
    private static final String DEFAULT_COMMIT_AI_CLAUDE_MODEL = "claude-sonnet-4-6";
    /**
     * default commit ai codex model.
     */
    private static final String DEFAULT_COMMIT_AI_CODEX_MODEL = "gpt-5.5";
    /**
     * gson.
     */
    private final Gson gson;
    /**
     * path manager.
     */
    private final ConfigPathManager pathManager;
    /**
     * claude settings manager.
     */
    private final ClaudeSettingsManager claudeSettingsManager;
    /**
     * codex settings manager.
     */
    private final CodexSettingsManager codexSettingsManager;
    /**
     * codex mcp server manager.
     */
    private final CodexMcpServerManager codexMcpServerManager;
    /**
     * working directory manager.
     */
    private final WorkingDirectoryManager workingDirectoryManager;
    /**
     * agent manager.
     */
    private final AgentManager agentManager;
    /**
     * skill manager.
     */
    private final SkillManager skillManager;
    /**
     * mcp server manager.
     */
    private final McpServerManager mcpServerManager;
    /**
     * provider manager.
     */
    private final ProviderManager providerManager;
    /**
     * codex provider manager.
     */
    private final CodexProviderManager codexProviderManager;

    /**
     * Codemoss Settings Service
     *
     */
    public CodemossSettingsService() {
        this.gson = new GsonBuilder().setPrettyPrinting().serializeNulls().create();

        // Initialize ConfigPathManager
        this.pathManager = new ConfigPathManager();

        // Initialize ClaudeSettingsManager
        this.claudeSettingsManager = new ClaudeSettingsManager(gson, pathManager);

        // Initialize WorkingDirectoryManager
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

        // Initialize AgentManager
        this.agentManager = new AgentManager(gson, pathManager);

        // Initialize SkillManager
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

        // Initialize McpServerManager
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

        // Initialize ProviderManager
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

        // Initialize CodexSettingsManager
        this.codexSettingsManager = new CodexSettingsManager(gson);

        // Initialize CodexMcpServerManager
        this.codexMcpServerManager = new CodexMcpServerManager(codexSettingsManager);

        // Initialize CodexProviderManager
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

    // ==================== Basic Config Management ====================

    /**
     * Get config file path (~/.codemoss/config.json).
     *
     * @return string
     */
    public String getConfigPath() {
        return pathManager.getConfigPath();
    }

    /**
     * Read the config file.
     *
     * @return json object
     * @throws IOException
     */
    public JsonObject readConfig() throws IOException {
        String configPath = getConfigPath();
        File configFile = new File(configPath);

        if (!configFile.exists()) {
            LOG.info("[CodemossSettings] Config file not found, creating default: " + configPath);
            return createDefaultConfig();
        }

        try (FileReader reader = new FileReader(configFile, StandardCharsets.UTF_8)) {
            JsonObject config = JsonParser.parseReader(reader).getAsJsonObject();
            LOG.info("[CodemossSettings] Successfully read config from: " + configPath);
            return config;
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to read config: " + e.getMessage());
            return createDefaultConfig();
        }
    }

    /**
     * Write the config file.
     *
     * @param config config
     * @throws IOException
     */
    public void writeConfig(JsonObject config) throws IOException {
        pathManager.ensureConfigDirectory();

        // Back up existing config
        backupConfig();

        String configPath = getConfigPath();
        try (FileWriter writer = new FileWriter(configPath, StandardCharsets.UTF_8)) {
            gson.toJson(config, writer);
            LOG.info("[CodemossSettings] Successfully wrote config to: " + configPath);
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to write config: " + e.getMessage());
            throw e;
        }
    }

    /**
     * Backup Config
     *
     */
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
     * Create default config.
     *
     * @return json object
     */
    private JsonObject createDefaultConfig() {
        JsonObject config = new JsonObject();
        config.addProperty("version", CONFIG_VERSION);

        // Claude config - empty provider list
        JsonObject claude = new JsonObject();
        JsonObject providers = new JsonObject();

        claude.addProperty("current", "");
        claude.add("providers", providers);
        config.add("claude", claude);

        JsonObject codex = new JsonObject();
        codex.addProperty("current", "");
        codex.add("providers", new JsonObject());
        codex.addProperty("localConfigAuthorized", false);
        config.add("codex", codex);

        return config;
    }

    // ==================== Claude Settings Management ====================

    /**
     * Get Current Claude Config
     *
     * @return json object
     * @throws IOException
     */
    public JsonObject getCurrentClaudeConfig() throws IOException {
        JsonObject currentConfig = claudeSettingsManager.getCurrentClaudeConfig();

        // If codemossProviderId exists, try to get provider name from codemoss config
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
                // Ignore error - provider name is optional
            }
        }

        return currentConfig;
    }

    /**
     * Read Claude Settings
     *
     * @return json object
     * @throws IOException
     */
    public JsonObject readClaudeSettings() throws IOException {
        return claudeSettingsManager.readClaudeSettings();
    }

    /**
     * Get Always Thinking Enabled From Claude Settings
     *
     * @return boolean
     * @throws IOException
     */
    public Boolean getAlwaysThinkingEnabledFromClaudeSettings() throws IOException {
        return claudeSettingsManager.getAlwaysThinkingEnabled();
    }

    /**
     * Set Always Thinking Enabled In Claude Settings
     *
     * @param enabled enabled
     * @throws IOException
     */
    public void setAlwaysThinkingEnabledInClaudeSettings(boolean enabled) throws IOException {
        claudeSettingsManager.setAlwaysThinkingEnabled(enabled);
    }

    /**
     * Set Always Thinking Enabled In Active Provider
     *
     * @param enabled enabled
     * @return boolean
     * @throws IOException
     */
    public boolean setAlwaysThinkingEnabledInActiveProvider(boolean enabled) throws IOException {
        return providerManager.setAlwaysThinkingEnabledInActiveProvider(enabled);
    }

    /**
     * Apply Provider To Claude Settings
     *
     * @param provider provider
     * @throws IOException
     */
    public void applyProviderToClaudeSettings(JsonObject provider) throws IOException {
        claudeSettingsManager.applyProviderToClaudeSettings(provider);
    }

    /**
     * Apply Cli Login To Claude Settings
     *
     * @throws IOException
     */
    public void applyCliLoginToClaudeSettings() throws IOException {
        claudeSettingsManager.applyCliLoginToClaudeSettings();
    }

    /**
     * Remove Cli Login From Claude Settings
     *
     * @throws IOException
     */
    public void removeCliLoginFromClaudeSettings() throws IOException {
        claudeSettingsManager.removeCliLoginFromClaudeSettings();
    }

    /**
     * Read Cli Login Account Info
     *
     * @return json object
     */
    public JsonObject readCliLoginAccountInfo() {
        return claudeSettingsManager.readCliLoginAccountInfo();
    }

    /**
     * Apply Active Provider To Claude Settings
     *
     * @throws IOException
     */
    public void applyActiveProviderToClaudeSettings() throws IOException {
        providerManager.applyActiveProviderToClaudeSettings();
    }

    // ==================== Working Directory Management ====================

    /**
     * Get Custom Working Directory
     *
     * @param projectPath project path
     * @return string
     * @throws IOException
     */
    public String getCustomWorkingDirectory(String projectPath) throws IOException {
        return workingDirectoryManager.getCustomWorkingDirectory(projectPath);
    }

    /**
     * Set Custom Working Directory
     *
     * @param projectPath project path
     * @param customWorkingDir custom working dir
     * @throws IOException
     */
    public void setCustomWorkingDirectory(String projectPath, String customWorkingDir) throws IOException {
        workingDirectoryManager.setCustomWorkingDirectory(projectPath, customWorkingDir);
    }

    /**
     * Get All Working Directories
     *
     * @return map
     * @throws IOException
     */
    public Map<String, String> getAllWorkingDirectories() throws IOException {
        return workingDirectoryManager.getAllWorkingDirectories();
    }

    // ==================== Commit Prompt Config Management ====================

    /**
     * Get the commit AI prompt.
     *
     * @return commit prompt
     * @throws IOException
     */
    public String getCommitPrompt() throws IOException {
        JsonObject config = readConfig();

        // Check for commitPrompt config
        if (config.has("commitPrompt")) {
            return config.get("commitPrompt").getAsString();
        }

        // Return default value (from i18n resource bundle)
        return ClaudeCodeGuiBundle.message("commit.defaultPrompt");
    }

    /**
     * Set the commit AI prompt.
     *
     * @param prompt commit prompt
     * @throws IOException
     */
    public void setCommitPrompt(String prompt) throws IOException {
        JsonObject config = readConfig();

        // Save config
        config.addProperty("commitPrompt", prompt);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set commit prompt: " + prompt);
    }

    /**
     * Get project-level commit AI prompt.
     *
     * @param projectPath project path
     * @return project commit prompt, empty string if not configured
     * @throws IOException
     */
    public String getProjectCommitPrompt(String projectPath) throws IOException {
        if (projectPath == null) {
            return "";
        }
        JsonObject config = readConfig();
        if (config.has("projectCommitPrompt")) {
            JsonObject projectPrompts = config.getAsJsonObject("projectCommitPrompt");
            if (projectPrompts.has(projectPath)) {
                return projectPrompts.get(projectPath).getAsString();
            }
        }
        return "";
    }

    /**
     * Set project-level commit AI prompt.
     *
     * @param projectPath project path
     * @param prompt commit prompt
     * @throws IOException
     */
    public void setProjectCommitPrompt(String projectPath, String prompt) throws IOException {
        if (projectPath == null) {
            return;
        }
        JsonObject config = readConfig();
        JsonObject projectPrompts;
        if (config.has("projectCommitPrompt")) {
            projectPrompts = config.getAsJsonObject("projectCommitPrompt");
        } else {
            projectPrompts = new JsonObject();
            config.add("projectCommitPrompt", projectPrompts);
        }
        projectPrompts.addProperty(projectPath, prompt);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set project commit prompt for project: " + projectPath);
    }

    // ==================== UI Font Config Management ====================

    /**
     * Get persisted UI font configuration.
     *
     * @return normalized UI font configuration
     * @throws IOException
     */
    public JsonObject getUiFontConfig() throws IOException {
        JsonObject config = readConfig();
        if (!config.has(UI_FONT_CONFIG_KEY) || !config.get(UI_FONT_CONFIG_KEY).isJsonObject()) {
            return createDefaultUiFontConfig();
        }
        return normalizeUiFontConfig(config.getAsJsonObject(UI_FONT_CONFIG_KEY));
    }

    /**
     * Persist UI font configuration.
     *
     * @param mode requested mode
     * @param customFontPath custom font path for custom file mode
     * @throws IOException
     */
    public void setUiFontConfig(String mode, String customFontPath) throws IOException {
        JsonObject config = readConfig();
        config.add(UI_FONT_CONFIG_KEY, createUiFontConfig(mode, customFontPath));
        writeConfig(config);
        LOG.debug("[CodemossSettings] Set UI font config: mode=" + mode
                + ", customFontPath=" + customFontPath);
    }

    // ==================== Streaming Config Management ====================

    /**
     * Get streaming configuration.
     *
     * @param projectPath project path
     * @return whether streaming is enabled
     * @throws IOException
     */
    public boolean getStreamingEnabled(String projectPath) throws IOException {
        JsonObject config = readConfig();

        // Check for streaming config
        if (!config.has("streaming")) {
            return true;
        }

        JsonObject streaming = config.getAsJsonObject("streaming");

        // Check project-specific config first
        if (projectPath != null && streaming.has(projectPath)) {
            return streaming.get(projectPath).getAsBoolean();
        }

        // Fall back to global default if no project-specific config
        if (streaming.has("default")) {
            return streaming.get("default").getAsBoolean();
        }

        return true;
    }

    /**
     * Create Default Ui Font Config
     *
     * @return json object
     */
    private JsonObject createDefaultUiFontConfig() {
        JsonObject uiFont = new JsonObject();
        uiFont.addProperty(UI_FONT_MODE_KEY, FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR);
        return uiFont;
    }

    /**
     * Normalize Ui Font Config
     *
     * @param rawConfig raw config
     * @return json object
     */
    private JsonObject normalizeUiFontConfig(JsonObject rawConfig) {
        if (rawConfig == null) {
            return createDefaultUiFontConfig();
        }
        String requestedMode = rawConfig.has(UI_FONT_MODE_KEY) && !rawConfig.get(UI_FONT_MODE_KEY).isJsonNull()
                ? rawConfig.get(UI_FONT_MODE_KEY).getAsString()
                : FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR;
        String customFontPath = rawConfig.has(UI_FONT_CUSTOM_PATH_KEY) && !rawConfig.get(UI_FONT_CUSTOM_PATH_KEY).isJsonNull()
                ? rawConfig.get(UI_FONT_CUSTOM_PATH_KEY).getAsString()
                : null;
        return createUiFontConfig(requestedMode, customFontPath);
    }

    /**
     * Create Ui Font Config
     *
     * @param mode mode
     * @param customFontPath custom font path
     * @return json object
     */
    private JsonObject createUiFontConfig(String mode, String customFontPath) {
        String normalizedMode = VALID_UI_FONT_MODES.contains(mode)
                ? mode
                : FontConfigService.UI_FONT_MODE_FOLLOW_EDITOR;
        JsonObject uiFont = new JsonObject();
        uiFont.addProperty(UI_FONT_MODE_KEY, normalizedMode);

        if (FontConfigService.UI_FONT_MODE_CUSTOM_FILE.equals(normalizedMode)
                && customFontPath != null
                && !customFontPath.trim().isEmpty()) {
            uiFont.addProperty(UI_FONT_CUSTOM_PATH_KEY, customFontPath.trim());
        }

        return uiFont;
    }

    /**
     * Set streaming configuration.
     *
     * @param projectPath project path
     * @param enabled     whether to enable
     * @throws IOException
     */
    public void setStreamingEnabled(String projectPath, boolean enabled) throws IOException {
        JsonObject config = readConfig();

        // Ensure streaming object exists
        JsonObject streaming;
        if (config.has("streaming")) {
            streaming = config.getAsJsonObject("streaming");
        } else {
            streaming = new JsonObject();
            config.add("streaming", streaming);
        }

        // Save project-specific config (also serves as default)
        if (projectPath != null) {
            streaming.addProperty(projectPath, enabled);
        }
        streaming.addProperty("default", enabled);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set streaming enabled to " + enabled + " for project: " + projectPath);
    }

    // ==================== Auto Open File Config Management ====================

    /**
     * Get auto-open file configuration.
     *
     * @param projectPath project path
     * @return whether auto-open file is enabled
     * @throws IOException
     */
    public boolean getAutoOpenFileEnabled(String projectPath) throws IOException {
        JsonObject config = readConfig();

        // Check for autoOpenFile config
        if (!config.has("autoOpenFile")) {
            return false;
        }

        JsonObject autoOpenFile = config.getAsJsonObject("autoOpenFile");

        // Check project-specific config first
        if (projectPath != null && autoOpenFile.has(projectPath)) {
            return autoOpenFile.get(projectPath).getAsBoolean();
        }

        // Fall back to global default if no project-specific config
        if (autoOpenFile.has("default")) {
            return autoOpenFile.get("default").getAsBoolean();
        }

        return false;
    }

    /**
     * Set auto-open file configuration.
     *
     * @param projectPath project path
     * @param enabled     whether to enable
     * @throws IOException
     */
    public void setAutoOpenFileEnabled(String projectPath, boolean enabled) throws IOException {
        JsonObject config = readConfig();

        // Ensure autoOpenFile object exists
        JsonObject autoOpenFile;
        if (config.has("autoOpenFile")) {
            autoOpenFile = config.getAsJsonObject("autoOpenFile");
        } else {
            autoOpenFile = new JsonObject();
            config.add("autoOpenFile", autoOpenFile);
        }

        // Save project-specific config (also serves as default)
        if (projectPath != null) {
            autoOpenFile.addProperty(projectPath, enabled);
        }
        autoOpenFile.addProperty("default", enabled);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set auto open file enabled to " + enabled + " for project: " + projectPath);
    }

    // ==================== Codex Sandbox Mode Config Management ====================

    /**
     * Get Codex sandbox mode configuration.
     *
     * @param projectPath project path
     * @return sandbox mode (workspace-write or danger-full-access)
     * @throws IOException
     */
    public String getCodexSandboxMode(String projectPath) throws IOException {
        JsonObject config = readConfig();
        String defaultMode = getDefaultCodexSandboxMode();

        if (!config.has("codexSandboxMode")) {
            return defaultMode;
        }

        JsonObject sandboxConfig = config.getAsJsonObject("codexSandboxMode");

        if (projectPath != null && sandboxConfig.has(projectPath)) {
            String mode = sandboxConfig.get(projectPath).getAsString();
            return isValidCodexSandboxMode(mode) ? mode : defaultMode;
        }

        if (sandboxConfig.has("default")) {
            String mode = sandboxConfig.get("default").getAsString();
            return isValidCodexSandboxMode(mode) ? mode : defaultMode;
        }

        return defaultMode;
    }

    /**
     * Set Codex sandbox mode configuration.
     *
     * @param projectPath project path
     * @param sandboxMode sandbox mode (workspace-write or danger-full-access)
     * @throws IOException
     */
    public void setCodexSandboxMode(String projectPath, String sandboxMode) throws IOException {
        if (!isValidCodexSandboxMode(sandboxMode)) {
            throw new IllegalArgumentException("Invalid Codex sandbox mode: " + sandboxMode);
        }

        JsonObject config = readConfig();

        JsonObject sandboxConfig;
        if (config.has("codexSandboxMode")) {
            sandboxConfig = config.getAsJsonObject("codexSandboxMode");
        } else {
            sandboxConfig = new JsonObject();
            config.add("codexSandboxMode", sandboxConfig);
        }

        if (projectPath != null) {
            sandboxConfig.addProperty(projectPath, sandboxMode);
        }
        sandboxConfig.addProperty("default", sandboxMode);

        writeConfig(config);
        LOG.info("[CodemossSettings] Set Codex sandbox mode to " + sandboxMode + " for project: " + projectPath);
    }

    /**
     * Is Valid Codex Sandbox Mode
     *
     * @param mode mode
     * @return boolean
     */
    private boolean isValidCodexSandboxMode(String mode) {
        return CODEX_SANDBOX_MODE_WORKSPACE_WRITE.equals(mode)
                || CODEX_SANDBOX_MODE_DANGER_FULL_ACCESS.equals(mode);
    }

    /**
     * Get Default Codex Sandbox Mode
     *
     * @return string
     */
    private String getDefaultCodexSandboxMode() {
        return CODEX_SANDBOX_MODE_DANGER_FULL_ACCESS;
    }

    // ==================== Provider Management ====================

    /**
     * Get Claude Providers
     *
     * @return list
     * @throws IOException
     */
    public List<JsonObject> getClaudeProviders() throws IOException {
        return providerManager.getClaudeProviders();
    }

    /**
     * Get Active Claude Provider
     *
     * @return json object
     * @throws IOException
     */
    public JsonObject getActiveClaudeProvider() throws IOException {
        return providerManager.getActiveClaudeProvider();
    }

    /**
     * Add Claude Provider
     *
     * @param provider provider
     * @throws IOException
     */
    public void addClaudeProvider(JsonObject provider) throws IOException {
        providerManager.addClaudeProvider(provider);
    }

    /**
     * Save Claude Provider
     *
     * @param provider provider
     * @throws IOException
     */
    public void saveClaudeProvider(JsonObject provider) throws IOException {
        providerManager.saveClaudeProvider(provider);
    }

    /**
     * Update Claude Provider
     *
     * @param id id
     * @param updates updates
     * @throws IOException
     */
    public void updateClaudeProvider(String id, JsonObject updates) throws IOException {
        providerManager.updateClaudeProvider(id, updates);
    }

    /**
     * Delete Claude Provider
     *
     * @param id id
     * @return delete result
     */
    public DeleteResult deleteClaudeProvider(String id) {
        return providerManager.deleteClaudeProvider(id);
    }

    /**
     * Delete Claude Provider With Exception
     *
     * @param id id
     * @throws IOException
     */
    @Deprecated
    public void deleteClaudeProviderWithException(String id) throws IOException {
        DeleteResult result = deleteClaudeProvider(id);
        if (!result.isSuccess()) {
            throw new IOException(result.getUserFriendlyMessage());
        }
    }

    /**
     * Switch Claude Provider
     *
     * @param id id
     * @throws IOException
     */
    public void switchClaudeProvider(String id) throws IOException {
        providerManager.switchClaudeProvider(id);
    }

    /**
     * Deactivate Claude Provider
     *
     * @throws IOException
     */
    public void deactivateClaudeProvider() throws IOException {
        providerManager.deactivateClaudeProvider();
    }

    /**
     * Parse Providers From Cc Switch Db
     *
     * @param dbPath db path
     * @return list
     * @throws IOException
     */
    public List<JsonObject> parseProvidersFromCcSwitchDb(String dbPath) throws IOException {
        return providerManager.parseProvidersFromCcSwitchDb(dbPath);
    }

    /**
     * Save Providers
     *
     * @param providers providers
     * @return int
     * @throws IOException
     */
    public int saveProviders(List<JsonObject> providers) throws IOException {
        return providerManager.saveProviders(providers);
    }

    /**
     * Save Provider Order
     *
     * @param orderedIds ordered ids
     * @throws IOException
     */
    public void saveProviderOrder(List<String> orderedIds) throws IOException {
        providerManager.saveProviderOrder(orderedIds);
    }

    /**
     * Is Local Provider Active
     *
     * @return boolean
     */
    public boolean isLocalProviderActive() {
        return providerManager.isLocalProviderActive();
    }

    // ==================== MCP Server Management ====================

    /**
     * Get Mcp Servers
     *
     * @return list
     * @throws IOException
     */
    public List<JsonObject> getMcpServers() throws IOException {
        return mcpServerManager.getMcpServers();
    }

    /**
     * Get Mcp Servers With Project Path
     *
     * @param projectPath project path
     * @return list
     * @throws IOException
     */
    public List<JsonObject> getMcpServersWithProjectPath(String projectPath) throws IOException {
        return mcpServerManager.getMcpServersWithProjectPath(projectPath);
    }

    /**
     * Upsert Mcp Server
     *
     * @param server server
     * @throws IOException
     */
    public void upsertMcpServer(JsonObject server) throws IOException {
        mcpServerManager.upsertMcpServer(server);
    }

    /**
     * Upsert Mcp Server
     *
     * @param server server
     * @param projectPath project path
     * @throws IOException
     */
    public void upsertMcpServer(JsonObject server, String projectPath) throws IOException {
        mcpServerManager.upsertMcpServer(server, projectPath);
    }

    /**
     * Delete Mcp Server
     *
     * @param serverId server id
     * @return boolean
     * @throws IOException
     */
    public boolean deleteMcpServer(String serverId) throws IOException {
        return mcpServerManager.deleteMcpServer(serverId);
    }

    /**
     * Validate Mcp Server
     *
     * @param server server
     * @return map
     */
    public Map<String, Object> validateMcpServer(JsonObject server) {
        return mcpServerManager.validateMcpServer(server);
    }

    // ==================== Codex MCP Server Management ====================

    /**
     * Get Codex Mcp Server Manager
     *
     * @return codex mcp server manager
     */
    public CodexMcpServerManager getCodexMcpServerManager() {
        return codexMcpServerManager;
    }

    /**
     * Get Codex Mcp Servers
     *
     * @return list
     * @throws IOException
     */
    public List<JsonObject> getCodexMcpServers() throws IOException {
        return codexMcpServerManager.getMcpServers();
    }

    /**
     * Upsert Codex Mcp Server
     *
     * @param server server
     * @throws IOException
     */
    public void upsertCodexMcpServer(JsonObject server) throws IOException {
        codexMcpServerManager.upsertMcpServer(server);
    }

    /**
     * Delete Codex Mcp Server
     *
     * @param serverId server id
     * @return boolean
     * @throws IOException
     */
    public boolean deleteCodexMcpServer(String serverId) throws IOException {
        return codexMcpServerManager.deleteMcpServer(serverId);
    }

    /**
     * Validate Codex Mcp Server
     *
     * @param server server
     * @return map
     */
    public Map<String, Object> validateCodexMcpServer(JsonObject server) {
        return codexMcpServerManager.validateMcpServer(server);
    }

    // ==================== Skills Management ====================

    /**
     * Get Skills
     *
     * @return list
     * @throws IOException
     */
    public List<JsonObject> getSkills() throws IOException {
        return skillManager.getSkills();
    }

    /**
     * Upsert Skill
     *
     * @param skill skill
     * @throws IOException
     */
    public void upsertSkill(JsonObject skill) throws IOException {
        skillManager.upsertSkill(skill);
    }

    /**
     * Delete Skill
     *
     * @param id id
     * @return boolean
     * @throws IOException
     */
    public boolean deleteSkill(String id) throws IOException {
        return skillManager.deleteSkill(id);
    }

    /**
     * Validate Skill
     *
     * @param skill skill
     * @return map
     */
    public Map<String, Object> validateSkill(JsonObject skill) {
        return skillManager.validateSkill(skill);
    }

    /**
     * Sync Skills To Claude Settings
     *
     * @throws IOException
     */
    public void syncSkillsToClaudeSettings() throws IOException {
        skillManager.syncSkillsToClaudeSettings();
    }

    // ==================== Agents Management ====================

    /**
     * Get Agents
     *
     * @return list
     * @throws IOException
     */
    public List<JsonObject> getAgents() throws IOException {
        return agentManager.getAgents();
    }

    /**
     * Add Agent
     *
     * @param agent agent
     * @throws IOException
     */
    public void addAgent(JsonObject agent) throws IOException {
        agentManager.addAgent(agent);
    }

    /**
     * Update Agent
     *
     * @param id id
     * @param updates updates
     * @throws IOException
     */
    public void updateAgent(String id, JsonObject updates) throws IOException {
        agentManager.updateAgent(id, updates);
    }

    /**
     * Delete Agent
     *
     * @param id id
     * @return boolean
     * @throws IOException
     */
    public boolean deleteAgent(String id) throws IOException {
        return agentManager.deleteAgent(id);
    }

    /**
     * Get Agent
     *
     * @param id id
     * @return json object
     * @throws IOException
     */
    public JsonObject getAgent(String id) throws IOException {
        return agentManager.getAgent(id);
    }

    /**
     * Get Selected Agent Id
     *
     * @return string
     * @throws IOException
     */
    public String getSelectedAgentId() throws IOException {
        return agentManager.getSelectedAgentId();
    }

    /**
     * Set Selected Agent Id
     *
     * @param agentId agent id
     * @throws IOException
     */
    public void setSelectedAgentId(String agentId) throws IOException {
        agentManager.setSelectedAgentId(agentId);
    }

    /**
     * Get Agent Manager
     *
     * @return agent manager
     */
    public AgentManager getAgentManager() {
        return agentManager;
    }

    // ==================== Prompts Management ====================

    /**
     * Get a PromptManager for the specified scope.
     * Creates managers on-demand using PromptManagerFactory.
     *
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return An AbstractPromptManager instance for the specified scope
     */
    public AbstractPromptManager getPromptManager(PromptScope scope, Project project) {
        return PromptManagerFactory.create(scope, gson, pathManager, project);
    }

    /**
     * Get prompts from the specified scope.
     *
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return List of prompts
     * @throws IOException if reading fails
     */
    public List<JsonObject> getPrompts(PromptScope scope, Project project) throws IOException {
        return getPromptManager(scope, project).getPrompts();
    }

    /**
     * Add a prompt to the specified scope.
     *
     * @param prompt  The prompt to add
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @throws IOException if writing fails
     */
    public void addPrompt(JsonObject prompt, PromptScope scope, Project project) throws IOException {
        getPromptManager(scope, project).addPrompt(prompt);
    }

    /**
     * Update a prompt in the specified scope.
     *
     * @param id      The prompt ID
     * @param updates The updates to apply
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @throws IOException if writing fails
     */
    public void updatePrompt(String id, JsonObject updates, PromptScope scope, Project project) throws IOException {
        getPromptManager(scope, project).updatePrompt(id, updates);
    }

    /**
     * Delete a prompt from the specified scope.
     *
     * @param id      The prompt ID
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return true if deleted, false if not found
     * @throws IOException if writing fails
     */
    public boolean deletePrompt(String id, PromptScope scope, Project project) throws IOException {
        return getPromptManager(scope, project).deletePrompt(id);
    }

    /**
     * Get a prompt by ID from the specified scope.
     *
     * @param id      The prompt ID
     * @param scope   The prompt scope (GLOBAL or PROJECT)
     * @param project The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return The prompt JsonObject, or null if not found
     * @throws IOException if reading fails
     */
    public JsonObject getPrompt(String id, PromptScope scope, Project project) throws IOException {
        return getPromptManager(scope, project).getPrompt(id);
    }

    /**
     * Batch import prompts to the specified scope.
     *
     * @param promptsToImport The prompts to import
     * @param strategy        The conflict resolution strategy
     * @param scope           The prompt scope (GLOBAL or PROJECT)
     * @param project         The IntelliJ Project instance (required for PROJECT scope, can be null for GLOBAL scope)
     * @return A map containing the results of the import operation
     * @throws IOException if writing fails
     */
    public Map<String, Object> batchImportPrompts(List<JsonObject> promptsToImport, ConflictStrategy strategy, PromptScope scope, Project project) throws IOException {
        return getPromptManager(scope, project).batchImportPrompts(promptsToImport, strategy);
    }

    // ==================== Deprecated Backward-Compatible Methods ====================

    /**
     * Get a PromptManager (defaults to GLOBAL scope).
     *
     * @return abstract prompt manager
     * @deprecated Use {@link #getPromptManager(PromptScope, Project)} instead
     */
    @Deprecated
    public AbstractPromptManager getPromptManager() {
        return getPromptManager(PromptScope.GLOBAL, null);
    }

    /**
     * Get prompts (defaults to GLOBAL scope).
     *
     * @return list
     * @throws IOException
     * @deprecated Use {@link #getPrompts(PromptScope, Project)} instead
     */
    @Deprecated
    public List<JsonObject> getPrompts() throws IOException {
        return getPrompts(PromptScope.GLOBAL, null);
    }

    /**
     * Add a prompt (defaults to GLOBAL scope).
     *
     * @param prompt prompt
     * @throws IOException
     * @deprecated Use {@link #addPrompt(JsonObject, PromptScope, Project)} instead
     */
    @Deprecated
    public void addPrompt(JsonObject prompt) throws IOException {
        addPrompt(prompt, PromptScope.GLOBAL, null);
    }

    /**
     * Update a prompt (defaults to GLOBAL scope).
     *
     * @param id id
     * @param updates updates
     * @throws IOException
     * @deprecated Use {@link #updatePrompt(String, JsonObject, PromptScope, Project)} instead
     */
    @Deprecated
    public void updatePrompt(String id, JsonObject updates) throws IOException {
        updatePrompt(id, updates, PromptScope.GLOBAL, null);
    }

    /**
     * Delete a prompt (defaults to GLOBAL scope).
     *
     * @param id id
     * @return boolean
     * @throws IOException
     * @deprecated Use {@link #deletePrompt(String, PromptScope, Project)} instead
     */
    @Deprecated
    public boolean deletePrompt(String id) throws IOException {
        return deletePrompt(id, PromptScope.GLOBAL, null);
    }

    /**
     * Get a prompt by ID (defaults to GLOBAL scope).
     *
     * @param id id
     * @return json object
     * @throws IOException
     * @deprecated Use {@link #getPrompt(String, PromptScope, Project)} instead
     */
    @Deprecated
    public JsonObject getPrompt(String id) throws IOException {
        return getPrompt(id, PromptScope.GLOBAL, null);
    }

    // ==================== Task Completion Notification Management ====================

    /**
     * Get whether task completion balloon notification is enabled.
     *
     * @return whether task completion notification is enabled, default is false (opt-in)
     * @throws IOException
     */
    public boolean getTaskCompletionNotificationEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("taskCompletionNotificationEnabled") && !config.get("taskCompletionNotificationEnabled").isJsonNull()) {
            return config.get("taskCompletionNotificationEnabled").getAsBoolean();
        }

        return false;
    }

    /**
     * Set whether task completion balloon notification is enabled.
     *
     * @param enabled whether to enable
     * @throws IOException
     */
    public void setTaskCompletionNotificationEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("taskCompletionNotificationEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set task completion notification enabled: " + enabled);
    }

    // ==================== AI Feature Toggle Management ====================

    /**
     * Get whether AI commit message generation is enabled.
     *
     * @return whether commit generation is enabled, default is true
     * @throws IOException
     */
    public boolean getCommitGenerationEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("commitGenerationEnabled") && !config.get("commitGenerationEnabled").isJsonNull()) {
            return config.get("commitGenerationEnabled").getAsBoolean();
        }

        return true;
    }

    /**
     * Set whether AI commit message generation is enabled.
     *
     * @param enabled whether to enable
     * @throws IOException
     */
    public void setCommitGenerationEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("commitGenerationEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set commit generation enabled: " + enabled);
    }

    /**
     * Get whether status bar widget is enabled.
     *
     * @return whether status bar widget is enabled, default is true
     * @throws IOException
     */
    public boolean getStatusBarWidgetEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("statusBarWidgetEnabled") && !config.get("statusBarWidgetEnabled").isJsonNull()) {
            return config.get("statusBarWidgetEnabled").getAsBoolean();
        }

        return true;
    }

    /**
     * Set whether status bar widget is enabled.
     *
     * @param enabled whether to enable
     * @throws IOException
     */
    public void setStatusBarWidgetEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("statusBarWidgetEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set status bar widget enabled: " + enabled);
    }

    /**
     * Get whether AI session title generation is enabled.
     *
     * @return whether AI title generation is enabled, default is true
     * @throws IOException
     */
    public boolean getAiTitleGenerationEnabled() throws IOException {
        JsonObject config = readConfig();

        if (config.has("aiTitleGenerationEnabled") && !config.get("aiTitleGenerationEnabled").isJsonNull()) {
            return config.get("aiTitleGenerationEnabled").getAsBoolean();
        }

        return true;
    }

    /**
     * Set whether AI session title generation is enabled.
     *
     * @param enabled whether to enable
     * @throws IOException
     */
    public void setAiTitleGenerationEnabled(boolean enabled) throws IOException {
        JsonObject config = readConfig();
        config.addProperty("aiTitleGenerationEnabled", enabled);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set AI title generation enabled: " + enabled);
    }

    // ==================== Prompt Enhancer Config Management ====================

    /**
     * Get prompt enhancer configuration with resolved provider availability.
     *
     * <p>The returned object always includes:
     * <ul>
     * <li>provider: manual override or null</li>
     * <li>models: per-provider remembered models</li>
     * <li>effectiveProvider: resolved runtime provider or null</li>
     * <li>resolutionSource: manual/auto/unavailable</li>
     * <li>availability: per-provider availability flags</li>
     * </ul>
     *
     * @return json object
     * @throws IOException
     */
    public JsonObject getPromptEnhancerConfig() throws IOException {
        return getAiFeatureConfig(
                PROMPT_ENHANCER_KEY,
                DEFAULT_PROMPT_ENHANCER_CLAUDE_MODEL,
                DEFAULT_PROMPT_ENHANCER_CODEX_MODEL
        );
    }

    /**
     * Persist prompt enhancer provider override and per-provider models.
     *
     * @param provider manual provider override, null/blank to restore auto mode
     * @param claudeModel remembered Claude enhancer model
     * @param codexModel remembered Codex enhancer model
     * @throws IOException
     */
    public void setPromptEnhancerConfig(String provider, String claudeModel, String codexModel) throws IOException {
        setAiFeatureConfig(
                PROMPT_ENHANCER_KEY,
                provider,
                claudeModel,
                codexModel,
                DEFAULT_PROMPT_ENHANCER_CLAUDE_MODEL,
                DEFAULT_PROMPT_ENHANCER_CODEX_MODEL,
                "prompt enhancer"
        );
    }

    /**
     * Get Commit Ai Config
     *
     * @return json object
     * @throws IOException
     */
    public JsonObject getCommitAiConfig() throws IOException {
        return getAiFeatureConfig(
                COMMIT_AI_KEY,
                DEFAULT_COMMIT_AI_CLAUDE_MODEL,
                DEFAULT_COMMIT_AI_CODEX_MODEL
        );
    }

    /**
     * Set Commit Ai Config
     *
     * @param provider provider
     * @param claudeModel claude model
     * @param codexModel codex model
     * @throws IOException
     */
    public void setCommitAiConfig(String provider, String claudeModel, String codexModel) throws IOException {
        setAiFeatureConfig(
                COMMIT_AI_KEY,
                provider,
                claudeModel,
                codexModel,
                DEFAULT_COMMIT_AI_CLAUDE_MODEL,
                DEFAULT_COMMIT_AI_CODEX_MODEL,
                "commit AI"
        );
    }

    /**
     * Get Ai Feature Config
     *
     * @param featureKey feature key
     * @param defaultClaudeModel default claude model
     * @param defaultCodexModel default codex model
     * @return json object
     * @throws IOException
     */
    private JsonObject getAiFeatureConfig(
            String featureKey,
            String defaultClaudeModel,
            String defaultCodexModel
    ) throws IOException {
        JsonObject rootConfig = readConfig();
        JsonObject featureConfig = getAiFeatureRootObject(rootConfig, featureKey);
        String manualProvider = normalizeAiFeatureProvider(
                featureConfig.has(AI_FEATURE_PROVIDER_KEY) && !featureConfig.get(AI_FEATURE_PROVIDER_KEY).isJsonNull()
                        ? featureConfig.get(AI_FEATURE_PROVIDER_KEY).getAsString()
                        : null
        );
        JsonObject models = getNormalizedAiFeatureModels(featureConfig, defaultClaudeModel, defaultCodexModel);
        JsonObject availability = buildAiFeatureAvailability();
        boolean claudeAvailable = availability.get(AI_FEATURE_PROVIDER_CLAUDE).getAsBoolean();
        boolean codexAvailable = availability.get(AI_FEATURE_PROVIDER_CODEX).getAsBoolean();
        ResolvedAiFeatureProvider resolvedProvider = resolveAiFeatureProvider(
                manualProvider,
                claudeAvailable,
                codexAvailable
        );

        JsonObject response = new JsonObject();
        if (manualProvider == null) {
            response.add(AI_FEATURE_PROVIDER_KEY, JsonNull.INSTANCE);
        } else {
            response.addProperty(AI_FEATURE_PROVIDER_KEY, manualProvider);
        }
        response.add(AI_FEATURE_MODELS_KEY, models);
        if (resolvedProvider.effectiveProvider == null) {
            response.add(AI_FEATURE_EFFECTIVE_PROVIDER_KEY, JsonNull.INSTANCE);
        } else {
            response.addProperty(AI_FEATURE_EFFECTIVE_PROVIDER_KEY, resolvedProvider.effectiveProvider);
        }
        response.addProperty(AI_FEATURE_RESOLUTION_SOURCE_KEY, resolvedProvider.resolutionSource);
        response.add(AI_FEATURE_AVAILABILITY_KEY, availability);
        return response;
    }

    /**
     * Set Ai Feature Config
     *
     * @param featureKey feature key
     * @param provider provider
     * @param claudeModel claude model
     * @param codexModel codex model
     * @param defaultClaudeModel default claude model
     * @param defaultCodexModel default codex model
     * @param featureLabel feature label
     * @throws IOException
     */
    private void setAiFeatureConfig(
            String featureKey,
            String provider,
            String claudeModel,
            String codexModel,
            String defaultClaudeModel,
            String defaultCodexModel,
            String featureLabel
    ) throws IOException {
        JsonObject config = readConfig();
        JsonObject featureConfig = getAiFeatureRootObject(config, featureKey);
        String normalizedProvider = normalizeAiFeatureProvider(provider);
        if (normalizedProvider == null) {
            featureConfig.add(AI_FEATURE_PROVIDER_KEY, JsonNull.INSTANCE);
        } else {
            featureConfig.addProperty(AI_FEATURE_PROVIDER_KEY, normalizedProvider);
        }
        featureConfig.add(
                AI_FEATURE_MODELS_KEY,
                createAiFeatureModels(claudeModel, codexModel, defaultClaudeModel, defaultCodexModel)
        );

        config.add(featureKey, featureConfig);
        writeConfig(config);
        LOG.info("[CodemossSettings] Set " + featureLabel + " config: provider=" + normalizedProvider);
    }

    /**
     * Get Ai Feature Root Object
     *
     * @param rootConfig root config
     * @param featureKey feature key
     * @return json object
     */
    private JsonObject getAiFeatureRootObject(JsonObject rootConfig, String featureKey) {
        if (rootConfig.has(featureKey) && rootConfig.get(featureKey).isJsonObject()) {
            return rootConfig.getAsJsonObject(featureKey);
        }
        return new JsonObject();
    }

    /**
     * Build Ai Feature Availability
     *
     * @return json object
     */
    private JsonObject buildAiFeatureAvailability() {
        JsonObject availability = new JsonObject();
        availability.addProperty(AI_FEATURE_PROVIDER_CLAUDE, isAiFeatureProviderAvailable(AI_FEATURE_PROVIDER_CLAUDE));
        availability.addProperty(AI_FEATURE_PROVIDER_CODEX, isAiFeatureProviderAvailable(AI_FEATURE_PROVIDER_CODEX));
        return availability;
    }

    /**
     * Is Ai Feature Provider Available
     *
     * @param provider provider
     * @return boolean
     */
    private boolean isAiFeatureProviderAvailable(String provider) {
        try {
            DependencyManager dependencyManager = new DependencyManager();
            if (AI_FEATURE_PROVIDER_CODEX.equals(provider)) {
                return getActiveCodexProvider() != null && dependencyManager.isInstalled("codex-sdk");
            }
            return getActiveClaudeProvider() != null && dependencyManager.isInstalled("claude-sdk");
        } catch (Exception e) {
            LOG.warn("[CodemossSettings] Failed to resolve AI feature availability for " + provider + ": " + e.getMessage());
            return false;
        }
    }

    /**
     * Get Normalized Ai Feature Models
     *
     * @param featureConfig feature config
     * @param defaultClaudeModel default claude model
     * @param defaultCodexModel default codex model
     * @return json object
     */
    private JsonObject getNormalizedAiFeatureModels(
            JsonObject featureConfig,
            String defaultClaudeModel,
            String defaultCodexModel
    ) {
        if (featureConfig != null
                && featureConfig.has(AI_FEATURE_MODELS_KEY)
                && featureConfig.get(AI_FEATURE_MODELS_KEY).isJsonObject()) {
            JsonObject rawModels = featureConfig.getAsJsonObject(AI_FEATURE_MODELS_KEY);
            String claudeModel = rawModels.has(AI_FEATURE_PROVIDER_CLAUDE) && !rawModels.get(AI_FEATURE_PROVIDER_CLAUDE).isJsonNull()
                    ? rawModels.get(AI_FEATURE_PROVIDER_CLAUDE).getAsString()
                    : null;
            String codexModel = rawModels.has(AI_FEATURE_PROVIDER_CODEX) && !rawModels.get(AI_FEATURE_PROVIDER_CODEX).isJsonNull()
                    ? rawModels.get(AI_FEATURE_PROVIDER_CODEX).getAsString()
                    : null;
            return createAiFeatureModels(claudeModel, codexModel, defaultClaudeModel, defaultCodexModel);
        }
        return createAiFeatureModels(null, null, defaultClaudeModel, defaultCodexModel);
    }

    /**
     * Create Ai Feature Models
     *
     * @param claudeModel claude model
     * @param codexModel codex model
     * @param defaultClaudeModel default claude model
     * @param defaultCodexModel default codex model
     * @return json object
     */
    private JsonObject createAiFeatureModels(
            String claudeModel,
            String codexModel,
            String defaultClaudeModel,
            String defaultCodexModel
    ) {
        JsonObject models = new JsonObject();
        models.addProperty(
                AI_FEATURE_PROVIDER_CLAUDE,
                normalizeAiFeatureModel(claudeModel, defaultClaudeModel)
        );
        models.addProperty(
                AI_FEATURE_PROVIDER_CODEX,
                normalizeAiFeatureModel(codexModel, defaultCodexModel)
        );
        return models;
    }

    /**
     * Resolve Ai Feature Provider
     *
     * @param manualProvider manual provider
     * @param claudeAvailable claude available
     * @param codexAvailable codex available
     * @return resolved ai feature provider
     */
    private ResolvedAiFeatureProvider resolveAiFeatureProvider(
            String manualProvider,
            boolean claudeAvailable,
            boolean codexAvailable
    ) {
        if (manualProvider != null) {
            boolean manualProviderAvailable = AI_FEATURE_PROVIDER_CODEX.equals(manualProvider)
                    ? codexAvailable
                    : claudeAvailable;
            if (manualProviderAvailable) {
                return new ResolvedAiFeatureProvider(manualProvider, AI_FEATURE_RESOLUTION_MANUAL);
            }
            return new ResolvedAiFeatureProvider(null, AI_FEATURE_RESOLUTION_UNAVAILABLE);
        }
        if (codexAvailable) {
            return new ResolvedAiFeatureProvider(AI_FEATURE_PROVIDER_CODEX, AI_FEATURE_RESOLUTION_AUTO);
        }
        if (claudeAvailable) {
            return new ResolvedAiFeatureProvider(AI_FEATURE_PROVIDER_CLAUDE, AI_FEATURE_RESOLUTION_AUTO);
        }
        return new ResolvedAiFeatureProvider(null, AI_FEATURE_RESOLUTION_UNAVAILABLE);
    }

    /**
     * Normalize Ai Feature Provider
     *
     * @param provider provider
     * @return string
     */
    private String normalizeAiFeatureProvider(String provider) {
        if (provider == null) {
            return null;
        }
        String normalized = provider.trim().toLowerCase();
        if (normalized.isEmpty()) {
            return null;
        }
        if (AI_FEATURE_PROVIDER_CLAUDE.equals(normalized) || AI_FEATURE_PROVIDER_CODEX.equals(normalized)) {
            return normalized;
        }
        return null;
    }

    /**
     * Normalize Ai Feature Model
     *
     * @param model model
     * @param defaultValue default value
     * @return string
     */
    private String normalizeAiFeatureModel(String model, String defaultValue) {
        if (model == null) {
            return defaultValue;
        }
        String normalized = model.trim();
        return normalized.isEmpty() ? defaultValue : normalized;
    }

    /** Resolved AI feature provider with its resolution source (manual / auto / unavailable). */
    private static class ResolvedAiFeatureProvider {
        private final String effectiveProvider;
        private final String resolutionSource;

        private ResolvedAiFeatureProvider(String effectiveProvider, String resolutionSource) {
            this.effectiveProvider = effectiveProvider;
            this.resolutionSource = resolutionSource;
        }
    }

    // ==================== Codex Provider Management ====================

    /**
     * Get Codex Providers
     *
     * @return list
     * @throws IOException
     */
    public List<JsonObject> getCodexProviders() throws IOException {
        return codexProviderManager.getCodexProviders();
    }

    /**
     * Get Active Codex Provider
     *
     * @return json object
     * @throws IOException
     */
    public JsonObject getActiveCodexProvider() throws IOException {
        return codexProviderManager.getActiveCodexProvider();
    }

    /**
     * Add Codex Provider
     *
     * @param provider provider
     * @throws IOException
     */
    public void addCodexProvider(JsonObject provider) throws IOException {
        codexProviderManager.addCodexProvider(provider);
    }

    /**
     * Save Codex Provider
     *
     * @param provider provider
     * @throws IOException
     */
    public void saveCodexProvider(JsonObject provider) throws IOException {
        codexProviderManager.saveCodexProvider(provider);
    }

    /**
     * Update Codex Provider
     *
     * @param id id
     * @param updates updates
     * @throws IOException
     */
    public void updateCodexProvider(String id, JsonObject updates) throws IOException {
        codexProviderManager.updateCodexProvider(id, updates);
    }

    /**
     * Delete Codex Provider
     *
     * @param id id
     * @return delete result
     */
    public DeleteResult deleteCodexProvider(String id) {
        return codexProviderManager.deleteCodexProvider(id);
    }

    /**
     * Switch Codex Provider
     *
     * @param id id
     * @throws IOException
     */
    public void switchCodexProvider(String id) throws IOException {
        codexProviderManager.switchCodexProvider(id);
    }

    /**
     * Apply Active Provider To Codex Settings
     *
     * @throws IOException
     */
    public void applyActiveProviderToCodexSettings() throws IOException {
        codexProviderManager.applyActiveProviderToCodexSettings();
    }

    /**
     * Get Current Codex Config
     *
     * @return json object
     * @throws IOException
     */
    public JsonObject getCurrentCodexConfig() throws IOException {
        if (!isCodexLocalConfigAuthorized()) {
            return new JsonObject();
        }
        return codexProviderManager.getCurrentCodexConfig();
    }

    /**
     * Is Codex Cli Login Available
     *
     * @return boolean
     */
    public boolean isCodexCliLoginAvailable() {
        try {
            if (!isCodexLocalConfigAuthorized()) {
                return false;
            }
            return codexSettingsManager.isCodexCliLoginAvailable();
        } catch (IOException e) {
            LOG.warn("[CodemossSettings] Failed to check Codex local authorization: " + e.getMessage());
            return false;
        }
    }

    /**
     * Apply Codex Cli Login To Settings
     *
     * @throws IOException
     */
    public void applyCodexCliLoginToSettings() throws IOException {
        codexSettingsManager.applyCodexCliLoginToSettings();
    }

    /**
     * Remove Codex Cli Login From Settings
     *
     * @throws IOException
     */
    public void removeCodexCliLoginFromSettings() throws IOException {
        codexSettingsManager.removeCodexCliLoginFromSettings();
    }

    /**
     * Read Codex Cli Login Account Info
     *
     * @return json object
     */
    public JsonObject readCodexCliLoginAccountInfo() {
        try {
            if (!isCodexLocalConfigAuthorized()) {
                return null;
            }
            return codexSettingsManager.readCodexCliLoginAccountInfo();
        } catch (IOException e) {
            LOG.warn("[CodemossSettings] Failed to read Codex local authorization state: " + e.getMessage());
            return null;
        }
    }

    /**
     * Is Codex Local Config Authorized
     *
     * @return boolean
     * @throws IOException
     */
    public boolean isCodexLocalConfigAuthorized() throws IOException {
        JsonObject config = readConfig();
        if (!config.has("codex") || !config.get("codex").isJsonObject()) {
            return false;
        }
        JsonObject codex = config.getAsJsonObject("codex");
        return codex.has("localConfigAuthorized")
                && !codex.get("localConfigAuthorized").isJsonNull()
                && codex.get("localConfigAuthorized").getAsBoolean();
    }

    /**
     * Set Codex Local Config Authorized
     *
     * @param authorized authorized
     * @throws IOException
     */
    public void setCodexLocalConfigAuthorized(boolean authorized) throws IOException {
        JsonObject config = readConfig();
        JsonObject codex;
        if (config.has("codex") && config.get("codex").isJsonObject()) {
            codex = config.getAsJsonObject("codex");
        } else {
            codex = new JsonObject();
            codex.add("providers", new JsonObject());
            codex.addProperty("current", "");
            config.add("codex", codex);
        }

        codex.addProperty("localConfigAuthorized", authorized);
        writeConfig(config);
    }

    /**
     * Get Codex Runtime Access Mode
     *
     * @return string
     * @throws IOException
     */
    public String getCodexRuntimeAccessMode() throws IOException {
        JsonObject config = readConfig();
        if (!config.has("codex") || !config.get("codex").isJsonObject()) {
            return CODEX_RUNTIME_ACCESS_INACTIVE;
        }

        JsonObject codex = config.getAsJsonObject("codex");
        String currentId = codex.has("current") && !codex.get("current").isJsonNull()
                ? codex.get("current").getAsString().trim()
                : "";

        if (CodexProviderManager.CODEX_CLI_LOGIN_PROVIDER_ID.equals(currentId)) {
            return isCodexLocalConfigAuthorized()
                    ? CODEX_RUNTIME_ACCESS_CLI_LOGIN
                    : CODEX_RUNTIME_ACCESS_INACTIVE;
        }

        if (!currentId.isEmpty()
                && codex.has("providers")
                && codex.get("providers").isJsonObject()
                && codex.getAsJsonObject("providers").has(currentId)) {
            return CODEX_RUNTIME_ACCESS_MANAGED;
        }

        return CODEX_RUNTIME_ACCESS_INACTIVE;
    }

    /**
     * Save Codex Providers
     *
     * @param providers providers
     * @return int
     * @throws IOException
     */
    public int saveCodexProviders(List<JsonObject> providers) throws IOException {
        return codexProviderManager.saveProviders(providers);
    }

    /**
     * Save Codex Provider Order
     *
     * @param orderedIds ordered ids
     * @throws IOException
     */
    public void saveCodexProviderOrder(List<String> orderedIds) throws IOException {
        codexProviderManager.saveProviderOrder(orderedIds);
    }
}
