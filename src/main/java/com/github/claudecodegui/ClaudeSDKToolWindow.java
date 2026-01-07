package com.github.claudecodegui;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.cache.SlashCommandCache;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.handler.*;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.ui.ErrorPanelBuilder;
import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.util.HtmlLoader;
import com.github.claudecodegui.util.JBCefBrowserFactory;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.util.LanguageConfigService;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.EditorFactory;
import com.intellij.openapi.editor.event.SelectionEvent;
import com.intellij.openapi.editor.event.SelectionListener;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.FileEditorManagerEvent;
import com.intellij.openapi.fileEditor.FileEditorManagerListener;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;
import com.intellij.ui.jcef.JBCefJSQuery;
import com.intellij.util.Alarm;
import com.intellij.util.messages.MessageBusConnection;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.Transferable;
import java.awt.dnd.DnDConstants;
import java.awt.dnd.DropTarget;
import java.awt.dnd.DropTargetAdapter;
import java.awt.dnd.DropTargetDropEvent;
import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;

/**
 * Claude SDK 聊天工具窗口
 * 实现 DumbAware 接口允许在索引构建期间使用此工具窗口
 */
public class ClaudeSDKToolWindow implements ToolWindowFactory, DumbAware {

    private static final Logger LOG = Logger.getInstance(ClaudeSDKToolWindow.class);
    private static final Map<Project, ClaudeChatWindow> instances = new ConcurrentHashMap<>();
    private static volatile boolean shutdownHookRegistered = false;

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
        // 注册 JVM Shutdown Hook（只注册一次）
        registerShutdownHook();

        ClaudeChatWindow chatWindow = new ClaudeChatWindow(project);
        ContentFactory contentFactory = ContentFactory.getInstance();
        Content content = contentFactory.createContent(chatWindow.getContent(), "", false);
        toolWindow.getContentManager().addContent(content);

