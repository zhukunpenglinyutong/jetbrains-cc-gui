package com.github.claudecodegui.handler;

import com.github.claudecodegui.CodemossSettingsService;
import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.session.ClaudeMessageHandler;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.util.ThemeConfigService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.vfs.VirtualFile;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

/**
 * Settings and usage statistics message handler.
 */
public class SettingsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(SettingsHandler.class);

    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";
    private static final String PERMISSION_MODE_PROPERTY_KEY = "claude.code.permission.mode";
    private static final String SEND_SHORTCUT_PROPERTY_KEY = "claude.code.send.shortcut";

    private static final String[] SUPPORTED_TYPES = {
        "get_mode",
        "set_mode",
        "set_model",
        "set_provider",
        "set_reasoning_effort",
        "get_node_path",
        "set_node_path",
        "get_usage_statistics",
        "get_working_directory",
        "set_working_directory",
        "get_editor_font_config",
        "get_streaming_enabled",
        "set_streaming_enabled",
        "get_send_shortcut",
        "set_send_shortcut",
        "get_auto_open_file_enabled",
        "set_auto_open_file_enabled",
        "get_ide_theme",
        "get_commit_prompt",
        "set_commit_prompt",
        "get_input_history",
        "record_input_history",
        "delete_input_history_item",
        "clear_input_history"
    };

    private static final Map<String, Integer> MODEL_CONTEXT_LIMITS = new HashMap<>();
    static {
        // Claude models
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-6", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-6", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-haiku-4-5", 200_000);
        // Codex/OpenAI models
        MODEL_CONTEXT_LIMITS.put("gpt-5.2-codex", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1-codex-max", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1-codex-mini", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.2", 258_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-5.1-codex", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4o", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4o-mini", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4-turbo", 128_000);
        MODEL_CONTEXT_LIMITS.put("gpt-4", 8_192);
        MODEL_CONTEXT_LIMITS.put("o3", 200_000);
        MODEL_CONTEXT_LIMITS.put("o3-mini", 200_000);
        MODEL_CONTEXT_LIMITS.put("o1", 200_000);
        MODEL_CONTEXT_LIMITS.put("o1-mini", 128_000);
        MODEL_CONTEXT_LIMITS.put("o1-preview", 128_000);
    }

    public SettingsHandler(HandlerContext context) {
        super(context);
        // Register theme change listener to automatically notify frontend when IDE theme changes
        registerThemeChangeListener();
    }

    /**
     * Register theme change listener.
     */
    private void registerThemeChangeListener() {
        ThemeConfigService.registerThemeChangeListener(themeConfig -> {
            // Notify frontend when theme changes
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onIdeThemeChanged", escapeJs(themeConfig.toString()));
            });
        });
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_mode":
                handleGetMode();
                return true;
            case "set_mode":
                handleSetMode(content);
                return true;
            case "set_model":
                handleSetModel(content);
                return true;
            case "set_provider":
                handleSetProvider(content);
                return true;
            case "set_reasoning_effort":
                handleSetReasoningEffort(content);
                return true;
            case "get_node_path":
                handleGetNodePath();
                return true;
            case "set_node_path":
                handleSetNodePath(content);
                return true;
            case "get_usage_statistics":
                handleGetUsageStatistics(content);
                return true;
            case "get_working_directory":
                handleGetWorkingDirectory();
                return true;
            case "set_working_directory":
                handleSetWorkingDirectory(content);
                return true;
            case "get_editor_font_config":
                handleGetEditorFontConfig();
                return true;
            case "get_streaming_enabled":
                handleGetStreamingEnabled();
                return true;
            case "set_streaming_enabled":
                handleSetStreamingEnabled(content);
                return true;
            case "get_send_shortcut":
                handleGetSendShortcut();
                return true;
            case "set_send_shortcut":
                handleSetSendShortcut(content);
                return true;
            case "get_auto_open_file_enabled":
                handleGetAutoOpenFileEnabled();
                return true;
            case "set_auto_open_file_enabled":
                handleSetAutoOpenFileEnabled(content);
                return true;
            case "get_ide_theme":
                handleGetIdeTheme();
                return true;
            case "get_commit_prompt":
                handleGetCommitPrompt();
                return true;
            case "set_commit_prompt":
                handleSetCommitPrompt(content);
                return true;
            case "get_input_history":
                handleGetInputHistory();
                return true;
            case "record_input_history":
                handleRecordInputHistory(content);
                return true;
            case "delete_input_history_item":
                handleDeleteInputHistoryItem(content);
                return true;
            case "clear_input_history":
                handleClearInputHistory();
                return true;
            default:
                return false;
        }
    }

    /**
     * Get current permission mode.
     */
    private void handleGetMode() {
        try {
            String currentMode = "bypassPermissions";  // Default value

            // Prefer getting from session first
            if (context.getSession() != null) {
                String sessionMode = context.getSession().getPermissionMode();
                if (sessionMode != null && !sessionMode.trim().isEmpty()) {
                    currentMode = sessionMode;
                }
            } else {
                // If session does not exist, load from persistent storage
                PropertiesComponent props = PropertiesComponent.getInstance();
                String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
                if (savedMode != null && !savedMode.trim().isEmpty()) {
                    currentMode = savedMode.trim();
                }
            }

            final String modeToSend = currentMode;

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onModeReceived", escapeJs(modeToSend));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get mode: " + e.getMessage(), e);
        }
    }

    /**
     * Handle set mode request.
     */
    private void handleSetMode(String content) {
        try {
            // LOG.info("[SettingsHandler] ========== RECEIVED SET_MODE REQUEST ==========");
            // LOG.info("[SettingsHandler] Raw content: " + content);

            String mode = content;
            if (content != null && !content.isEmpty()) {
                try {
                    Gson gson = new Gson();
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("mode")) {
                        mode = json.get("mode").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the mode
                    // LOG.debug("[SettingsHandler] Content is not JSON, treating as plain string");
                }
            }

            // LOG.info("[SettingsHandler] Parsed permission mode: " + mode);

            // Check if session exists
            if (context.getSession() != null) {
                // LOG.info("[SettingsHandler] Session exists, setting permission mode...");
                context.getSession().setPermissionMode(mode);

                // Save permission mode to persistent storage
                PropertiesComponent props = PropertiesComponent.getInstance();
                props.setValue(PERMISSION_MODE_PROPERTY_KEY, mode);
                LOG.info("Saved permission mode to settings: " + mode);
                com.github.claudecodegui.notifications.ClaudeNotifier.setMode(context.getProject(), mode);

                // Verify that the setting was applied successfully
                // String currentMode = context.getSession().getPermissionMode();
                // LOG.info("[SettingsHandler] Session permission mode confirmed: " + currentMode);
                // LOG.info("[SettingsHandler] Mode update " + (mode.equals(currentMode) ? "SUCCESS" : "FAILED"));
            } else {
                LOG.warn("[SettingsHandler] WARNING: Session is null! Cannot set permission mode");
            }
            // LOG.info("[SettingsHandler] =============================================");
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set mode: " + e.getMessage(), e);
        }
    }

    /**
     * Handle set model request.
     * Sends a confirmation callback to the frontend after setting, ensuring frontend-backend state sync.
     *
     * Capacity calculation optimization: when the frontend selects a base model (e.g. claude-sonnet-4-6),
     * the actual model configuration is looked up from settings (e.g. ANTHROPIC_DEFAULT_SONNET_MODEL),
     * to support custom model names with capacity suffixes (e.g. claude-sonnet-4-6[1M]).
     */
    private void handleSetModel(String content) {
        try {
            String model = content;
            if (content != null && !content.isEmpty()) {
                try {
                    Gson gson = new Gson();
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("model")) {
                        model = json.get("model").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the model
                }
            }

            LOG.info("[SettingsHandler] Setting model to: " + model);

            // Try to get the actual configured model name from settings (supports capacity suffix)
            String actualModel = resolveActualModelName(model);
            String finalModelName;
            if (actualModel != null && !actualModel.equals(model)) {
                LOG.info("[SettingsHandler] Resolved to actual model: " + actualModel);
                context.setCurrentModel(actualModel);
                finalModelName = actualModel;
            } else {
                context.setCurrentModel(model);
                finalModelName = model;
            }

            if (context.getSession() != null) {
                context.getSession().setModel(model);
            }

            // Update status bar with basic model name
            com.github.claudecodegui.notifications.ClaudeNotifier.setModel(context.getProject(), model);

            // Calculate the context limit for the new model
            int newMaxTokens = getModelContextLimit(finalModelName);
            LOG.info("[SettingsHandler] Model context limit: " + newMaxTokens + " tokens for model: " + finalModelName);

            // Send confirmation callback to frontend, ensuring frontend-backend state sync
            final String confirmedModel = model;
            final String confirmedProvider = context.getCurrentProvider();
            ApplicationManager.getApplication().invokeLater(() -> {
                // Send model confirmation
                callJavaScript("window.onModelConfirmed", escapeJs(confirmedModel), escapeJs(confirmedProvider));

                // Recalculate and push usage update, ensuring maxTokens is updated for the new model
                pushUsageUpdateAfterModelChange(newMaxTokens);
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set model: " + e.getMessage(), e);
        }
    }

    /**
     * Push usage update after model switch.
     * Recalculates percentage and maxTokens based on the new model's context limit.
     */
    private void pushUsageUpdateAfterModelChange(int newMaxTokens) {
        try {
            ClaudeSession session = context.getSession();
            if (session == null) {
                // Even without a session, send update so frontend knows the new maxTokens
                sendUsageUpdate(0, newMaxTokens);
                return;
            }

            // Extract the latest usage information from the current session
            List<ClaudeSession.Message> messages = session.getMessages();
            JsonObject lastUsage = ClaudeMessageHandler.findLastUsageFromSessionMessages(messages);
            if (lastUsage == null) {
                // No usage data available yet — send update with zero used tokens
                sendUsageUpdate(0, newMaxTokens);
                return;
            }
            int usedTokens = ClaudeMessageHandler.extractUsedTokens(lastUsage, context.getCurrentProvider());

            // Send update
            sendUsageUpdate(usedTokens, newMaxTokens);

        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to push usage update after model change: " + e.getMessage(), e);
        }
    }

    /**
     * Send usage update to the frontend.
     */
    private void sendUsageUpdate(int usedTokens, int maxTokens) {
        int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);

        LOG.info("[SettingsHandler] Sending usage update: usedTokens=" + usedTokens + ", maxTokens=" + maxTokens + ", percentage=" + percentage + "%");

        // Build usage update data
        JsonObject usageUpdate = new JsonObject();
        usageUpdate.addProperty("percentage", percentage);
        usageUpdate.addProperty("totalTokens", usedTokens);
        usageUpdate.addProperty("limit", maxTokens);
        usageUpdate.addProperty("usedTokens", usedTokens);
        usageUpdate.addProperty("maxTokens", maxTokens);

        String usageJson = new Gson().toJson(usageUpdate);

        // Push to frontend (must be executed on the EDT thread)
        ApplicationManager.getApplication().invokeLater(() -> {
            if (context.getBrowser() != null && !context.isDisposed()) {
                String js = "(function() {" +
                        "  if (typeof window.onUsageUpdate === 'function') {" +
                        "    window.onUsageUpdate('" + escapeJs(usageJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } else {
                LOG.warn("[SettingsHandler] Cannot send usage update: browser is null or disposed");
            }
        });
    }

    /**
     * Handle set provider request.
     */
    private void handleSetProvider(String content) {
        try {
            String provider = content;
            if (content != null && !content.isEmpty()) {
                try {
                    Gson gson = new Gson();
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("provider")) {
                        provider = json.get("provider").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the provider
                }
            }

            LOG.info("[SettingsHandler] Setting provider to: " + provider);
            context.setCurrentProvider(provider);

            if (context.getSession() != null) {
                context.getSession().setProvider(provider);
            }

            refreshContextBar();
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set provider: " + e.getMessage(), e);
        }
    }

    private void refreshContextBar() {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getProject() == null) {
                    return;
                }

                // Check if auto-open file is enabled
                String projectPath = context.getProject().getBasePath();
                if (projectPath != null) {
                    com.github.claudecodegui.CodemossSettingsService settingsService =
                        new com.github.claudecodegui.CodemossSettingsService();
                    boolean autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);
                    if (!autoOpenFileEnabled) {
                        // If auto-open file is disabled, clear the ContextBar display
                        callJavaScript("clearSelectionInfo");
                        return;
                    }
                }

                FileEditorManager editorManager = FileEditorManager.getInstance(context.getProject());
                Editor editor = editorManager.getSelectedTextEditor();
                String selectionInfo = null;

                if (editor != null) {
                    VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
                    if (file != null) {
                        String path = file.getPath();
                        selectionInfo = "@" + path;

                        SelectionModel selectionModel = editor.getSelectionModel();
                        if (selectionModel.hasSelection()) {
                            int startLine = editor.getDocument().getLineNumber(selectionModel.getSelectionStart()) + 1;
                            int endLine = editor.getDocument().getLineNumber(selectionModel.getSelectionEnd()) + 1;

                            if (endLine > startLine
                                    && editor.offsetToLogicalPosition(selectionModel.getSelectionEnd()).column == 0) {
                                endLine--;
                            }
                            selectionInfo += "#L" + startLine + "-" + endLine;
                        }
                    }
                } else {
                    VirtualFile[] files = editorManager.getSelectedFiles();
                    if (files.length > 0 && files[0] != null) {
                        selectionInfo = "@" + files[0].getPath();
                    }
                }

                if (selectionInfo != null && !selectionInfo.isEmpty()) {
                    callJavaScript("addSelectionInfo", escapeJs(selectionInfo));
                } else {
                    callJavaScript("clearSelectionInfo");
                }
            } catch (Exception e) {
                LOG.warn("[SettingsHandler] Failed to refresh context bar: " + e.getMessage());
            }
        });
    }

    /**
     * Handle set reasoning effort request (Codex only).
     */
    private void handleSetReasoningEffort(String content) {
        try {
            String effort = content;
            if (content != null && !content.isEmpty()) {
                try {
                    Gson gson = new Gson();
                    JsonObject json = gson.fromJson(content, JsonObject.class);
                    if (json.has("reasoningEffort")) {
                        effort = json.get("reasoningEffort").getAsString();
                    }
                } catch (Exception e) {
                    // content itself is the effort
                }
            }

            LOG.info("[SettingsHandler] Setting reasoning effort to: " + effort);

            if (context.getSession() != null) {
                context.getSession().setReasoningEffort(effort);
            }
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set reasoning effort: " + e.getMessage(), e);
        }
    }

    /**
     * Get Node.js path and version information.
     */
    private void handleGetNodePath() {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String saved = props.getValue(NODE_PATH_PROPERTY_KEY);
            String pathToSend = "";
            String versionToSend = null;

            if (saved != null && !saved.trim().isEmpty()) {
                pathToSend = saved.trim();
                NodeDetectionResult result = context.getClaudeSDKBridge().verifyAndCacheNodePath(pathToSend);
                if (result != null && result.isFound()) {
                    versionToSend = result.getNodeVersion();
                }
            } else {
                NodeDetectionResult detected = context.getClaudeSDKBridge().detectNodeWithDetails();
                if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                    pathToSend = detected.getNodePath();
                    versionToSend = detected.getNodeVersion();
                    props.setValue(NODE_PATH_PROPERTY_KEY, pathToSend);
                    // Use verifyAndCacheNodePath instead of setNodeExecutable to ensure version info is cached
                    context.getClaudeSDKBridge().verifyAndCacheNodePath(pathToSend);
                    context.getCodexSDKBridge().setNodeExecutable(pathToSend);
                }
            }

            final String finalPath = pathToSend;
            final String finalVersion = versionToSend;

            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("path", finalPath);
                response.addProperty("version", finalVersion);
                response.addProperty("minVersion", NodeDetector.MIN_NODE_MAJOR_VERSION);
                callJavaScript("window.updateNodePath", escapeJs(new Gson().toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get Node.js path: " + e.getMessage(), e);
        }
    }

    /**
     * Set Node.js path.
     */
    private void handleSetNodePath(String content) {
        LOG.debug("[SettingsHandler] ========== handleSetNodePath START ==========");
        LOG.debug("[SettingsHandler] Received content: " + content);
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String path = null;
            if (json != null && json.has("path") && !json.get("path").isJsonNull()) {
                path = json.get("path").getAsString();
            }

            if (path != null) {
                path = path.trim();
            }

            PropertiesComponent props = PropertiesComponent.getInstance();
            String finalPath = "";
            String versionToSend = null;
            boolean verifySuccess = false;
            String failureMsg = null;

            if (path == null || path.isEmpty()) {
                props.unsetValue(NODE_PATH_PROPERTY_KEY);
                context.getClaudeSDKBridge().setNodeExecutable(null);
                context.getCodexSDKBridge().setNodeExecutable(null);
                LOG.info("[SettingsHandler] Cleared manual Node.js path from settings");

                NodeDetectionResult detected = context.getClaudeSDKBridge().detectNodeWithDetails();
                if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                    finalPath = detected.getNodePath();
                    versionToSend = detected.getNodeVersion();
                    props.setValue(NODE_PATH_PROPERTY_KEY, finalPath);
                    // Use verifyAndCacheNodePath to ensure version info is cached
                    context.getClaudeSDKBridge().verifyAndCacheNodePath(finalPath);
                    context.getCodexSDKBridge().setNodeExecutable(finalPath);
                    verifySuccess = true;
                }
            } else {
                props.setValue(NODE_PATH_PROPERTY_KEY, path);
                NodeDetectionResult result = context.getClaudeSDKBridge().verifyAndCacheNodePath(path);
                context.getCodexSDKBridge().setNodeExecutable(path);
                LOG.info("[SettingsHandler] Updated manual Node.js path from settings: " + path);
                finalPath = path;
                if (result != null && result.isFound()) {
                    versionToSend = result.getNodeVersion();
                    verifySuccess = true;
                } else {
                    failureMsg = result != null ? result.getErrorMessage() : "无法验证指定的 Node.js 路径";
                }
            }

            final boolean successFlag = verifySuccess;
            final String failureMsgFinal = failureMsg;
            final String finalPathToSend = finalPath;
            final String finalVersionToSend = versionToSend;

            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("path", finalPathToSend);
                response.addProperty("version", finalVersionToSend);
                response.addProperty("minVersion", NodeDetector.MIN_NODE_MAJOR_VERSION);
                callJavaScript("window.updateNodePath", escapeJs(gson.toJson(response)));

                if (successFlag) {
                    // Trigger environment re-check, no IDE restart needed
                    callJavaScript("window.showSwitchSuccess", escapeJs("Node.js 路径已保存并生效,无需重启IDE"));

                    // Notify DependencySection to re-check Node.js environment
                    callJavaScript("window.checkNodeEnvironment");
                } else {
                    String msg = failureMsgFinal != null ? failureMsgFinal : "无法验证指定的 Node.js 路径";
                    callJavaScript("window.showError", escapeJs("保存的 Node.js 路径无效: " + msg));
                }
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set Node.js path: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("保存 Node.js 路径失败: " + e.getMessage()));
            });
        }
        LOG.debug("[SettingsHandler] ========== handleSetNodePath END ==========");
    }

    /**
     * Get usage statistics.
     * Supports both Claude and Codex providers.
     */
    private void handleGetUsageStatistics(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String projectPath = "all";
                String provider = "claude"; // Default to Claude

                if (content != null && !content.isEmpty() && !content.equals("{}")) {
                    try {
                        Gson gson = new Gson();
                        JsonObject json = gson.fromJson(content, JsonObject.class);

                        // Parse scope
                        if (json.has("scope")) {
                            String scope = json.get("scope").getAsString();
                            if ("current".equals(scope)) {
                                projectPath = context.getProject().getBasePath();
                            } else {
                                projectPath = "all";
                            }
                        }

                        // Parse provider (claude or codex)
                        if (json.has("provider")) {
                            provider = json.get("provider").getAsString();
                        }
                    } catch (Exception e) {
                        if ("current".equals(content)) {
                            projectPath = context.getProject().getBasePath();
                        } else {
                            projectPath = content;
                        }
                    }
                }

                // Use corresponding reader based on provider
                String json;
                if ("codex".equals(provider)) {
                    CodexHistoryReader reader = new CodexHistoryReader();
                    CodexHistoryReader.ProjectStatistics stats = reader.getProjectStatistics(projectPath);

                    // Debug logging for Codex statistics
                    LOG.info("[SettingsHandler] Codex statistics - sessions: " + stats.totalSessions +
                             ", cost: " + stats.estimatedCost +
                             ", input tokens: " + stats.totalUsage.inputTokens +
                             ", output tokens: " + stats.totalUsage.outputTokens +
                             ", cache read tokens: " + stats.totalUsage.cacheReadTokens +
                             ", total tokens: " + stats.totalUsage.totalTokens);

                    Gson gson = new Gson();
                    json = gson.toJson(stats);
                } else {
                    ClaudeHistoryReader reader = new ClaudeHistoryReader();
                    ClaudeHistoryReader.ProjectStatistics stats = reader.getProjectStatistics(projectPath);
                    Gson gson = new Gson();
                    json = gson.toJson(stats);
                }

                final String statsJsonFinal = json;

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.updateUsageStatistics", escapeJs(statsJsonFinal));
                });
            } catch (Exception e) {
                LOG.error("[SettingsHandler] Failed to get usage statistics: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("获取统计数据失败: " + e.getMessage()));
                });
            }
        });
    }

    /**
     * Get working directory configuration.
     */
    private void handleGetWorkingDirectory() {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.updateWorkingDirectory", "{}");
                });
                return;
            }

            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            String customWorkingDir = settingsService.getCustomWorkingDirectory(projectPath);

            Gson gson = new Gson();
            JsonObject response = new JsonObject();
            response.addProperty("projectPath", projectPath);
            response.addProperty("customWorkingDir", customWorkingDir != null ? customWorkingDir : "");

            String json = gson.toJson(response);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.updateWorkingDirectory", escapeJs(json));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get working directory: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("获取工作目录配置失败: " + e.getMessage()));
            });
        }
    }

    /**
     * Set working directory configuration.
     */
    private void handleSetWorkingDirectory(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("无法获取项目路径"));
                });
                return;
            }

            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String customWorkingDir = null;

            if (json != null && json.has("customWorkingDir") && !json.get("customWorkingDir").isJsonNull()) {
                customWorkingDir = json.get("customWorkingDir").getAsString();
            }

            // Validate that the custom working directory exists
            if (customWorkingDir != null && !customWorkingDir.trim().isEmpty()) {
                java.io.File workingDirFile = new java.io.File(customWorkingDir);
                if (!workingDirFile.isAbsolute()) {
                    workingDirFile = new java.io.File(projectPath, customWorkingDir);
                }

                if (!workingDirFile.exists() || !workingDirFile.isDirectory()) {
                    final String errorPath = workingDirFile.getAbsolutePath();
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.showError", escapeJs("工作目录不存在: " + errorPath));
                    });
                    return;
                }
            }

            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            settingsService.setCustomWorkingDirectory(projectPath, customWorkingDir);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showSuccess", escapeJs("工作目录配置已保存"));
            });

            LOG.info("[SettingsHandler] Set custom working directory: " + customWorkingDir);
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set working directory: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("保存工作目录配置失败: " + e.getMessage()));
            });
        }
    }

    /**
     * Get IDEA editor font configuration.
     */
    private void handleGetEditorFontConfig() {
        try {
            JsonObject fontConfig = FontConfigService.getEditorFontConfig();
            String fontConfigJson = fontConfig.toString();

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onEditorFontConfigReceived", escapeJs(fontConfigJson));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get editor font config: " + e.getMessage(), e);
        }
    }

    /**
     * Get streaming configuration.
     */
    private void handleGetStreamingEnabled() {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject response = new JsonObject();
                    response.addProperty("streamingEnabled", true);
                    callJavaScript("window.updateStreamingEnabled", escapeJs(new Gson().toJson(response)));
                });
                return;
            }

            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            boolean streamingEnabled = settingsService.getStreamingEnabled(projectPath);

            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("streamingEnabled", streamingEnabled);
                callJavaScript("window.updateStreamingEnabled", escapeJs(new Gson().toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get streaming enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("streamingEnabled", true);
                callJavaScript("window.updateStreamingEnabled", escapeJs(new Gson().toJson(response)));
            });
        }
    }

    /**
     * Set streaming configuration.
     */
    private void handleSetStreamingEnabled(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("无法获取项目路径"));
                });
                return;
            }

            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean streamingEnabled = true;

            if (json != null && json.has("streamingEnabled") && !json.get("streamingEnabled").isJsonNull()) {
                streamingEnabled = json.get("streamingEnabled").getAsBoolean();
            }

            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            settingsService.setStreamingEnabled(projectPath, streamingEnabled);

            LOG.info("[SettingsHandler] Set streaming enabled: " + streamingEnabled);

            // Return updated state
            final boolean finalStreamingEnabled = streamingEnabled;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("streamingEnabled", finalStreamingEnabled);
                callJavaScript("window.updateStreamingEnabled", escapeJs(gson.toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set streaming enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("保存流式传输配置失败: " + e.getMessage()));
            });
        }
    }

    /**
     * Get auto-open file configuration.
     */
    private void handleGetAutoOpenFileEnabled() {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject response = new JsonObject();
                    response.addProperty("autoOpenFileEnabled", true);
                    callJavaScript("window.updateAutoOpenFileEnabled", escapeJs(new Gson().toJson(response)));
                });
                return;
            }

            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            boolean autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);

            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("autoOpenFileEnabled", autoOpenFileEnabled);
                callJavaScript("window.updateAutoOpenFileEnabled", escapeJs(new Gson().toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get auto open file enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("autoOpenFileEnabled", true);
                callJavaScript("window.updateAutoOpenFileEnabled", escapeJs(new Gson().toJson(response)));
            });
        }
    }

    /**
     * Set auto-open file configuration.
     */
    private void handleSetAutoOpenFileEnabled(String content) {
        try {
            String projectPath = context.getProject().getBasePath();
            if (projectPath == null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("无法获取项目路径"));
                });
                return;
            }

            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            boolean autoOpenFileEnabled = true;

            if (json != null && json.has("autoOpenFileEnabled") && !json.get("autoOpenFileEnabled").isJsonNull()) {
                autoOpenFileEnabled = json.get("autoOpenFileEnabled").getAsBoolean();
            }

            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            settingsService.setAutoOpenFileEnabled(projectPath, autoOpenFileEnabled);

            LOG.info("[SettingsHandler] Set auto open file enabled: " + autoOpenFileEnabled);

            // Return updated state
            final boolean finalAutoOpenFileEnabled = autoOpenFileEnabled;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("autoOpenFileEnabled", finalAutoOpenFileEnabled);
                callJavaScript("window.updateAutoOpenFileEnabled", escapeJs(gson.toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set auto open file enabled: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("保存自动打开文件配置失败: " + e.getMessage()));
            });
        }
    }

    /**
     * Resolve the actual model name used from settings.
     * Supports reading model names with capacity suffixes from ANTHROPIC_MODEL or ANTHROPIC_DEFAULT_*_MODEL.
     *
     * @param baseModel the base model ID selected by frontend (e.g. claude-sonnet-4-6, claude-haiku-4-5)
     * @return the actual model name configured in settings, or null if not configured
     */
    private String resolveActualModelName(String baseModel) {
        try {
            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            com.google.gson.JsonObject config = settingsService.readConfig();

            if (config == null || !config.has("activeProvider")) {
                return null;
            }

            String activeProviderId = config.get("activeProvider").getAsString();
            if (!"claude-code".equals(activeProviderId)) {
                return null;
            }

            if (!config.has("providers") || !config.get("providers").isJsonArray()) {
                return null;
            }

            com.google.gson.JsonArray providers = config.getAsJsonArray("providers");
            for (com.google.gson.JsonElement providerElement : providers) {
                if (!providerElement.isJsonObject()) continue;
                com.google.gson.JsonObject provider = providerElement.getAsJsonObject();

                if (!provider.has("id") || !"claude-code".equals(provider.get("id").getAsString())) {
                    continue;
                }

                if (!provider.has("settingsConfig") || !provider.get("settingsConfig").isJsonObject()) {
                    continue;
                }

                com.google.gson.JsonObject settingsConfig = provider.getAsJsonObject("settingsConfig");
                if (!settingsConfig.has("env") || !settingsConfig.get("env").isJsonObject()) {
                    continue;
                }

                com.google.gson.JsonObject env = settingsConfig.getAsJsonObject("env");

                // Look up corresponding environment variable by base model ID
                String actualModel = null;

                // First check ANTHROPIC_MODEL (main model configuration)
                if (env.has("ANTHROPIC_MODEL") && !env.get("ANTHROPIC_MODEL").isJsonNull()) {
                    String mainModel = env.get("ANTHROPIC_MODEL").getAsString();
                    if (mainModel != null && !mainModel.trim().isEmpty()) {
                        actualModel = mainModel.trim();
                    }
                }

                // If main model not configured, look up corresponding default model config by base model ID
                if (actualModel == null) {
                    if (baseModel.contains("sonnet") && env.has("ANTHROPIC_DEFAULT_SONNET_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_SONNET_MODEL").getAsString();
                    } else if (baseModel.contains("opus") && env.has("ANTHROPIC_DEFAULT_OPUS_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_OPUS_MODEL").getAsString();
                    } else if (baseModel.contains("haiku") && env.has("ANTHROPIC_DEFAULT_HAIKU_MODEL")) {
                        actualModel = env.get("ANTHROPIC_DEFAULT_HAIKU_MODEL").getAsString();
                    }
                }

                if (actualModel != null && !actualModel.trim().isEmpty()) {
                    return actualModel.trim();
                }
            }
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to resolve actual model name: " + e.getMessage());
        }

        return null;
    }

    /**
     * Get model context limit.
     * Supports parsing capacity suffix from model name, for example:
     * - claude-sonnet-4-6[1M] -> 1,000,000 tokens
     * - claude-opus-4-6[2M] -> 2,000,000 tokens
     * - claude-haiku-4-5[500k] -> 500,000 tokens
     * - claude-sonnet-4-6 [1.5M] -> 1,500,000 tokens (supports spaces and decimals)
     * - Case insensitive (1m and 1M both work)
     */
    public static int getModelContextLimit(String model) {
        if (model == null || model.isEmpty()) {
            return 200_000;
        }

        // Regex: matches trailing [number+unit], supports optional spaces, decimals, case insensitive
        // Examples: [1M], [2m], [500k], [1.5M], or with spaces [1M]
        java.util.regex.Pattern pattern = java.util.regex.Pattern.compile("\\s*\\[([0-9.]+)([kKmM])\\]\\s*$");
        java.util.regex.Matcher matcher = pattern.matcher(model);

        if (matcher.find()) {
            try {
                double value = Double.parseDouble(matcher.group(1));
                String unit = matcher.group(2).toLowerCase();

                if ("m".equals(unit)) {
                    // M (million) convert to tokens
                    return (int)(value * 1_000_000);
                } else if ("k".equals(unit)) {
                    // k (thousand) convert to tokens
                    return (int)(value * 1_000);
                }
            } catch (NumberFormatException e) {
                LOG.error("Failed to parse capacity from model name: " + model);
            }
        }

        // If no capacity suffix, try to look up from predefined mapping
        // Try exact match first, fall back to default if not found
        return MODEL_CONTEXT_LIMITS.getOrDefault(model, 200_000);
    }

    /**
     * Get send shortcut setting
     */
    private void handleGetSendShortcut() {
        try {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String sendShortcut = props.getValue(SEND_SHORTCUT_PROPERTY_KEY, "enter");

            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("sendShortcut", sendShortcut);
                callJavaScript("window.updateSendShortcut", escapeJs(new Gson().toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get send shortcut: " + e.getMessage(), e);
        }
    }

    /**
     * Set send shortcut setting
     */
    private void handleSetSendShortcut(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String sendShortcut = "enter";

            if (json != null && json.has("sendShortcut") && !json.get("sendShortcut").isJsonNull()) {
                sendShortcut = json.get("sendShortcut").getAsString();
            }

            // Validate value
            if (!"enter".equals(sendShortcut) && !"cmdEnter".equals(sendShortcut)) {
                sendShortcut = "enter";
            }

            PropertiesComponent props = PropertiesComponent.getInstance();
            props.setValue(SEND_SHORTCUT_PROPERTY_KEY, sendShortcut);

            LOG.info("[SettingsHandler] Set send shortcut: " + sendShortcut);

            // Return updated state
            final String finalSendShortcut = sendShortcut;
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("sendShortcut", finalSendShortcut);
                callJavaScript("window.updateSendShortcut", escapeJs(gson.toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set send shortcut: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("保存发送快捷键设置失败: " + e.getMessage()));
            });
        }
    }

    /**
     * Get Commit AI prompt.
     */
    private void handleGetCommitPrompt() {
        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            String commitPrompt = settingsService.getCommitPrompt();

            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("commitPrompt", commitPrompt);
                callJavaScript("window.updateCommitPrompt", escapeJs(new Gson().toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get commit prompt: " + e.getMessage(), e);
        }
    }

    /**
     * Set Commit AI prompt.
     */
    private void handleSetCommitPrompt(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);

            if (json == null || !json.has("prompt")) {
                LOG.warn("[SettingsHandler] Invalid commit prompt request: missing prompt field");
                return;
            }

            String prompt = json.get("prompt").getAsString();

            // Input validation
            if (prompt == null) {
                LOG.warn("[SettingsHandler] Invalid commit prompt: prompt is null");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("提示词不能为空"));
                });
                return;
            }

            // Trim whitespace
            prompt = prompt.trim();

            // Maximum length validation (10000 characters should be more than enough)
            final int MAX_PROMPT_LENGTH = 10000;
            if (prompt.length() > MAX_PROMPT_LENGTH) {
                LOG.warn("[SettingsHandler] Commit prompt too long: " + prompt.length() + " characters");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.showError", escapeJs("提示词长度不能超过 " + MAX_PROMPT_LENGTH + " 字符"));
                });
                return;
            }

            final String validatedPrompt = prompt;
            CodemossSettingsService settingsService = new CodemossSettingsService();
            settingsService.setCommitPrompt(validatedPrompt);

            LOG.info("[SettingsHandler] Set commit prompt, length: " + validatedPrompt.length());

            // Return success response and update frontend state to reset loading
            ApplicationManager.getApplication().invokeLater(() -> {
                JsonObject response = new JsonObject();
                response.addProperty("commitPrompt", validatedPrompt);
                response.addProperty("saved", true);
                callJavaScript("window.updateCommitPrompt", escapeJs(gson.toJson(response)));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set commit prompt: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.showError", escapeJs("保存 Commit 提示词失败: " + e.getMessage()));
            });
        }
    }

    /**
     * Get IDE theme configuration.
     */
    private void handleGetIdeTheme() {
        try {
            JsonObject themeConfig = ThemeConfigService.getIdeThemeConfig();
            String themeConfigJson = themeConfig.toString();

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.onIdeThemeReceived", escapeJs(themeConfigJson));
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to get IDE theme: " + e.getMessage(), e);
        }
    }

    // ==================== Input History Management ====================

    /**
     * Get input history records.
     */
    private void handleGetInputHistory() {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("getAllHistoryData", null);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.onInputHistoryLoaded", escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[SettingsHandler] Failed to get input history: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.onInputHistoryLoaded", escapeJs("{\"items\":[],\"counts\":{}}"));
                });
            }
        });
    }

    /**
     * Record input history.
     * @param content JSON array of fragments
     */
    private void handleRecordInputHistory(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryServiceWithArray("recordHistory", content);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.onInputHistoryRecorded", escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[SettingsHandler] Failed to record input history: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Delete a single input history item.
     * @param content the history item to delete
     */
    private void handleDeleteInputHistoryItem(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("deleteHistoryItem", content);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.onInputHistoryDeleted", escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[SettingsHandler] Failed to delete input history item: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Clear all input history.
     */
    private void handleClearInputHistory() {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("clearAllHistory", null);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.onInputHistoryCleared", escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[SettingsHandler] Failed to clear input history: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Call Node.js input-history-service (single parameter version).
     */
    private String callInputHistoryService(String functionName, String param) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        String nodeScript;
        if (param == null || param.isEmpty()) {
            // Call without parameters
            nodeScript = String.format(
                "const { %s } = require('%s/services/input-history-service.cjs'); " +
                "const result = %s(); " +
                "console.log(JSON.stringify(result));",
                functionName,
                bridgePath.replace("\\", "\\\\"),
                functionName
            );
        } else {
            // Single parameter call (passed via stdin to avoid escaping issues)
            nodeScript = String.format(
                "const { %s } = require('%s/services/input-history-service.cjs'); " +
                "let input = ''; " +
                "process.stdin.on('data', chunk => input += chunk); " +
                "process.stdin.on('end', () => { " +
                "  try { " +
                "    const param = input.trim(); " +
                "    const result = %s(param); " +
                "    console.log(JSON.stringify(result)); " +
                "  } catch (err) { " +
                "    console.error(JSON.stringify({ error: err.message })); " +
                "    process.exit(1); " +
                "  } " +
                "});",
                functionName,
                bridgePath.replace("\\", "\\\\"),
                functionName
            );
        }

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Write parameter to stdin if present
        if (param != null && !param.isEmpty()) {
            try (BufferedWriter writer = new BufferedWriter(
                    new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8))) {
                writer.write(param);
                writer.flush();
            }
        }

        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        // Add timeout control to prevent indefinite process waiting
        boolean finished = process.waitFor(30, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            throw new Exception("Node.js process timeout after 30 seconds");
        }

        int exitCode = process.exitValue();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output);
        }

        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * Call Node.js input-history-service (array parameter version, used for recordHistory).
     */
    private String callInputHistoryServiceWithArray(String functionName, String jsonArrayParam) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Use stdin to pass JSON data, avoiding shell escaping issues with special characters
        String nodeScript = String.format(
            "const { %s } = require('%s/services/input-history-service.cjs'); " +
            "let input = ''; " +
            "process.stdin.on('data', chunk => input += chunk); " +
            "process.stdin.on('end', () => { " +
            "  try { " +
            "    const data = JSON.parse(input); " +
            "    const result = %s(data); " +
            "    console.log(JSON.stringify(result)); " +
            "  } catch (err) { " +
            "    console.error(JSON.stringify({ error: err.message })); " +
            "    process.exit(1); " +
            "  } " +
            "});",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Write JSON data to stdin
        try (BufferedWriter writer = new BufferedWriter(
                new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8))) {
            writer.write(jsonArrayParam);
            writer.flush();
        }

        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        // Add timeout control to prevent indefinite process waiting
        boolean finished = process.waitFor(30, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            throw new Exception("Node.js process timeout after 30 seconds");
        }

        int exitCode = process.exitValue();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }
}
