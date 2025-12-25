package com.github.claudecodegui;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
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
import com.github.claudecodegui.util.JBCefBrowserFactory;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.cache.SlashCommandCache;
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

    private static final Logger LOG = Logger.getInstance(ClaudeSDKToolWindow.class);
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
        Content content = contentFactory.createContent(chatWindow.getContent(), "GUI", false);
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
        private static final String PERMISSION_MODE_PROPERTY_KEY = "claude.code.permission.mode";

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

        private volatile boolean disposed = false;
        private volatile boolean initialized = false;
        private volatile boolean slashCommandsFetched = false;  // 标记是否已通过 API 获取了完整命令列表
        private volatile int fetchedSlashCommandsCount = 0;

        // 斜杠命令智能缓存
        private SlashCommandCache slashCommandCache;

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
            overrideBridgePathIfAvailable();

            createUIComponents();
            registerSessionLoadListener();
            registerInstance();

            this.initialized = true;
            LOG.info("窗口实例已完全初始化，项目: " + project.getName());

            // 注意：斜杠命令的加载现在由前端发起
            // 前端在 bridge 准备好后会发送 frontend_ready 和 refresh_slash_commands 事件
            // 这确保了前后端初始化时序正确
        }

        /**
         * 如果项目根目录下存在 ai-bridge 目录，则优先使用该目录
         * 避免使用插件内嵌的旧版 bridge，确保与仓库中的 SDK 版本一致
         */
        private void overrideBridgePathIfAvailable() {
            try {
                String basePath = project.getBasePath();
                if (basePath == null) return;
                java.io.File bridgeDir = new java.io.File(basePath, "ai-bridge");
                java.io.File channelManager = new java.io.File(bridgeDir, "channel-manager.js");
                if (bridgeDir.exists() && bridgeDir.isDirectory() && channelManager.exists()) {
                    claudeSDKBridge.setSdkTestDir(bridgeDir.getAbsolutePath());
                    LOG.info("Overriding ai-bridge path to project directory: " + bridgeDir.getAbsolutePath());
                } else {
                    LOG.info("Project ai-bridge not found, using default resolver");
                }
            } catch (Exception e) {
                LOG.warn("Failed to override bridge path: " + e.getMessage());
            }
        }

        private void initializeSession() {
            this.session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);
            loadPermissionModeFromSettings();
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
                    LOG.info("Using manually configured Node.js path: " + path);
                }
            } catch (Exception e) {
                LOG.warn("Failed to load manual Node.js path: " + e.getMessage());
            }
        }

        private void loadPermissionModeFromSettings() {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
                if (savedMode != null && !savedMode.trim().isEmpty()) {
                    String mode = savedMode.trim();
                    if (session != null) {
                        session.setPermissionMode(mode);
                        LOG.info("Loaded permission mode from settings: " + mode);
                    }
                }
            } catch (Exception e) {
                LOG.warn("Failed to load permission mode: " + e.getMessage());
            }
        }

        private void savePermissionModeToSettings(String mode) {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                props.setValue(PERMISSION_MODE_PROPERTY_KEY, mode);
                LOG.info("Saved permission mode to settings: " + mode);
            } catch (Exception e) {
                LOG.warn("Failed to save permission mode: " + e.getMessage());
            }
        }

        private void syncActiveProvider() {
            try {
                settingsService.applyActiveProviderToClaudeSettings();
            } catch (Exception e) {
                LOG.warn("Failed to sync active provider on startup: " + e.getMessage());
            }
        }

        private void setupPermissionService() {
            PermissionService permissionService = PermissionService.getInstance(project);
            permissionService.start();
            // 使用项目注册机制，支持多窗口场景
            permissionService.registerDialogShower(project, (toolName, inputs) ->
                permissionHandler.showFrontendPermissionDialog(toolName, inputs));
            LOG.info("Started permission service with frontend dialog for project: " + project.getName());
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
            messageDispatcher.registerHandler(new FileExportHandler(handlerContext));
            messageDispatcher.registerHandler(new DiffHandler(handlerContext));

            // 权限处理器（需要特殊回调）
            this.permissionHandler = new PermissionHandler(handlerContext);
            permissionHandler.setPermissionDeniedCallback(this::interruptDueToPermissionDenial);
            messageDispatcher.registerHandler(permissionHandler);

            // 历史处理器（需要特殊回调）
            this.historyHandler = new HistoryHandler(handlerContext);
            historyHandler.setSessionLoadCallback(this::loadHistorySession);
            messageDispatcher.registerHandler(historyHandler);

            LOG.info("Registered " + messageDispatcher.getHandlerCount() + " message handlers");
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
                    LOG.warn("Failed to update context info: " + e.getMessage());
                }
            });
        }

        private void initializeSessionInfo() {
            String workingDirectory = determineWorkingDirectory();
            session.setSessionInfo(null, workingDirectory);
            LOG.info("Initialized with working directory: " + workingDirectory);
        }

        private void registerInstance() {
            synchronized (instances) {
                ClaudeChatWindow oldInstance = instances.get(project);
                if (oldInstance != null && oldInstance != this) {
                    LOG.warn("项目 " + project.getName() + " 已存在窗口实例，将替换旧实例");
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
                browser = JBCefBrowserFactory.create();
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
                        LOG.debug("Clipboard path request received");
                        Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
                        Transferable contents = clipboard.getContents(null);

                        if (contents != null && contents.isDataFlavorSupported(DataFlavor.javaFileListFlavor)) {
                            @SuppressWarnings("unchecked")
                            List<File> files = (List<File>) contents.getTransferData(DataFlavor.javaFileListFlavor);

                            if (!files.isEmpty()) {
                                File file = files.get(0);
                                String filePath = file.getAbsolutePath();
                                LOG.debug("Returning file path from clipboard: " + filePath);
                                return new JBCefJSQuery.Response(filePath);
                            }
                        }
                        LOG.debug("No file in clipboard");
                        return new JBCefJSQuery.Response("");
                    } catch (Exception ex) {
                        LOG.warn("Error getting clipboard path: " + ex.getMessage());
                        return new JBCefJSQuery.Response("");
                    }
                });

                String htmlContent = htmlLoader.loadChatHtml();

                browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
                    @Override
                    public void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
                        LOG.debug("onLoadEnd called, isMain=" + frame.isMain() + ", url=" + cefBrowser.getURL());

                        // 只在主框架加载完成时执行
                        if (!frame.isMain()) {
                            return;
                        }

                        String injection = "window.sendToJava = function(msg) { " + jsQuery.inject("msg") + " };";
                        cefBrowser.executeJavaScript(injection, cefBrowser.getURL(), 0);

                        // 注入获取剪贴板路径的函数
                        String clipboardPathInjection =
                            "window.getClipboardFilePath = function() {" +
                            "  return new Promise((resolve) => {" +
                            "    " + getClipboardPathQuery.inject("''",
                                "function(response) { resolve(response); }",
                                "function(error_code, error_message) { console.error('Failed to get clipboard path:', error_message); resolve(''); }") +
                            "  });" +
                            "};";
                        cefBrowser.executeJavaScript(clipboardPathInjection, cefBrowser.getURL(), 0);

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
                        cefBrowser.executeJavaScript(consoleForward, cefBrowser.getURL(), 0);

                        // 斜杠命令的加载现在由前端发起，通过 frontend_ready 事件触发
                        // 不再在 onLoadEnd 中主动调用，避免时序问题
                        LOG.debug("onLoadEnd completed, waiting for frontend_ready signal");
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
                                    LOG.debug("Dropped file path: " + filePath);

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
                            LOG.warn("Drop error: " + ex.getMessage(), ex);
                        }
                        dtde.dropComplete(false);
                    }
                });


                mainPanel.add(browserComponent, BorderLayout.CENTER);

            } catch (Exception e) {
                LOG.error("Error occurred", e);
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
                    LOG.info("Cleared manual Node.js path");
                } else {
                    props.setValue(NODE_PATH_PROPERTY_KEY, manualPath);
                    // 同时设置 Claude 和 Codex 的 Node.js 路径
                    claudeSDKBridge.setNodeExecutable(manualPath);
                    codexSDKBridge.setNodeExecutable(manualPath);
                    LOG.info("Saved manual Node.js path: " + manualPath);
                }

                ApplicationManager.getApplication().invokeLater(() -> {
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
            // long receiveTime = System.currentTimeMillis();

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
                        LOG.warn(logMessage.toString());
                    } else if ("console.warn".equals(logType)) {
                        LOG.info(logMessage.toString());
                    } else {
                        LOG.debug(logMessage.toString());
                    }
                } catch (Exception e) {
                    LOG.warn("解析控制台日志失败: " + e.getMessage());
                }
                return;
            }

            String[] parts = message.split(":", 2);
            if (parts.length < 1) {
                LOG.error("消息格式无效");
                return;
            }

            String type = parts[0];
            String content = parts.length > 1 ? parts[1] : "";

            // [PERF] 性能日志：记录消息接收时间
            // if ("send_message".equals(type) || "send_message_with_attachments".equals(type)) {
            //     LOG.info("[PERF][" + receiveTime + "] Java收到消息: type=" + type + ", 内容长度=" + content.length());
            // }

            // 使用 Handler 分发器处理
            if (messageDispatcher.dispatch(type, content)) {
                return;
            }

            // 特殊处理：create_new_session 需要重建 session 对象
            if ("create_new_session".equals(type)) {
                createNewSession();
                return;
            }

            // 特殊处理:前端准备就绪信号
            if ("frontend_ready".equals(type)) {
                LOG.info("Received frontend_ready signal, frontend is now ready to receive data");

                // 发送当前权限模式到前端
                sendCurrentPermissionMode();

                // 如果缓存中已有数据，立即发送
                if (slashCommandCache != null && !slashCommandCache.isEmpty()) {
                    LOG.info("Cache has data, sending immediately");
                    sendCachedSlashCommands();
                }
                return;
            }

            // 特殊处理：刷新斜杠命令列表
            if ("refresh_slash_commands".equals(type)) {
                LOG.info("Received refresh_slash_commands request from frontend");
                fetchSlashCommandsOnStartup();
                return;
            }

            LOG.warn("未知的消息类型: " + type);
        }

        private void registerSessionLoadListener() {
            SessionLoadService.getInstance().setListener((sessionId, projectPath) -> {
                ApplicationManager.getApplication().invokeLater(() -> loadHistorySession(sessionId, projectPath));
            });
        }

        private String determineWorkingDirectory() {
            String projectPath = project.getBasePath();

            // 如果项目路径无效，回退到用户主目录
            if (projectPath == null || !new File(projectPath).exists()) {
                String userHome = System.getProperty("user.home");
                LOG.warn("Using user home directory as fallback: " + userHome);
                return userHome;
            }

            // 尝试从配置中读取自定义工作目录
            try {
                CodemossSettingsService settingsService = new CodemossSettingsService();
                String customWorkingDir = settingsService.getCustomWorkingDirectory(projectPath);

                if (customWorkingDir != null && !customWorkingDir.isEmpty()) {
                    // 如果是相对路径，拼接到项目根路径
                    File workingDirFile = new File(customWorkingDir);
                    if (!workingDirFile.isAbsolute()) {
                        workingDirFile = new File(projectPath, customWorkingDir);
                    }

                    // 验证目录是否存在
                    if (workingDirFile.exists() && workingDirFile.isDirectory()) {
                        String resolvedPath = workingDirFile.getAbsolutePath();
                        LOG.info("Using custom working directory: " + resolvedPath);
                        return resolvedPath;
                    } else {
                        LOG.warn("Custom working directory does not exist: " + workingDirFile.getAbsolutePath() + ", falling back to project root");
                    }
                }
            } catch (Exception e) {
                LOG.warn("Failed to read custom working directory: " + e.getMessage());
            }

            // 默认使用项目根路径
            return projectPath;
        }

        private void loadHistorySession(String sessionId, String projectPath) {
            LOG.info("Loading history session: " + sessionId + " from project: " + projectPath);

            // 保存当前的 permission mode（如果存在旧 session）
            String previousPermissionMode;
            if (session != null) {
                previousPermissionMode = session.getPermissionMode();
            } else {
                // 如果没有旧 session，从持久化存储加载
                PropertiesComponent props = PropertiesComponent.getInstance();
                String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
                previousPermissionMode = (savedMode != null && !savedMode.trim().isEmpty()) ? savedMode.trim() : "default";
            }
            // LOG.info("Preserving permission mode when loading history: " + previousPermissionMode);

            callJavaScript("clearMessages");

            session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);

            // 恢复之前保存的 permission mode
            session.setPermissionMode(previousPermissionMode);
            // LOG.info("Restored permission mode to loaded session: " + previousPermissionMode);

            handlerContext.setSession(session);
            setupSessionCallbacks();

            String workingDir = (projectPath != null && new File(projectPath).exists())
                ? projectPath : determineWorkingDirectory();
            session.setSessionInfo(sessionId, workingDir);

            session.loadFromServer().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {}))
                .exceptionally(ex -> {
                    ApplicationManager.getApplication().invokeLater(() ->
                        callJavaScript("addErrorMessage", JsUtils.escapeJs("加载会话失败: " + ex.getMessage())));
                    return null;
                });
        }

        private void setupSessionCallbacks() {
            session.setCallback(new ClaudeSession.SessionCallback() {
                @Override
                public void onMessageUpdate(List<ClaudeSession.Message> messages) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        String messagesJson = convertMessagesToJson(messages);
                        callJavaScript("updateMessages", JsUtils.escapeJs(messagesJson));
                    });
                    pushUsageUpdateFromMessages(messages);
                }

                @Override
                public void onStateChange(boolean busy, boolean loading, String error) {
                    // long callbackTime = System.currentTimeMillis();
                    // LOG.info("[PERF][" + callbackTime + "] onStateChange 回调: busy=" + busy + ", loading=" + loading);

                    ApplicationManager.getApplication().invokeLater(() -> {
                        // long uiUpdateTime = System.currentTimeMillis();
                        // LOG.info("[PERF][" + uiUpdateTime + "] invokeLater 执行，准备调用 showLoading(" + loading + ")，等待: " + (uiUpdateTime - callbackTime) + "ms");

                        callJavaScript("showLoading", String.valueOf(loading));
                        if (error != null) {
                            callJavaScript("updateStatus", JsUtils.escapeJs("错误: " + error));
                        }
                        if (!busy && !loading) {
                            VirtualFileManager.getInstance().asyncRefresh(null);
                        }

                        // LOG.info("[PERF][" + System.currentTimeMillis() + "] showLoading 调用完成");
                    });
                }

                @Override
                public void onSessionIdReceived(String sessionId) {
                    LOG.info("Session ID: " + sessionId);
                }

                @Override
                public void onPermissionRequested(PermissionRequest request) {
                    ApplicationManager.getApplication().invokeLater(() -> permissionHandler.showPermissionDialog(request));
                }

                @Override
                public void onThinkingStatusChanged(boolean isThinking) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("showThinkingStatus", String.valueOf(isThinking));
                        LOG.debug("Thinking status changed: " + isThinking);
                    });
                }

                @Override
                public void onSlashCommandsReceived(List<String> slashCommands) {
                    // 不再发送旧格式（字符串数组）的命令到前端
                    // 原因：
                    // 1. 初始化时已经从 getSlashCommands() 获取了完整的命令列表（包含 description）
                    // 2. 这里接收到的是旧格式（只有命令名，没有描述）
                    // 3. 如果发送到前端会覆盖完整的命令列表，导致 description 丢失
                    int incomingCount = slashCommands != null ? slashCommands.size() : 0;
                    LOG.debug("onSlashCommandsReceived called (old format, ignored). incoming=" + incomingCount);

                    // 记录收到命令，但不发送到前端
                    if (slashCommands != null && !slashCommands.isEmpty() && !slashCommandsFetched) {
                        LOG.debug("Received " + incomingCount + " slash commands (old format), but keeping existing commands with descriptions");
                    }
                }
            });
        }

        /**
         * 在启动时初始化斜杠命令智能缓存
         * 使用智能缓存系统：内存缓存 + 文件监听 + 定期检查
         */
        private void fetchSlashCommandsOnStartup() {
            String cwd = session.getCwd();
            if (cwd == null) {
                cwd = project.getBasePath();
            }

            LOG.info("Initializing slash command cache, cwd=" + cwd);

            // 如果缓存已存在，先清理
            if (slashCommandCache != null) {
                LOG.debug("Disposing existing slash command cache");
                slashCommandCache.dispose();
            }

            // 创建并初始化缓存
            slashCommandCache = new SlashCommandCache(project, claudeSDKBridge, cwd);

            // 添加更新监听器：缓存更新时自动通知前端
            slashCommandCache.addUpdateListener(commands -> {
                fetchedSlashCommandsCount = commands.size();
                slashCommandsFetched = true;
                LOG.debug("Slash command cache listener triggered, count=" + commands.size());
                ApplicationManager.getApplication().invokeLater(() -> {
                    try {
                        Gson gson = new Gson();
                        String commandsJson = gson.toJson(commands);
                        LOG.debug("Calling updateSlashCommands with JSON length=" + commandsJson.length());
                        callJavaScript("updateSlashCommands", JsUtils.escapeJs(commandsJson));
                        LOG.info("Slash commands updated: " + commands.size() + " commands");
                    } catch (Exception e) {
                        LOG.warn("Failed to send slash commands to frontend: " + e.getMessage(), e);
                    }
                });
            });

            // 初始化缓存（开始加载 + 启动文件监听 + 定期检查）
            LOG.debug("Starting slash command cache initialization");
            slashCommandCache.init();
        }

        /**
         * 发送当前权限模式到前端
         * 在前端准备就绪时调用，确保前端显示正确的权限模式
         */
        private void sendCurrentPermissionMode() {
            try {
                String currentMode = "default";  // 默认值

                // 优先从 session 中获取
                if (session != null) {
                    String sessionMode = session.getPermissionMode();
                    if (sessionMode != null && !sessionMode.trim().isEmpty()) {
                        currentMode = sessionMode;
                    }
                }

                final String modeToSend = currentMode;

                ApplicationManager.getApplication().invokeLater(() -> {
                    if (!disposed && browser != null) {
                        callJavaScript("window.onModeReceived", JsUtils.escapeJs(modeToSend));
                    }
                });
            } catch (Exception e) {
                LOG.error("Failed to send current permission mode: " + e.getMessage(), e);
            }
        }

        /**
         * 发送缓存中的斜杠命令到前端
         * 用于前端准备好后立即发送已缓存的数据
         */
        private void sendCachedSlashCommands() {
            if (slashCommandCache == null || slashCommandCache.isEmpty()) {
                LOG.debug("sendCachedSlashCommands: cache is empty or null");
                return;
            }

            List<JsonObject> commands = slashCommandCache.getCommands();
            if (commands.isEmpty()) {
                LOG.debug("sendCachedSlashCommands: no commands in cache");
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    Gson gson = new Gson();
                    String commandsJson = gson.toJson(commands);
                    LOG.info("sendCachedSlashCommands: sending " + commands.size() + " cached commands to frontend");
                    callJavaScript("updateSlashCommands", JsUtils.escapeJs(commandsJson));
                } catch (Exception e) {
                    LOG.warn("sendCachedSlashCommands: failed to send: " + e.getMessage(), e);
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
                LOG.debug("pushUsageUpdateFromMessages called with " + messages.size() + " messages");

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

                if (lastUsage == null) {
                    LOG.debug("No usage info found in messages");
                }

                int inputTokens = lastUsage != null && lastUsage.has("input_tokens") ? lastUsage.get("input_tokens").getAsInt() : 0;
                int cacheWriteTokens = lastUsage != null && lastUsage.has("cache_creation_input_tokens") ? lastUsage.get("cache_creation_input_tokens").getAsInt() : 0;
                int cacheReadTokens = lastUsage != null && lastUsage.has("cache_read_input_tokens") ? lastUsage.get("cache_read_input_tokens").getAsInt() : 0;
                int outputTokens = lastUsage != null && lastUsage.has("output_tokens") ? lastUsage.get("output_tokens").getAsInt() : 0;

                int usedTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
                int maxTokens = SettingsHandler.getModelContextLimit(handlerContext.getCurrentModel());
                int percentage = Math.min(100, maxTokens > 0 ? (int) ((usedTokens * 100.0) / maxTokens) : 0);

                LOG.debug("Pushing usage update: input=" + inputTokens + ", cacheWrite=" + cacheWriteTokens + ", cacheRead=" + cacheReadTokens + ", output=" + outputTokens + ", total=" + usedTokens + ", max=" + maxTokens + ", percentage=" + percentage + "%");


                JsonObject usageUpdate = new JsonObject();
                usageUpdate.addProperty("percentage", percentage);
                usageUpdate.addProperty("totalTokens", usedTokens);
                usageUpdate.addProperty("limit", maxTokens);
                usageUpdate.addProperty("usedTokens", usedTokens);
                usageUpdate.addProperty("maxTokens", maxTokens);

                String usageJson = new Gson().toJson(usageUpdate);
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (browser != null && !disposed) {
                        // 使用安全的调用方式，检查函数是否存在
                        String js = "(function() {" +
                                "  if (typeof window.onUsageUpdate === 'function') {" +
                                "    window.onUsageUpdate('" + JsUtils.escapeJs(usageJson) + "');" +
                                "    console.log('[Backend->Frontend] Usage update sent successfully');" +
                                "  } else {" +
                                "    console.warn('[Backend->Frontend] window.onUsageUpdate not found');" +
                                "  }" +
                                "})();";
                        browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
                    }
                });
            } catch (Exception e) {
                LOG.warn("Failed to push usage update: " + e.getMessage(), e);
            }
        }

        private void createNewSession() {
            LOG.info("Creating new session...");

            // 保存当前的 permission mode（如果存在旧 session）
            String previousPermissionMode = (session != null) ? session.getPermissionMode() : "default";
            // LOG.info("Preserving permission mode from old session: " + previousPermissionMode);

            // 清空前端消息显示（修复新建会话时消息不清空的bug）
            callJavaScript("clearMessages");

            // 先中断旧会话，确保彻底断开旧的连接
            // 使用异步方式等待中断完成，避免竞态条件
            CompletableFuture<Void> interruptFuture = session != null
                ? session.interrupt()
                : CompletableFuture.completedFuture(null);

            interruptFuture.thenRun(() -> {
                LOG.info("Old session interrupted, creating new session");

                // 创建全新的 Session 对象
                session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);

                // 恢复之前保存的 permission mode
                session.setPermissionMode(previousPermissionMode);
                // LOG.info("Restored permission mode to new session: " + previousPermissionMode);

                // 更新 HandlerContext 中的 Session 引用（重要：确保所有 Handler 使用新 Session）
                handlerContext.setSession(session);

                // 设置回调
                setupSessionCallbacks();

                // 设置工作目录（sessionId 为 null 表示新会话）
                String workingDirectory = determineWorkingDirectory();
                session.setSessionInfo(null, workingDirectory);

                LOG.info("New session created successfully, working directory: " + workingDirectory);

                // 更新前端状态
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("updateStatus", JsUtils.escapeJs("新会话已创建，可以开始提问"));

                    // 重置 Token 使用统计
                    int maxTokens = SettingsHandler.getModelContextLimit(handlerContext.getCurrentModel());
                    JsonObject usageUpdate = new JsonObject();
                    usageUpdate.addProperty("percentage", 0);
                    usageUpdate.addProperty("totalTokens", 0);
                    usageUpdate.addProperty("limit", maxTokens);
                    usageUpdate.addProperty("usedTokens", 0);
                    usageUpdate.addProperty("maxTokens", maxTokens);

                    String usageJson = new Gson().toJson(usageUpdate);

                    if (browser != null && !disposed) {
                        // 使用安全的调用方式
                        String js = "(function() {" +
                                "  if (typeof window.onUsageUpdate === 'function') {" +
                                "    window.onUsageUpdate('" + JsUtils.escapeJs(usageJson) + "');" +
                                "    console.log('[Backend->Frontend] Usage reset for new session');" +
                                "  } else {" +
                                "    console.warn('[Backend->Frontend] window.onUsageUpdate not found');" +
                                "  }" +
                                "})();";
                        browser.getCefBrowser().executeJavaScript(js, browser.getCefBrowser().getURL(), 0);
                    }
                });
            }).exceptionally(ex -> {
                LOG.error("Failed to create new session: " + ex.getMessage(), ex);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("updateStatus", JsUtils.escapeJs("创建新会话失败: " + ex.getMessage()));
                });
                return null;
            });
        }

        private void interruptDueToPermissionDenial() {
            this.session.interrupt().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {}));
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
            ApplicationManager.getApplication().invokeLater(() -> {
                if (!this.disposed && this.browser != null) {
                    this.browser.getCefBrowser().executeJavaScript(jsCode, this.browser.getCefBrowser().getURL(), 0);
                }
            });
        }

        private void callJavaScript(String functionName, String... args) {
            if (disposed || browser == null) {
                LOG.warn("无法调用 JS 函数 " + functionName + ": disposed=" + disposed + ", browser=" + (browser == null ? "null" : "exists"));
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                if (disposed || browser == null) {
                    return;
                }
                try {
                    String callee = functionName;
                    if (functionName != null && !functionName.isEmpty() && !functionName.contains(".")) {
                        callee = "window." + functionName;
                    }

                    StringBuilder argsJs = new StringBuilder();
                    if (args != null) {
                        for (int i = 0; i < args.length; i++) {
                            if (i > 0) argsJs.append(", ");
                            String arg = args[i] == null ? "" : args[i];
                            argsJs.append("'").append(arg).append("'");
                        }
                    }

                    String checkAndCall =
                        "(function() {" +
                        "  try {" +
                        "    if (typeof " + callee + " === 'function') {" +
                        "      " + callee + "(" + argsJs + ");" +
                        "      console.log('[Backend->Frontend] Successfully called " + functionName + "');" +
                        "    } else {" +
                        "      console.warn('[Backend->Frontend] Function " + functionName + " not found: ' + (typeof " + callee + "));" +
                        "    }" +
                        "  } catch (e) {" +
                        "    console.error('[Backend->Frontend] Failed to call " + functionName + ":', e);" +
                        "  }" +
                        "})();";

                    browser.getCefBrowser().executeJavaScript(checkAndCall, browser.getCefBrowser().getURL(), 0);
                } catch (Exception e) {
                    LOG.warn("调用 JS 函数失败: " + functionName + ", 错误: " + e.getMessage(), e);
                }
            });
        }

        /**
         * 【自动监听】更新 ContextBar - 由自动监听器调用
         * 只更新上面灰色条的显示，不添加代码片段标签
         */
        private void addSelectionInfo(String selectionInfo) {
            if (selectionInfo != null && !selectionInfo.isEmpty()) {
                callJavaScript("addSelectionInfo", JsUtils.escapeJs(selectionInfo));
            }
        }

        /**
         * 【手动发送】添加代码片段到输入框 - 由右键"发送到 GUI"调用
         * 添加代码片段标签到输入框内
         */
        private void addCodeSnippet(String selectionInfo) {
            if (selectionInfo != null && !selectionInfo.isEmpty()) {
                callJavaScript("addCodeSnippet", JsUtils.escapeJs(selectionInfo));
            }
        }

        private void clearSelectionInfo() {
            callJavaScript("clearSelectionInfo");
        }

        /**
         * 从外部（右键菜单）添加代码片段
         * 调用 addCodeSnippet 而不是 addSelectionInfo
         */
        static void addSelectionFromExternalInternal(Project project, String selectionInfo) {
            if (project == null) {
                LOG.error("project 参数为 null");
                return;
            }

            ClaudeChatWindow window = instances.get(project);
            if (window == null) {
                LOG.error("找不到项目 " + project.getName() + " 的窗口实例");
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
                            // 从外部调用，使用 addCodeSnippet 添加代码片段标签
                            window.addCodeSnippet(selectionInfo);
                        }
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
                return;
            }

            // 从外部调用，使用 addCodeSnippet 添加代码片段标签
            window.addCodeSnippet(selectionInfo);
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

            // 清理斜杠命令缓存
            if (slashCommandCache != null) {
                slashCommandCache.dispose();
                slashCommandCache = null;
            }

            // 注销权限服务的 dialogShower，防止内存泄漏
            try {
                PermissionService permissionService = PermissionService.getInstance(project);
                permissionService.unregisterDialogShower(project);
            } catch (Exception e) {
                LOG.warn("Failed to unregister dialog shower: " + e.getMessage());
            }

            LOG.info("开始清理窗口资源，项目: " + project.getName());

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
                LOG.warn("清理会话失败: " + e.getMessage());
            }

            try {
                if (browser != null) {
                    browser.dispose();
                    browser = null;
                }
            } catch (Exception e) {
                LOG.warn("清理浏览器失败: " + e.getMessage());
            }

            messageDispatcher.clear();

            LOG.info("窗口资源已完全清理，项目: " + project.getName());
        }
    }
}
