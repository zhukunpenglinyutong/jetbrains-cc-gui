package com.github.claudecodegui;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;
import com.intellij.ui.jcef.JBCefJSQuery;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.FileEditorManagerListener;
import com.intellij.openapi.fileEditor.FileEditorManagerEvent;
import com.intellij.openapi.editor.event.SelectionListener;
import com.intellij.openapi.editor.event.SelectionEvent;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.util.messages.MessageBusConnection;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.util.Alarm;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.NotNull;

import com.github.claudecodegui.handler.*;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.ui.ErrorPanelBuilder;
import com.github.claudecodegui.util.HtmlLoader;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import javax.swing.*;
import java.awt.*;
import java.awt.datatransfer.*;
import java.awt.dnd.*;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.io.File;
import java.util.concurrent.CompletableFuture;

/**
 * Claude SDK 聊天工具窗口
 * 实现 DumbAware 接口允许在索引构建期间使用此工具窗口
 */
public class ClaudeSDKToolWindow implements ToolWindowFactory, DumbAware {

    private static final Map<Project, ClaudeChatWindow> instances = new ConcurrentHashMap<>();

    /**
     * 获取指定项目的聊天窗口实例.
     *
     * @param project 项目
     * @return 聊天窗口实例，如果不存在返回 null
     */
    public static ClaudeChatWindow getChatWindow(Project project) {
        return instances.get(project);
    }

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        ClaudeChatWindow chatWindow = new ClaudeChatWindow(project);
        ContentFactory contentFactory = ContentFactory.getInstance();
        Content content = contentFactory.createContent(chatWindow.getContent(), "Claude Claude", false);
        toolWindow.getContentManager().addContent(content);