        content.setDisposer(() -> {
            ClaudeChatWindow window = instances.get(project);
            if (window != null) {
                window.dispose();
            }
        });
    }

    /**
     * 注册 JVM Shutdown Hook，确保在 IDEA 关闭时清理所有 Node.js 进程
     * 这是最后的保底机制，即使 dispose() 未被正常调用也能清理进程
     */
    private static synchronized void registerShutdownHook() {
        if (shutdownHookRegistered) {
            return;
        }
        shutdownHookRegistered = true;

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.info("[ShutdownHook] IDEA 正在关闭，清理所有 Node.js 进程...");

            ExecutorService executor = Executors.newSingleThreadExecutor();
            try {
                Future<?> future = executor.submit(() -> {
                    // 复制实例列表，避免并发修改
                    for (ClaudeChatWindow window : new java.util.ArrayList<>(instances.values())) {
                        try {
                            if (window != null && window.claudeSDKBridge != null) {
                                window.claudeSDKBridge.cleanupAllProcesses();
                            }
                            if (window != null && window.codexSDKBridge != null) {
                                window.codexSDKBridge.cleanupAllProcesses();
                            }
                        } catch (Exception e) {
                            // Shutdown hook 中不要抛出异常
                            LOG.error("[ShutdownHook] 清理进程时出错: " + e.getMessage());
                        }
                    }
                });

                // 最多等待3秒
                future.get(3, TimeUnit.SECONDS);
                LOG.info("[ShutdownHook] Node.js 进程清理完成");
            } catch (TimeoutException e) {
                LOG.warn("[ShutdownHook] 清理进程超时(3秒)，强制退出");
            } catch (Exception e) {
                LOG.error("[ShutdownHook] 清理进程失败: " + e.getMessage());
            } finally {
                executor.shutdownNow();
            }
        }, "Claude-Process-Cleanup-Hook"));

        LOG.info("[ShutdownHook] JVM Shutdown Hook 已注册");
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
                File bridgeDir = new File(basePath, "ai-bridge");
                File channelManager = new File(bridgeDir, "channel-manager.js");
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
                    // 使用已保存的路径
                    String path = savedNodePath.trim();
                    claudeSDKBridge.setNodeExecutable(path);
                    codexSDKBridge.setNodeExecutable(path);
                    // 验证并缓存 Node.js 版本
                    claudeSDKBridge.verifyAndCacheNodePath(path);
                    LOG.info("Using manually configured Node.js path: " + path);
                } else {
                    // 首次安装或未配置路径时，自动检测并缓存
                    LOG.info("No saved Node.js path found, attempting auto-detection...");
                    com.github.claudecodegui.model.NodeDetectionResult detected =
                        claudeSDKBridge.detectNodeWithDetails();

                    if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                        String detectedPath = detected.getNodePath();
                        String detectedVersion = detected.getNodeVersion();

                        // 保存检测到的路径
                        props.setValue(NODE_PATH_PROPERTY_KEY, detectedPath);

                        // 设置到两个 bridge
                        claudeSDKBridge.setNodeExecutable(detectedPath);
                        codexSDKBridge.setNodeExecutable(detectedPath);

                        // 验证并缓存版本信息
                        claudeSDKBridge.verifyAndCacheNodePath(detectedPath);

                        LOG.info("Auto-detected Node.js: " + detectedPath + " (" + detectedVersion + ")");
                    } else {
                        LOG.warn("Failed to auto-detect Node.js path. Error: " +
                            (detected != null ? detected.getErrorMessage() : "Unknown error"));
                    }
                }
            } catch (Exception e) {
                LOG.error("Failed to load Node.js path: " + e.getMessage(), e);
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
            // 注册 AskUserQuestion 对话框显示器
            permissionService.registerAskUserQuestionDialogShower(project, (requestId, questionsData) ->
                permissionHandler.showAskUserQuestionDialog(requestId, questionsData));
            LOG.info("Started permission service with frontend dialog and AskUserQuestion dialog for project: " + project.getName());
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
            messageDispatcher.registerHandler(new PromptEnhancerHandler(handlerContext));
            messageDispatcher.registerHandler(new AgentHandler(handlerContext));

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
            // Use the shared resolver from BridgePreloader for consistent state
            com.github.claudecodegui.bridge.BridgeDirectoryResolver sharedResolver = BridgePreloader.getSharedResolver();

            // Check if bridge extraction is in progress (non-blocking check)
            if (sharedResolver.isExtractionInProgress()) {
                LOG.info("[ClaudeSDKToolWindow] Bridge extraction in progress, showing loading panel...");
                showLoadingPanel();

                // Register async callback to reinitialize when extraction completes
                sharedResolver.getExtractionFuture().thenAcceptAsync(ready -> {
                    if (ready) {
                        reinitializeAfterExtraction();
                    } else {
                        ApplicationManager.getApplication().invokeLater(this::showErrorPanel);
                    }
                });
                return;
            }

            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedNodePath = props.getValue(NODE_PATH_PROPERTY_KEY);
            com.github.claudecodegui.model.NodeDetectionResult nodeResult = null;

            if (savedNodePath != null && !savedNodePath.trim().isEmpty()) {
                String trimmed = savedNodePath.trim();
                claudeSDKBridge.setNodeExecutable(trimmed);
                codexSDKBridge.setNodeExecutable(trimmed);
                nodeResult = claudeSDKBridge.verifyAndCacheNodePath(trimmed);
                if (nodeResult == null || !nodeResult.isFound()) {
                    showInvalidNodePathPanel(trimmed, nodeResult != null ? nodeResult.getErrorMessage() : null);
                    return;
                }
            } else {
                nodeResult = claudeSDKBridge.detectNodeWithDetails();
                if (nodeResult != null && nodeResult.isFound() && nodeResult.getNodePath() != null) {
                    props.setValue(NODE_PATH_PROPERTY_KEY, nodeResult.getNodePath());
                    claudeSDKBridge.setNodeExecutable(nodeResult.getNodePath());
                    codexSDKBridge.setNodeExecutable(nodeResult.getNodePath());
                    // 关键修复：缓存自动检测到的 Node.js 版本
                    claudeSDKBridge.verifyAndCacheNodePath(nodeResult.getNodePath());
                }
            }

            if (!claudeSDKBridge.checkEnvironment()) {
                // Check if bridge extraction is still in progress
                // If so, show loading panel instead of error panel
                if (sharedResolver.isExtractionInProgress()) {
                    LOG.info("[ClaudeSDKToolWindow] checkEnvironment failed but extraction in progress, showing loading panel...");
                    showLoadingPanel();
                    sharedResolver.getExtractionFuture().thenAcceptAsync(ready -> {
                        if (ready) {
                            reinitializeAfterExtraction();
                        } else {
                            ApplicationManager.getApplication().invokeLater(this::showErrorPanel);
                        }
                    });
                    return;
                }
                showErrorPanel();
                return;
            }

            if (nodeResult == null) {
                nodeResult = claudeSDKBridge.detectNodeWithDetails();
            }
            if (nodeResult != null && nodeResult.isFound() && nodeResult.getNodeVersion() != null) {
                if (!NodeDetector.isVersionSupported(nodeResult.getNodeVersion())) {
                    showVersionErrorPanel(nodeResult.getNodeVersion());
                    return;
                }
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

                        // 传递 IDEA 编辑器字体配置到前端
                        String fontConfig = FontConfigService.getEditorFontConfigJson();
                        LOG.info("[FontSync] 获取到的字体配置: " + fontConfig);
                        String fontConfigInjection = String.format(
                            "if (window.applyIdeaFontConfig) { window.applyIdeaFontConfig(%s); } " +
                            "else { window.__pendingFontConfig = %s; }",
                            fontConfig, fontConfig
                        );
                        cefBrowser.executeJavaScript(fontConfigInjection, cefBrowser.getURL(), 0);
                        LOG.info("[FontSync] 字体配置已注入到前端");

                        // 传递 IDEA 语言配置到前端
                        String languageConfig = LanguageConfigService.getLanguageConfigJson();
                        LOG.info("[LanguageSync] 获取到的语言配置: " + languageConfig);
                        String languageConfigInjection = String.format(
                            "if (window.applyIdeaLanguageConfig) { window.applyIdeaLanguageConfig(%s); } " +
                            "else { window.__pendingLanguageConfig = %s; }",
                            languageConfig, languageConfig
                        );
                        cefBrowser.executeJavaScript(languageConfigInjection, cefBrowser.getURL(), 0);
                        LOG.info("[LanguageSync] 语言配置已注入到前端");

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
                LOG.error("Failed to create UI components: " + e.getMessage(), e);
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

        private void showVersionErrorPanel(String currentVersion) {
            int minVersion = NodeDetector.MIN_NODE_MAJOR_VERSION;
            String message = "Node.js 版本过低\n\n" +
                "当前版本: " + currentVersion + "\n" +
                "最低要求: v" + minVersion + "\n\n" +
                "请升级 Node.js 到 v" + minVersion + " 或更高版本后重试。\n\n" +
                "当前检测到的 Node.js 路径: " + claudeSDKBridge.getNodeExecutable();

            JPanel errorPanel = ErrorPanelBuilder.build(
                "Node.js 版本不满足要求",
                message,
                claudeSDKBridge.getNodeExecutable(),
                this::handleNodePathSave
            );
            mainPanel.add(errorPanel, BorderLayout.CENTER);
        }

        private void showInvalidNodePathPanel(String path, String errMsg) {
            String message = "保存的 Node.js 路径不可用: " + path + "\n\n" +
                (errMsg != null ? errMsg + "\n\n" : "") +
                "请在下方重新保存正确的 Node.js 路径。";

            JPanel errorPanel = ErrorPanelBuilder.build(
                "Node.js 路径不可用",
                message,
                path,
                this::handleNodePathSave
            );
            mainPanel.add(errorPanel, BorderLayout.CENTER);
        }

        /**
         * Show a loading panel while AI Bridge is being extracted.
         * This avoids EDT freeze during first-time setup.
         */
        private void showLoadingPanel() {
            JPanel loadingPanel = new JPanel(new BorderLayout());
            loadingPanel.setBackground(new Color(30, 30, 30));

            JPanel centerPanel = new JPanel();
            centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
            centerPanel.setBackground(new Color(30, 30, 30));
            centerPanel.setBorder(BorderFactory.createEmptyBorder(100, 50, 100, 50));

            // Loading icon/spinner placeholder
            JLabel iconLabel = new JLabel("⏳");
            iconLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 48));
            iconLabel.setForeground(Color.WHITE);
            iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

            JLabel titleLabel = new JLabel("AI BridgPreparinge...(插件解压中...)");
            titleLabel.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 16));
            titleLabel.setForeground(Color.WHITE);
            titleLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

            JLabel descLabel = new JLabel("<html><center>First-time setup: extracting AI Bridge components.<br>This only happens once.<br>仅在首次安装/更新时候需要解压，解压后就没有此页面了</center></html>");
            descLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 12));
            descLabel.setForeground(new Color(180, 180, 180));
            descLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

            centerPanel.add(iconLabel);
            centerPanel.add(Box.createVerticalStrut(20));
            centerPanel.add(titleLabel);
            centerPanel.add(Box.createVerticalStrut(10));
            centerPanel.add(descLabel);

            loadingPanel.add(centerPanel, BorderLayout.CENTER);
            mainPanel.add(loadingPanel, BorderLayout.CENTER);

            LOG.info("[ClaudeSDKToolWindow] Showing loading panel while bridge extracts...");
        }

        /**
         * Reinitialize UI after bridge extraction completes.
         */
        private void reinitializeAfterExtraction() {
            ApplicationManager.getApplication().invokeLater(() -> {
                LOG.info("[ClaudeSDKToolWindow] Bridge extraction complete, reinitializing UI...");
                mainPanel.removeAll();
                createUIComponents();
                mainPanel.revalidate();
                mainPanel.repaint();
            });
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
                    // 同时设置 Claude 和 Codex 的 Node.js 路径，并缓存版本信息
                    claudeSDKBridge.setNodeExecutable(manualPath);
                    codexSDKBridge.setNodeExecutable(manualPath);
                    claudeSDKBridge.verifyAndCacheNodePath(manualPath);
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

            // 保存当前的 permission mode、provider、model（如果存在旧 session）
            String previousPermissionMode;
            String previousProvider;
            String previousModel;

            if (session != null) {
                previousPermissionMode = session.getPermissionMode();
                previousProvider = session.getProvider();
                previousModel = session.getModel();
            } else {
                // 如果没有旧 session，从持久化存储加载
                PropertiesComponent props = PropertiesComponent.getInstance();
                String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
                previousPermissionMode = (savedMode != null && !savedMode.trim().isEmpty()) ? savedMode.trim() : "bypassPermissions";
                // provider 和 model 使用默认值，因为窗口刚打开时前端会主动同步
                previousProvider = "claude";
                previousModel = "claude-sonnet-4-5";
            }
            LOG.info("Preserving session state when loading history: mode=" + previousPermissionMode + ", provider=" + previousProvider + ", model=" + previousModel);

            callJavaScript("clearMessages");

            session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);

            // 恢复之前保存的 permission mode、provider、model
            session.setPermissionMode(previousPermissionMode);
            session.setProvider(previousProvider);
            session.setModel(previousModel);
            LOG.info("Restored session state to loaded session: mode=" + previousPermissionMode + ", provider=" + previousProvider + ", model=" + previousModel);

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
                    LOG.info("[ClaudeSDKToolWindow] onMessageUpdate called, message count: " + messages.size());
                    if (!messages.isEmpty()) {
                        ClaudeSession.Message first = messages.get(0);
                        LOG.info("[ClaudeSDKToolWindow] First message: type=" + first.type +
                                ", content=" + (first.content != null ? first.content.substring(0, Math.min(50, first.content.length())) : "null") +
                                ", hasRaw=" + (first.raw != null));
                    }
                    ApplicationManager.getApplication().invokeLater(() -> {
                        String messagesJson = convertMessagesToJson(messages);
                        LOG.debug("Sending " + messages.size() + " messages to WebView, JSON length: " + messagesJson.length());
                        if (!messages.isEmpty()) {
                            ClaudeSession.Message lastMsg = messages.get(messages.size() - 1);
                            LOG.debug("Last message: type=" + lastMsg.type + ", content length=" + (lastMsg.content != null ? lastMsg.content.length() : 0));
                        }
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
                String currentMode = "bypassPermissions";  // 默认值

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
                    msgObj.add("raw", truncateRawForTransport(msg.raw));
                }
                messagesArray.add(msgObj);
            }
            return gson.toJson(messagesArray);
        }

        private static final int MAX_TOOL_RESULT_CHARS = 20000;

        private JsonObject truncateRawForTransport(JsonObject raw) {
            JsonElement contentEl = null;
            if (raw.has("content")) {
                contentEl = raw.get("content");
            } else if (raw.has("message") && raw.get("message").isJsonObject()) {
                JsonObject message = raw.getAsJsonObject("message");
                if (message.has("content")) {
                    contentEl = message.get("content");
                }
            }

            if (contentEl == null || !contentEl.isJsonArray()) {
                return raw;
            }

            JsonArray contentArr = contentEl.getAsJsonArray();
            boolean needsCopy = false;
            for (JsonElement el : contentArr) {
                if (!el.isJsonObject()) continue;
                JsonObject block = el.getAsJsonObject();
                if (!block.has("type") || block.get("type").isJsonNull()) continue;
                if (!"tool_result".equals(block.get("type").getAsString())) continue;
                if (!block.has("content") || block.get("content").isJsonNull()) continue;
                JsonElement c = block.get("content");
                if (c.isJsonPrimitive() && c.getAsJsonPrimitive().isString()) {
                    String s = c.getAsString();
                    if (s.length() > MAX_TOOL_RESULT_CHARS) {
                        needsCopy = true;
                        break;
                    }
                }
            }

            if (!needsCopy) {
                return raw;
            }

            JsonObject copied = raw.deepCopy();
            JsonElement copiedContentEl = null;
            if (copied.has("content")) {
                copiedContentEl = copied.get("content");
            } else if (copied.has("message") && copied.get("message").isJsonObject()) {
                JsonObject message = copied.getAsJsonObject("message");
                if (message.has("content")) {
                    copiedContentEl = message.get("content");
                }
            }

            if (copiedContentEl == null || !copiedContentEl.isJsonArray()) {
                return copied;
            }

            JsonArray copiedArr = copiedContentEl.getAsJsonArray();
            for (JsonElement el : copiedArr) {
                if (!el.isJsonObject()) continue;
                JsonObject block = el.getAsJsonObject();
                if (!block.has("type") || block.get("type").isJsonNull()) continue;
                if (!"tool_result".equals(block.get("type").getAsString())) continue;
                if (!block.has("content") || block.get("content").isJsonNull()) continue;
                JsonElement c = block.get("content");
                if (c.isJsonPrimitive() && c.getAsJsonPrimitive().isString()) {
                    String s = c.getAsString();
                    if (s.length() > MAX_TOOL_RESULT_CHARS) {
                        int head = (int) Math.floor(MAX_TOOL_RESULT_CHARS * 0.65);
                        int tail = MAX_TOOL_RESULT_CHARS - head;
                        String prefix = s.substring(0, Math.min(head, s.length()));
                        String suffix = tail > 0 ? s.substring(Math.max(0, s.length() - tail)) : "";
                        String truncated = prefix + "\n...\n(truncated, original length: " + s.length() + " chars)\n...\n" + suffix;
                        block.addProperty("content", truncated);
                    }
                }
            }

            return copied;
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

            // 保存当前的 permission mode、provider、model（如果存在旧 session）
            String previousPermissionMode = (session != null) ? session.getPermissionMode() : "bypassPermissions";
            String previousProvider = (session != null) ? session.getProvider() : "claude";
            String previousModel = (session != null) ? session.getModel() : "claude-sonnet-4-5";
            LOG.info("Preserving session state: mode=" + previousPermissionMode + ", provider=" + previousProvider + ", model=" + previousModel);

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

                // 恢复之前保存的 permission mode、provider、model
                session.setPermissionMode(previousPermissionMode);
                session.setProvider(previousProvider);
                session.setModel(previousModel);
                LOG.info("Restored session state to new session: mode=" + previousPermissionMode + ", provider=" + previousProvider + ", model=" + previousModel);

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
                    callJavaScript("updateStatus", JsUtils.escapeJs(ClaudeCodeGuiBundle.message("toast.newSessionCreatedReady")));

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

            // 注销权限服务的 dialogShower 和 askUserQuestionDialogShower，防止内存泄漏
            try {
                PermissionService permissionService = PermissionService.getInstance(project);
                permissionService.unregisterDialogShower(project);
                permissionService.unregisterAskUserQuestionDialogShower(project);
            } catch (Exception e) {
                LOG.warn("Failed to unregister dialog showers: " + e.getMessage());
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

            // 清理所有活跃的 Node.js 子进程
            try {
                if (claudeSDKBridge != null) {
                    int activeCount = claudeSDKBridge.getActiveProcessCount();
                    if (activeCount > 0) {
                        LOG.info("正在清理 " + activeCount + " 个活跃的 Claude 进程...");
                    }
                    claudeSDKBridge.cleanupAllProcesses();
                }
            } catch (Exception e) {
                LOG.warn("清理 Claude 进程失败: " + e.getMessage());
            }

            try {
                if (codexSDKBridge != null) {
                    int activeCount = codexSDKBridge.getActiveProcessCount();
                    if (activeCount > 0) {
                        LOG.info("正在清理 " + activeCount + " 个活跃的 Codex 进程...");
                    }
                    codexSDKBridge.cleanupAllProcesses();
                }
            } catch (Exception e) {
                LOG.warn("清理 Codex 进程失败: " + e.getMessage());
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
