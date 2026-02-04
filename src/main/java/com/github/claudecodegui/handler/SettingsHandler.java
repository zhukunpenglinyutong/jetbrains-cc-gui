package com.github.claudecodegui.handler;

import com.github.claudecodegui.CodemossSettingsService;
import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.ClaudeSession;
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
 * 设置和使用统计相关消息处理器
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
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-5-20251101", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-haiku-4-5", 200_000);
    }

    public SettingsHandler(HandlerContext context) {
        super(context);
        // 注册主题变化监听器，当 IDE 主题变化时自动通知前端
        registerThemeChangeListener();
    }

    /**
     * 注册主题变化监听器
     */
    private void registerThemeChangeListener() {
        ThemeConfigService.registerThemeChangeListener(themeConfig -> {
            // 当主题变化时，通知前端
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
     * 获取当前权限模式
     */
    private void handleGetMode() {
        try {
            String currentMode = "bypassPermissions";  // 默认值

            // 优先从 session 中获取
            if (context.getSession() != null) {
                String sessionMode = context.getSession().getPermissionMode();
                if (sessionMode != null && !sessionMode.trim().isEmpty()) {
                    currentMode = sessionMode;
                }
            } else {
                // 如果 session 不存在，从持久化存储加载
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
     * 处理设置模式请求
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
                    // content 本身就是 mode
                    // LOG.debug("[SettingsHandler] Content is not JSON, treating as plain string");
                }
            }

            // LOG.info("[SettingsHandler] Parsed permission mode: " + mode);

            // 检查 session 是否存在
            if (context.getSession() != null) {
                // LOG.info("[SettingsHandler] Session exists, setting permission mode...");
                context.getSession().setPermissionMode(mode);

                // 保存权限模式到持久化存储
                PropertiesComponent props = PropertiesComponent.getInstance();
                props.setValue(PERMISSION_MODE_PROPERTY_KEY, mode);
                LOG.info("Saved permission mode to settings: " + mode);
                com.github.claudecodegui.notifications.ClaudeNotifier.setMode(context.getProject(), mode);

                // 验证设置是否成功
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
     * 处理设置模型请求
     * 设置完成后向前端发送确认回调，确保前后端状态同步
     *
     * 容量计算优化：当前端选择基础模型（如 claude-sonnet-4-5）时，
     * 会从设置中查找对应的实际模型配置（如 ANTHROPIC_DEFAULT_SONNET_MODEL），
     * 以支持带容量后缀的自定义模型名称（如 claude-sonnet-4-5-20250929[1M]）
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
                    // content 本身就是 model
                }
            }

            LOG.info("[SettingsHandler] Setting model to: " + model);

            // 尝试从设置中获取实际配置的模型名称（支持容量后缀）
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

            // 计算新模型的上下文限制
            int newMaxTokens = getModelContextLimit(finalModelName);
            LOG.info("[SettingsHandler] Model context limit: " + newMaxTokens + " tokens for model: " + finalModelName);

            // 向前端发送确认回调，确保前后端状态同步
            final String confirmedModel = model;
            final String confirmedProvider = context.getCurrentProvider();
            ApplicationManager.getApplication().invokeLater(() -> {
                // 发送模型确认
                callJavaScript("window.onModelConfirmed", escapeJs(confirmedModel), escapeJs(confirmedProvider));

                // 重新计算并推送 usage 更新，确保 maxTokens 根据新模型更新
                pushUsageUpdateAfterModelChange(newMaxTokens);
            });
        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to set model: " + e.getMessage(), e);
        }
    }

    /**
     * 在模型切换后推送 usage 更新
     * 根据新模型的上下文限制重新计算百分比和 maxTokens
     */
    private void pushUsageUpdateAfterModelChange(int newMaxTokens) {
        try {
            ClaudeSession session = context.getSession();
            if (session == null) {
                // 即使没有会话，也要发送更新让前端知道新的 maxTokens
                sendUsageUpdate(0, newMaxTokens);
                return;
            }

            // 从当前会话中提取最新的 usage 信息
            List<ClaudeSession.Message> messages = session.getMessages();
            JsonObject lastUsage = null;

            for (int i = messages.size() - 1; i >= 0; i--) {
                ClaudeSession.Message msg = messages.get(i);

                if (msg.type != ClaudeSession.Message.Type.ASSISTANT || msg.raw == null) {
                    continue;
                }

                // 检查不同的可能结构
                if (msg.raw.has("message")) {
                    JsonObject message = msg.raw.getAsJsonObject("message");
                    if (message.has("usage")) {
                        lastUsage = message.getAsJsonObject("usage");
                        break;
                    }
                }

                // 检查usage是否在raw的根级别
                if (msg.raw.has("usage")) {
                    lastUsage = msg.raw.getAsJsonObject("usage");
                    break;
                }
            }

            // 计算使用的 tokens
            int inputTokens = lastUsage != null && lastUsage.has("input_tokens") ? lastUsage.get("input_tokens").getAsInt() : 0;
            int cacheWriteTokens = lastUsage != null && lastUsage.has("cache_creation_input_tokens") ? lastUsage.get("cache_creation_input_tokens").getAsInt() : 0;
            int cacheReadTokens = lastUsage != null && lastUsage.has("cache_read_input_tokens") ? lastUsage.get("cache_read_input_tokens").getAsInt() : 0;
            int outputTokens = lastUsage != null && lastUsage.has("output_tokens") ? lastUsage.get("output_tokens").getAsInt() : 0;

            int usedTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;

            // 发送更新
            sendUsageUpdate(usedTokens, newMaxTokens);

        } catch (Exception e) {
            LOG.error("[SettingsHandler] Failed to push usage update after model change: " + e.getMessage(), e);
        }
    }

    /**
     * 发送 usage 更新到前端
     */
    private void sendUsageUpdate(int usedTokens, int maxTokens) {
        int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);

        LOG.info("[SettingsHandler] Sending usage update: usedTokens=" + usedTokens + ", maxTokens=" + maxTokens + ", percentage=" + percentage + "%");

        // 构建 usage 更新数据
        JsonObject usageUpdate = new JsonObject();
        usageUpdate.addProperty("percentage", percentage);
        usageUpdate.addProperty("totalTokens", usedTokens);
        usageUpdate.addProperty("limit", maxTokens);
        usageUpdate.addProperty("usedTokens", usedTokens);
        usageUpdate.addProperty("maxTokens", maxTokens);

        String usageJson = new Gson().toJson(usageUpdate);

        // 推送到前端（必须在 EDT 线程中执行）
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
     * 处理设置提供商请求
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
                    // content 本身就是 provider
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

                // 检查是否启用自动打开文件
                String projectPath = context.getProject().getBasePath();
                if (projectPath != null) {
                    com.github.claudecodegui.CodemossSettingsService settingsService =
                        new com.github.claudecodegui.CodemossSettingsService();
                    boolean autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);
                    if (!autoOpenFileEnabled) {
                        // 如果关闭了自动打开文件，清除 ContextBar 显示
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
     * 处理设置思考深度请求 (仅 Codex)
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
                    // content 本身就是 effort
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
     * 获取 Node.js 路径和版本信息.
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
                    // 使用 verifyAndCacheNodePath 而不是 setNodeExecutable，确保版本信息被缓存
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
     * 设置 Node.js 路径.
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
                    // 使用 verifyAndCacheNodePath 确保版本信息被缓存
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
                    // 🔧 触发环境重新检查,无需重启IDE
                    callJavaScript("window.showSwitchSuccess", escapeJs("Node.js 路径已保存并生效,无需重启IDE"));

                    // 通知 DependencySection 重新检查 Node.js 环境
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
     * 获取工作目录配置
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
     * 设置工作目录配置
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

            // 验证自定义工作目录是否存在
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
     * 获取 IDEA 编辑器字体配置
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
     * 🔧 获取流式传输配置
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
     * 🔧 设置流式传输配置
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

            // 返回更新后的状态
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
     * 获取自动打开文件配置
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
     * 设置自动打开文件配置
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

            // 返回更新后的状态
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
     * 从设置中解析实际使用的模型名称
     * 支持从 ANTHROPIC_MODEL 或 ANTHROPIC_DEFAULT_*_MODEL 中读取带容量后缀的模型名称
     *
     * @param baseModel 前端选择的基础模型 ID (如 claude-sonnet-4-5, claude-opus-4-5-20251101, claude-haiku-4-5)
     * @return 设置中配置的实际模型名称，如果未配置则返回 null
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

                // 根据基础模型 ID 查找对应的环境变量
                String actualModel = null;

                // 首先检查 ANTHROPIC_MODEL（主模型配置）
                if (env.has("ANTHROPIC_MODEL") && !env.get("ANTHROPIC_MODEL").isJsonNull()) {
                    String mainModel = env.get("ANTHROPIC_MODEL").getAsString();
                    if (mainModel != null && !mainModel.trim().isEmpty()) {
                        actualModel = mainModel.trim();
                    }
                }

                // 如果主模型未配置，根据基础模型 ID 查找对应的默认模型配置
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
     * 获取模型上下文限制
     * 支持从模型名称中解析容量后缀，例如：
     * - claude-sonnet-4-5[1M] → 1,000,000 tokens
     * - claude-opus-4-5[2M] → 2,000,000 tokens
     * - claude-haiku-4-5[500k] → 500,000 tokens
     * - claude-sonnet-4-5 [1.5M] → 1,500,000 tokens (支持空格和小数)
     * - 支持大小写不敏感 (1m 和 1M 都可以)
     */
    public static int getModelContextLimit(String model) {
        if (model == null || model.isEmpty()) {
            return 200_000;
        }

        // 正则表达式：匹配末尾的 [数字单位]，支持可选空格、小数、大小写
        // 示例: [1M], [2m], [500k], [1.5M], 或带空格的 [1M]
        java.util.regex.Pattern pattern = java.util.regex.Pattern.compile("\\s*\\[([0-9.]+)([kKmM])\\]\\s*$");
        java.util.regex.Matcher matcher = pattern.matcher(model);

        if (matcher.find()) {
            try {
                double value = Double.parseDouble(matcher.group(1));
                String unit = matcher.group(2).toLowerCase();

                if ("m".equals(unit)) {
                    // M (百万) 转换为 tokens
                    return (int)(value * 1_000_000);
                } else if ("k".equals(unit)) {
                    // k (千) 转换为 tokens
                    return (int)(value * 1_000);
                }
            } catch (NumberFormatException e) {
                LOG.error("Failed to parse capacity from model name: " + model);
            }
        }

        // 如果没有容量后缀，尝试从预定义映射中查找
        // 先尝试完整匹配，如果不存在则使用默认值
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
     * 获取 Commit AI 提示词
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
     * 设置 Commit AI 提示词
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

            // 返回成功响应，同时更新前端状态以重置 loading
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
     * 获取 IDE 主题配置
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

    // ==================== 输入历史记录管理 ====================

    /**
     * 获取输入历史记录
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
     * 记录输入历史
     * @param content JSON 数组格式的片段列表
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
     * 删除单条输入历史
     * @param content 要删除的历史记录项
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
     * 清空所有输入历史
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
     * 调用 Node.js input-history-service（单参数版本）
     */
    private String callInputHistoryService(String functionName, String param) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        String nodeScript;
        if (param == null || param.isEmpty()) {
            // 无参数调用
            nodeScript = String.format(
                "const { %s } = require('%s/services/input-history-service.cjs'); " +
                "const result = %s(); " +
                "console.log(JSON.stringify(result));",
                functionName,
                bridgePath.replace("\\", "\\\\"),
                functionName
            );
        } else {
            // 单参数调用（通过 stdin 传递，避免转义问题）
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

        // 添加超时控制，避免进程无限等待
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
     * 调用 Node.js input-history-service（数组参数版本，用于 recordHistory）
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

        // 添加超时控制，避免进程无限等待
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