        content.setDisposer(() -> {
            ClaudeChatWindow window = instances.get(project);
            if (window != null) {
                window.dispose();
            }
        });
    }

    public static void addSelectionFromExternal(Project project, String selectionInfo) {
        ClaudeChatWindow.addSelectionFromExternalInternal(project, selectionInfo);
    }

    /**
     * 聊天窗口内部类
     */
    public static class ClaudeChatWindow {
        private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";
        private static final Map<String, Integer> MODEL_CONTEXT_LIMITS = new java.util.HashMap<>();
        static {
            MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-5", 200_000);
            MODEL_CONTEXT_LIMITS.put("claude-opus-4-5-20251101", 200_000);
        }

        private final JPanel mainPanel;
        private final ClaudeSDKBridge claudeSDKBridge;
        private final CodexSDKBridge codexSDKBridge;
        private final Project project;
        private final CodemossSettingsService settingsService;
        private final HtmlLoader htmlLoader;

        // Editor Event Listeners
        private Alarm contextUpdateAlarm;
        private MessageBusConnection connection;

        private JBCefBrowser browser;
        private ClaudeSession session;
        private String currentModel = "claude-sonnet-4-5";

        private volatile boolean disposed = false;
        private volatile boolean initialized = false;

        // Handler 相关
        private HandlerContext handlerContext;
        private MessageDispatcher messageDispatcher;
        private PermissionHandler permissionHandler;
        private HistoryHandler historyHandler;

        public ClaudeChatWindow(Project project) {
            this.project = project;
            this.claudeSDKBridge = new ClaudeSDKBridge();
            this.codexSDKBridge = new CodexSDKBridge();
            this.settingsService = new CodemossSettingsService();
            this.htmlLoader = new HtmlLoader(getClass());
            this.mainPanel = new JPanel(new BorderLayout());

            initializeSession();
            loadNodePathFromSettings();
            syncActiveProvider();
            setupPermissionService();
            initializeHandlers();
            registerEditorListeners();
            setupSessionCallbacks();
            initializeSessionInfo();

            createUIComponents();
            registerSessionLoadListener();
            registerInstance();

            this.initialized = true;
            System.out.println("[ClaudeChatWindow] 窗口实例已完全初始化，项目: " + project.getName());
        }

        private void initializeSession() {
            this.session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);
        }

        private void loadNodePathFromSettings() {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);
                if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                    String path = savedNodePath.trim();
                    // 同时设置 Claude 和 Codex 的 Node.js 路径
                    claudeSDKBridge.setNodeExecutable(path);
                    codexSDKBridge.setNodeExecutable(path);
                    System.out.println("[ClaudeChatWindow] Using manually configured Node.js path: " + path);
                }
            } catch (Exception e) {
                System.err.println("[ClaudeChatWindow] Failed to load manual Node.js path: " + e.getMessage());
            }
        }

        private void syncActiveProvider() {
            try {
                settingsService.applyActiveProviderToClaudeSettings();
            } catch (Exception e) {
                System.err.println("[ClaudeChatWindow] Failed to sync active provider on startup: " + e.getMessage());
            }
        }

        private void setupPermissionService() {
            PermissionService permissionService = PermissionService.getInstance(project);
            permissionService.start();
            permissionService.setDialogShower((toolName, inputs) ->
                permissionHandler.showFrontendPermissionDialog(toolName, inputs));
            System.out.println("[ClaudeChatWindow] Started permission service with frontend dialog");
        }

        private void initializeHandlers() {
            HandlerContext.JsCallback jsCallback = new HandlerContext.JsCallback() {
                @Override
                public void callJavaScript(String functionName, String... args) {
                    ClaudeChatWindow.this.callJavaScript(functionName, args);
                }
                @Override
                public String escapeJs(String str) {
                    return JsUtils.escapeJs(str);
                }
            };

            this.handlerContext = new HandlerContext(project, claudeSDKBridge, codexSDKBridge, settingsService, jsCallback);
            handlerContext.setSession(session);

            this.messageDispatcher = new MessageDispatcher();

            // 注册所有 Handler
            messageDispatcher.registerHandler(new ProviderHandler(handlerContext));
            messageDispatcher.registerHandler(new McpServerHandler(handlerContext));
            messageDispatcher.registerHandler(new SkillHandler(handlerContext, mainPanel));
            messageDispatcher.registerHandler(new FileHandler(handlerContext));
            messageDispatcher.registerHandler(new SettingsHandler(handlerContext));
            messageDispatcher.registerHandler(new SessionHandler(handlerContext));

            // 权限处理器（需要特殊回调）
            this.permissionHandler = new PermissionHandler(handlerContext);
            permissionHandler.setPermissionDeniedCallback(this::interruptDueToPermissionDenial);
            messageDispatcher.registerHandler(permissionHandler);

            // 历史处理器（需要特殊回调）
            this.historyHandler = new HistoryHandler(handlerContext);
            historyHandler.setSessionLoadCallback(this::loadHistorySession);
            messageDispatcher.registerHandler(historyHandler);

            System.out.println("[ClaudeChatWindow] Registered " + messageDispatcher.getHandlerCount() + " message handlers");
        }

        private void registerEditorListeners() {
            contextUpdateAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
            connection = project.getMessageBus().connect();

            // Monitor file switching
            connection.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, new FileEditorManagerListener() {
                @Override
                public void selectionChanged(@NotNull FileEditorManagerEvent event) {
                    scheduleContextUpdate();
                }
            });

            // Monitor text selection
            SelectionListener selectionListener = new SelectionListener() {
                @Override
                public void selectionChanged(@NotNull SelectionEvent e) {
                    if (e.getEditor().getProject() == project) {
                        scheduleContextUpdate();
                    }
                }
            };
            EditorFactory.getInstance().getEventMulticaster().addSelectionListener(selectionListener, connection);
        }

        private void scheduleContextUpdate() {
            if (disposed || contextUpdateAlarm == null) return;
            contextUpdateAlarm.cancelAllRequests();
            contextUpdateAlarm.addRequest(this::updateContextInfo, 200);
        }

        private void updateContextInfo() {
            if (disposed) return;

            // Ensure we are on EDT (Alarm.ThreadToUse.SWING_THREAD guarantees this, but being safe)
            ApplicationManager.getApplication().invokeLater(() -> {
                if (disposed) return;
                try {
                    FileEditorManager editorManager = FileEditorManager.getInstance(project);
                    Editor editor = editorManager.getSelectedTextEditor();

                    String selectionInfo = null;

                    if (editor != null) {
                        VirtualFile file = FileDocumentManager.getInstance().getFile(editor.getDocument());
                        if (file != null) {
                            String path = file.getPath();
                            selectionInfo = "@" + path;

                            com.intellij.openapi.editor.SelectionModel selectionModel = editor.getSelectionModel();
                            if (selectionModel.hasSelection()) {
                                int startLine = editor.getDocument().getLineNumber(selectionModel.getSelectionStart()) + 1;
                                int endLine = editor.getDocument().getLineNumber(selectionModel.getSelectionEnd()) + 1;

                                if (endLine > startLine && editor.offsetToLogicalPosition(selectionModel.getSelectionEnd()).column == 0) {
                                    endLine--;
                                }
                                selectionInfo += "#L" + startLine + "-" + endLine;
                            }
                        }
                    } else {
                         VirtualFile[] files = editorManager.getSelectedFiles();
                         if (files.length > 0) {
                             selectionInfo = "@" + files[0].getPath();
                         }
                    }

                    if (selectionInfo != null) {
                        addSelectionInfo(selectionInfo);
                    } else {
                        // 当没有打开文件时，清除前端显示
                        clearSelectionInfo();
                    }
                } catch (Exception e) {
                    System.err.println("[ClaudeChatWindow] Failed to update context info: " + e.getMessage());
                }
            });
        }

        private void initializeSessionInfo() {
            String workingDirectory = determineWorkingDirectory();
            session.setSessionInfo(null, workingDirectory);
            System.out.println("[ClaudeChatWindow] Initialized with working directory: " + workingDirectory);
        }

        private void registerInstance() {
            synchronized (instances) {
                ClaudeChatWindow oldInstance = instances.get(project);
                if (oldInstance != null && oldInstance != this) {
                    System.out.println("[ClaudeChatWindow] 警告: 项目 " + project.getName() + " 已存在窗口实例，将替换旧实例");
                    oldInstance.dispose();
                }
                instances.put(project, this);
            }
        }

        private void createUIComponents() {
            if (!claudeSDKBridge.checkEnvironment()) {
                showErrorPanel();
                return;
            }

            try {
                browser = new JBCefBrowser();
                handlerContext.setBrowser(browser);

                // 启用开发者工具（右键菜单）
                browser.getJBCefClient().setProperty("allowRunningInsecureContent", true);

                JBCefBrowserBase browserBase = browser;
                JBCefJSQuery jsQuery = JBCefJSQuery.create(browserBase);
                jsQuery.addHandler((msg) -> {
                    handleJavaScriptMessage(msg);
                    return new JBCefJSQuery.Response("ok");
                });

                // 创建一个专门用于获取剪贴板文件路径的 JSQuery
                JBCefJSQuery getClipboardPathQuery = JBCefJSQuery.create(browserBase);
                getClipboardPathQuery.addHandler((msg) -> {
                    try {
                        System.out.println("[Java] Clipboard path request received");
                        Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
                        Transferable contents = clipboard.getContents(null);

                        if (contents != null && contents.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                            @SuppressWarnings("unchecked")
                            List<File> files = (List<File>) contents.getTransferData(DataFlavor.javaFileListFlavor);

                            if (!files.isEmpty()) {
                                File file = files.get(0);
                                String filePath = file.getAbsolutePath();
                                System.out.println("[Java] Returning file path from clipboard: " + filePath);
                                return new JBCefJSQuery.Response(filePath);
                            }
                        }
                        System.out.println("[Java] No file in clipboard");
                        return new JBCefJSQuery.Response("");
                    } catch (Exception ex) {
                        System.err.println("[Java] Error getting clipboard path: " + ex.getMessage());
                        return new JBCefJSQuery.Response("");
                    }
                });

                String htmlContent = htmlLoader.loadChatHtml();

                browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
                    @Override
                    public void onLoadEnd(CefBrowser browser, CefFrame frame, int httpStatusCode) {
                        String injection = "window.sendToJava = function(msg) { " + jsQuery.inject("msg") + " };";
                        browser.executeJavaScript(injection, browser.getURL(), 0);

                        // 注入获取剪贴板路径的函数
                        String clipboardPathInjection =
                            "window.getClipboardFilePath = function() {" +
                            "  return new Promise((resolve) => {" +
                            "    " + getClipboardPathQuery.inject("''",
                                "function(response) { resolve(response); }",
                                "function(error_code, error_message) { console.error('Failed to get clipboard path:', error_message); resolve(''); }") +
                            "  });" +
                            "};";
                        browser.executeJavaScript(clipboardPathInjection, browser.getURL(), 0);

                        // 将控制台日志转发到 IDEA 控制台
                        String consoleForward =
                            "const originalLog = console.log;" +
                            "const originalError = console.error;" +
                            "const originalWarn = console.warn;" +
                            "console.log = function(...args) {" +
                            "  originalLog.apply(console, args);" +
                            "  window.sendToJava(JSON.stringify({type: 'console.log', args: args}));" +
                            "};" +
                            "console.error = function(...args) {" +
                            "  originalError.apply(console, args);" +
                            "  window.sendToJava(JSON.stringify({type: 'console.error', args: args}));" +
                            "};" +
                            "console.warn = function(...args) {" +
                            "  originalWarn.apply(console, args);" +
                            "  window.sendToJava(JSON.stringify({type: 'console.warn', args: args}));" +
                            "};";
                        browser.executeJavaScript(consoleForward, browser.getURL(), 0);
                    }
                }, browser.getCefBrowser());

                browser.loadHTML(htmlContent);

                JComponent browserComponent = browser.getComponent();

                // 添加拖拽支持 - 获取完整文件路径
                new DropTarget(browserComponent, new DropTargetAdapter() {
                    @Override
                    public void drop(DropTargetDropEvent dtde) {
                        try {
                            dtde.acceptDrop(DnDConstants.ACTION_COPY);
                            Transferable transferable = dtde.getTransferable();

                            if (transferable.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                                @SuppressWarnings("unchecked")
                                List<File> files = (List<File>) transferable.getTransferData(DataFlavor.javaFileListFlavor);

                                if (!files.isEmpty()) {
                                    File file = files.get(0); // 只处理第一个文件
                                    String filePath = file.getAbsolutePath();
                                    System.out.println("[Java] Dropped file path: " + filePath);

                                    // 通过 JavaScript 将路径传递到前端
                                    String jsCode = String.format(
                                        "if (window.handleFilePathFromJava) { window.handleFilePathFromJava('%s'); }",
                                        filePath.replace("\\", "\\\\").replace("'", "\\'")
                                    );
                                    browser.getCefBrowser().executeJavaScript(jsCode, browser.getCefBrowser().getURL(), 0);
                                }
                                dtde.dropComplete(true);
                                return;
                            }
                        } catch (Exception ex) {
                            System.err.println("[Java] Drop error: " + ex.getMessage());
                            ex.printStackTrace();
                        }
                        dtde.dropComplete(false);
                    }
                });


                mainPanel.add(browserComponent, BorderLayout.CENTER);

            } catch (Exception e) {
                e.printStackTrace();
                showErrorPanel();
            }
        }

        private void showErrorPanel() {
            String message = "无法找到 Node.js\n\n" +
                "请确保:\n" +
                "• Node.js 已安装 (可以在终端运行: node --version)\n\n" +
                "如果自动检测 Node.js 失败，可以在终端运行以下命令获取 Node.js 路径:\n" +
                "    node -p \"process.execPath\"\n\n" +
                "当前检测到的 Node.js 路径: " + claudeSDKBridge.getNodeExecutable();

            JPanel errorPanel = ErrorPanelBuilder.build(
                "环境检查失败",
                message,
                claudeSDKBridge.getNodeExecutable(),
                this::handleNodePathSave
            );
            mainPanel.add(errorPanel, BorderLayout.CENTER);
        }

        private void handleNodePathSave(String manualPath) {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();

                if (manualPath == null || manualPath.isEmpty()) {
                    props.unsetValue(NODE_PATH_PROPERTY_KEY);
                    // 同时清除 Claude 和 Codex 的手动配置
                    claudeSDKBridge.setNodeExecutable(null);
                    codexSDKBridge.setNodeExecutable(null);
                    System.out.println("[ClaudeChatWindow] Cleared manual Node.js path");
                } else {
                    props.setValue(NODE_PATH_PROPERTY_KEY, manualPath);
                    // 同时设置 Claude 和 Codex 的 Node.js 路径
                    claudeSDKBridge.setNodeExecutable(manualPath);
                    codexSDKBridge.setNodeExecutable(manualPath);
                    System.out.println("[ClaudeChatWindow] Saved manual Node.js path: " + manualPath);
                }

                SwingUtilities.invokeLater(() -> {
                    mainPanel.removeAll();
                    createUIComponents();
                    mainPanel.revalidate();
                    mainPanel.repaint();
                });

            } catch (Exception ex) {
                JOptionPane.showMessageDialog(mainPanel,
                    "保存或应用 Node.js 路径时出错: " + ex.getMessage(),
                    "错误", JOptionPane.ERROR_MESSAGE);
            }
        }

        private void handleJavaScriptMessage(String message) {
            // 处理控制台日志转发
            if (message.startsWith("{\"type\":\"console.")) {
                try {
                    JsonObject json = new Gson().fromJson(message, JsonObject.class);
                    String logType = json.get("type").getAsString();
                    JsonArray args = json.getAsJsonArray("args");

                    StringBuilder logMessage = new StringBuilder("[Webview] ");
                    for (int i = 0; i < args.size(); i++) {
                        if (i > 0) logMessage.append(" ");
                        logMessage.append(args.get(i).toString());
                    }

                    if ("console.error".equals(logType)) {
                        System.err.println(logMessage);
                    } else if ("console.warn".equals(logType)) {
                        System.out.println(logMessage);
                    } else {
                        System.out.println(logMessage);
                    }
                } catch (Exception e) {
                    System.err.println("[Backend] 解析控制台日志失败: " + e.getMessage());
                }
                return;
            }

            String[] parts = message.split(":", 2);
            if (parts.length < 1) {
                System.err.println("[Backend] 错误: 消息格式无效");
                return;
            }

            String type = parts[0];
            String content = parts.length > 1 ? parts[1] : "";

            // 使用 Handler 分发器处理
            if (messageDispatcher.dispatch(type, content)) {
                return;
            }

            // 特殊处理：create_new_session 需要重建 session 对象
            if ("create_new_session".equals(type)) {
                createNewSession();
                return;
            }

            System.err.println("[Backend] 警告: 未知的消息类型: " + type);
        }

        private void registerSessionLoadListener() {
            SessionLoadService.getInstance().setListener((sessionId, projectPath) -> {
                SwingUtilities.invokeLater(() -> loadHistorySession(sessionId, projectPath));
            });
        }

        private String determineWorkingDirectory() {
            String projectPath = project.getBasePath();
            if (projectPath != null && new File(projectPath).exists()) {
                return projectPath;
            }
            String userHome = System.getProperty("user.home");
            System.out.println("[ClaudeChatWindow] WARNING: Using user home directory as fallback: " + userHome);
            return userHome;
        }

        private void loadHistorySession(String sessionId, String projectPath) {
            System.out.println("Loading history session: " + sessionId + " from project: " + projectPath);

            callJavaScript("clearMessages");

            session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);
            handlerContext.setSession(session);
            setupSessionCallbacks();

            String workingDir = (projectPath != null && new File(projectPath).exists())
                ? projectPath : determineWorkingDirectory();
            session.setSessionInfo(sessionId, workingDir);

            session.loadFromServer().thenRun(() -> SwingUtilities.invokeLater(() -> {}))
                .exceptionally(ex -> {
                    SwingUtilities.invokeLater(() ->
                        callJavaScript("addErrorMessage", JsUtils.escapeJs("加载会话失败: " + ex.getMessage())));
                    return null;
                });
        }

        private void setupSessionCallbacks() {
            session.setCallback(new ClaudeSession.SessionCallback() {
                @Override
                public void onMessageUpdate(List<ClaudeSession.Message> messages) {
                    SwingUtilities.invokeLater(() -> {
                        String messagesJson = convertMessagesToJson(messages);
                        callJavaScript("updateMessages", JsUtils.escapeJs(messagesJson));
                    });
                    pushUsageUpdateFromMessages(messages);
                }

                @Override
                public void onStateChange(boolean busy, boolean loading, String error) {
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("showLoading", String.valueOf(busy));
                        if (error != null) {
                            callJavaScript("updateStatus", JsUtils.escapeJs("错误: " + error));
                        }
                        if (!busy && !loading) {
                            VirtualFileManager.getInstance().asyncRefresh(null);
                        }
                    });
                }

                @Override
                public void onSessionIdReceived(String sessionId) {
                    System.out.println("Session ID: " + sessionId);
                }

                @Override
                public void onPermissionRequested(PermissionRequest request) {
                    SwingUtilities.invokeLater(() -> permissionHandler.showPermissionDialog(request));
                }

                @Override
                public void onThinkingStatusChanged(boolean isThinking) {
                    SwingUtilities.invokeLater(() -> {
                        callJavaScript("showThinkingStatus", String.valueOf(isThinking));
                        System.out.println("[ClaudeChatWindow] Thinking status changed: " + isThinking);
                    });
                }
            });
        }

        private String convertMessagesToJson(List<ClaudeSession.Message> messages) {
            Gson gson = new Gson();
            JsonArray messagesArray = new JsonArray();
            for (ClaudeSession.Message msg : messages) {
                JsonObject msgObj = new JsonObject();
                msgObj.addProperty("type", msg.type.toString().toLowerCase());
                msgObj.addProperty("timestamp", msg.timestamp);
                msgObj.addProperty("content", msg.content != null ? msg.content : "");
                if (msg.raw != null) {
                    msgObj.add("raw", msg.raw);
                }
                messagesArray.add(msgObj);
            }
            return gson.toJson(messagesArray);
        }

        private void pushUsageUpdateFromMessages(List<ClaudeSession.Message> messages) {
            try {
                JsonObject lastUsage = null;
                for (int i = messages.size() - 1; i >= 0; i--) {
                    ClaudeSession.Message msg = messages.get(i);
                    if (msg.type != ClaudeSession.Message.Type.ASSISTANT || msg.raw == null) continue;
                    if (!msg.raw.has("message")) continue;
                    JsonObject message = msg.raw.getAsJsonObject("message");
                    if (message.has("usage")) {
                        lastUsage = message.getAsJsonObject("usage");
                        break;
                    }
                }

                int inputTokens = lastUsage != null && lastUsage.has("input_tokens") ? lastUsage.get("input_tokens").getAsInt() : 0;
                int cacheWriteTokens = lastUsage != null && lastUsage.has("cache_creation_input_tokens") ? lastUsage.get("cache_creation_input_tokens").getAsInt() : 0;
                int cacheReadTokens = lastUsage != null && lastUsage.has("cache_read_input_tokens") ? lastUsage.get("cache_read_input_tokens").getAsInt() : 0;

                int usedTokens = inputTokens + cacheWriteTokens + cacheReadTokens;
                int maxTokens = MODEL_CONTEXT_LIMITS.getOrDefault(currentModel, 200_000);
                int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);

                JsonObject usageUpdate = new JsonObject();
                usageUpdate.addProperty("percentage", percentage);
                usageUpdate.addProperty("totalTokens", usedTokens);
                usageUpdate.addProperty("limit", maxTokens);
                usageUpdate.addProperty("usedTokens", usedTokens);
                usageUpdate.addProperty("maxTokens", maxTokens);

                String usageJson = new Gson().toJson(usageUpdate);
                SwingUtilities.invokeLater(() -> {
                    String js = "if (window.onUsageUpdate) { window.onUsageUpdate('" + JsUtils.escapeJs(usageJson) + "'); }";
                    if (browser != null && !disposed) {
                        browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
                    }
                });
            } catch (Exception e) {
                System.err.println("[Backend] Failed to push usage update: " + e.getMessage());
            }
        }

        private void createNewSession() {
            System.out.println("[ClaudeSDKToolWindow] Creating new session...");

            // 清空前端消息显示（修复新建会话时消息不清空的bug）
            callJavaScript("clearMessages");

            // 先中断旧会话，确保彻底断开旧的连接
            // 使用异步方式等待中断完成，避免竞态条件
            CompletableFuture<Void> interruptFuture = session != null
                ? session.interrupt()
                : CompletableFuture.completedFuture(null);

            interruptFuture.thenRun(() -> {
                System.out.println("[ClaudeSDKToolWindow] Old session interrupted, creating new session");

                // 创建全新的 Session 对象
                session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);

                // 更新 HandlerContext 中的 Session 引用（重要：确保所有 Handler 使用新 Session）
                handlerContext.setSession(session);

                // 设置回调
                setupSessionCallbacks();

                // 设置工作目录（sessionId 为 null 表示新会话）
                String workingDirectory = determineWorkingDirectory();
                session.setSessionInfo(null, workingDirectory);

                System.out.println("[ClaudeSDKToolWindow] New session created successfully");
                System.out.println("[ClaudeSDKToolWindow]   - SessionId: null (new session)");
                System.out.println("[ClaudeSDKToolWindow]   - Working directory: " + workingDirectory);

                // 更新前端状态
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("updateStatus", JsUtils.escapeJs("新会话已创建，可以开始提问"));

                    // 重置 Token 使用统计
                    int maxTokens = MODEL_CONTEXT_LIMITS.getOrDefault(currentModel, 200_000);
                    JsonObject usageUpdate = new JsonObject();
                    usageUpdate.addProperty("percentage", 0);
                    usageUpdate.addProperty("totalTokens", 0);
                    usageUpdate.addProperty("limit", maxTokens);
                    usageUpdate.addProperty("usedTokens", 0);
                    usageUpdate.addProperty("maxTokens", maxTokens);

                    String usageJson = new Gson().toJson(usageUpdate);
                    String js = "if (window.onUsageUpdate) { window.onUsageUpdate('" + JsUtils.escapeJs(usageJson) + "'); }";
                    if (browser != null && !disposed) {
                        browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
                    }
                });
            }).exceptionally(ex -> {
                System.err.println("[ClaudeSDKToolWindow] Failed to create new session: " + ex.getMessage());
                ex.printStackTrace();
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("updateStatus", JsUtils.escapeJs("创建新会话失败: " + ex.getMessage()));
                });
                return null;
            });
        }

        private void interruptDueToPermissionDenial() {
            this.session.interrupt().thenRun(() -> SwingUtilities.invokeLater(() -> {}));
        }

        /**
         * 执行 JavaScript 代码（对外公开，用于权限弹窗等功能）.
         *
         * @param jsCode 要执行的 JavaScript 代码
         */
        public void executeJavaScriptCode(String jsCode) {
            if (this.disposed || this.browser == null) {
                return;
            }
            SwingUtilities.invokeLater(() -> {
                if (!this.disposed && this.browser != null) {
                    this.browser.getCefBrowser().executeJavaScript(jsCode, this.browser.getCefBrowser().getURL(), 0);
                }
            });
        }

        private void callJavaScript(String functionName, String... args) {
            if (disposed || browser == null) {
                return;
            }
            try {
                String js = JsUtils.buildJsCall(functionName, args);
                browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
            } catch (Exception e) {
                System.err.println("[ClaudeSDKToolWindow] 调用 JS 函数失败: " + functionName + ", 错误: " + e.getMessage());
            }
        }

        private void addSelectionInfo(String selectionInfo) {
            if (selectionInfo != null && !selectionInfo.isEmpty()) {
                callJavaScript("addSelectionInfo", JsUtils.escapeJs(selectionInfo));
            }
        }

        private void clearSelectionInfo() {
            callJavaScript("clearSelectionInfo");
        }

        static void addSelectionFromExternalInternal(Project project, String selectionInfo) {
            if (project == null) {
                System.err.println("[ClaudeSDKToolWindow] 错误: project 参数为 null");
                return;
            }

            ClaudeChatWindow window = instances.get(project);
            if (window == null) {
                System.err.println("[ClaudeSDKToolWindow] 错误: 找不到项目 " + project.getName() + " 的窗口实例");
                return;
            }

            if (window.disposed) {
                instances.remove(project);
                return;
            }

            if (!window.initialized) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    try {
                        Thread.sleep(500);
                        if (window.initialized && !window.disposed) {
                            window.addSelectionInfo(selectionInfo);
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
                return;
            }

            window.addSelectionInfo(selectionInfo);
        }

        public JPanel getContent() {
            return mainPanel;
        }

        public void dispose() {
            if (disposed) return;

            if (connection != null) {
                connection.disconnect();
            }
            if (contextUpdateAlarm != null) {
                contextUpdateAlarm.dispose();
            }

            System.out.println("[ClaudeSDKToolWindow] 开始清理窗口资源，项目: " + project.getName());

            disposed = true;
            handlerContext.setDisposed(true);

            synchronized (instances) {
                if (instances.get(project) == this) {
                    instances.remove(project);
                }
            }

            try {
                if (session != null) session.interrupt();
            } catch (Exception e) {
                System.err.println("[ClaudeSDKToolWindow] 清理会话失败: " + e.getMessage());
            }

            try {
                if (browser != null) {
                    browser.dispose();
                    browser = null;
                }
            } catch (Exception e) {
                System.err.println("[ClaudeSDKToolWindow] 清理浏览器失败: " + e.getMessage());
            }

            messageDispatcher.clear();

            System.out.println("[ClaudeSDKToolWindow] 窗口资源已完全清理，项目: " + project.getName());
        }
    }
}
