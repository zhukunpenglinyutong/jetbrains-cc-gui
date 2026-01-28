package com.github.claudecodegui;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.cache.SlashCommandCache;
import com.github.claudecodegui.handler.AgentHandler;
import com.github.claudecodegui.handler.CodexMcpServerHandler;
import com.github.claudecodegui.handler.DependencyHandler;
import com.github.claudecodegui.handler.DiffHandler;
import com.github.claudecodegui.handler.FileExportHandler;
import com.github.claudecodegui.handler.FileHandler;
import com.github.claudecodegui.handler.HandlerContext;
import com.github.claudecodegui.handler.HistoryHandler;
import com.github.claudecodegui.handler.McpServerHandler;
import com.github.claudecodegui.handler.MessageDispatcher;
import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.handler.PromptEnhancerHandler;
import com.github.claudecodegui.handler.ProviderHandler;
import com.github.claudecodegui.handler.RewindHandler;
import com.github.claudecodegui.handler.UndoFileHandler;
import com.github.claudecodegui.handler.SessionHandler;
import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.handler.SkillHandler;
import com.github.claudecodegui.handler.TabHandler;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.settings.TabStateService;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.ui.ErrorPanelBuilder;
import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.util.HtmlLoader;
import com.github.claudecodegui.util.JBCefBrowserFactory;
import com.github.claudecodegui.util.JsUtils;
import com.github.claudecodegui.util.LanguageConfigService;
import com.github.claudecodegui.util.PlatformUtils;
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
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import com.intellij.ui.content.ContentManagerEvent;
import com.intellij.ui.content.ContentManagerListener;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;
import com.intellij.ui.jcef.JBCefJSQuery;
import com.intellij.util.Alarm;
import com.intellij.util.concurrency.AppExecutorUtil;
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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Claude SDK 聊天工具窗口
 * 实现 DumbAware 接口允许在索引构建期间使用此工具窗口
 */
public class ClaudeSDKToolWindow implements ToolWindowFactory, DumbAware {

    private static final Logger LOG = Logger.getInstance(ClaudeSDKToolWindow.class);
    private static final Map<Project, ClaudeChatWindow> instances = new ConcurrentHashMap<>();
    // Map to store Content -> ClaudeChatWindow mapping for multi-tab support
    // This allows sending code snippets to the currently selected tab instead of always the first tab
    private static final Map<Content, ClaudeChatWindow> contentToWindowMap = new ConcurrentHashMap<>();
    private static volatile boolean shutdownHookRegistered = false;
    private static final String TAB_NAME_PREFIX = "AI";

    /**
     * 获取指定项目的聊天窗口实例.
     *
     * @param project 项目
     * @return 聊天窗口实例，如果不存在返回 null
     */
    public static ClaudeChatWindow getChatWindow(Project project) {
        return instances.get(project);
    }

    /**
     * Generate the next available tab name in the format "AIN".
     * Finds the next available number by checking existing tab names.
     *
     * @param toolWindow the tool window to check existing tabs
     * @return the next available tab name (e.g., "AI1", "AI2", etc.)
     */
    public static String getNextTabName(ToolWindow toolWindow) {
        if (toolWindow == null) {
            return TAB_NAME_PREFIX + "1";
        }

        ContentManager contentManager = toolWindow.getContentManager();
        int maxNumber = 0;

        // Find the highest existing AIN number
        for (Content content : contentManager.getContents()) {
            String displayName = content.getDisplayName();
            if (displayName != null && displayName.startsWith(TAB_NAME_PREFIX)) {
                try {
                    int number = Integer.parseInt(displayName.substring(TAB_NAME_PREFIX.length()));
                    if (number > maxNumber) {
                        maxNumber = number;
                    }
                } catch (NumberFormatException ignored) {
                    // Ignore non-numeric suffixes
                }
            }
        }

        return TAB_NAME_PREFIX + (maxNumber + 1);
    }

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        // 注册 JVM Shutdown Hook（只注册一次）
        registerShutdownHook();

        ContentFactory contentFactory = ContentFactory.getInstance();
        ContentManager contentManager = toolWindow.getContentManager();

        // 检查 ai-bridge 是否已准备好
        if (BridgePreloader.isBridgeReady()) {
            // ai-bridge 已准备好，直接创建聊天窗口
            LOG.info("[ToolWindow] ai-bridge ready, creating chat window directly");
            createChatWindowContent(project, toolWindow, contentFactory, contentManager);
        } else {
            // ai-bridge 还没准备好，显示加载界面
            LOG.info("[ToolWindow] ai-bridge not ready, showing loading panel");
            JPanel loadingPanel = createLoadingPanel();
            Content loadingContent = contentFactory.createContent(loadingPanel, TAB_NAME_PREFIX + "1", false);
            contentManager.addContent(loadingContent);

            // 在后台触发解压并等待完成
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    // 触发解压（如果还没开始的话）
                    BridgePreloader.getSharedResolver().findSdkDir();

                    // 等待解压完成（最多等待 60 秒）
                    CompletableFuture<Boolean> future = BridgePreloader.waitForBridgeAsync();
                    Boolean ready = future.get(60, TimeUnit.SECONDS);

                    if (project.isDisposed()) {
                        return;
                    }

                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (project.isDisposed()) {
                            return;
                        }

                        if (ready != null && ready) {
                            LOG.info("[ToolWindow] ai-bridge ready, replacing loading panel with chat window");
                            // 替换加载面板为聊天窗口，而不是移除并重新创建
                            replaceLoadingPanelWithChatWindow(project, toolWindow, contentFactory, contentManager, loadingContent);
                        } else {
                            LOG.error("[ToolWindow] ai-bridge preparation failed");
                            // 显示错误信息
                            updateLoadingPanelWithError(loadingPanel, "AI Bridge preparation failed. Please restart IDE.");
                        }
                    });
                } catch (TimeoutException e) {
                    LOG.error("[ToolWindow] ai-bridge preparation timeout");
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (!project.isDisposed()) {
                            updateLoadingPanelWithError(loadingPanel, "AI Bridge preparation timeout. Please restart IDE.");
                        }
                    });
                } catch (Exception e) {
                    LOG.error("[ToolWindow] ai-bridge preparation error: " + e.getMessage());
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (!project.isDisposed()) {
                            updateLoadingPanelWithError(loadingPanel, "Error: " + e.getMessage());
                        }
                    });
                }
            });
        }

        // Add DevTools action to ToolWindow title bar (only in development mode)
        if (PlatformUtils.isPluginDevMode()) {
            com.intellij.openapi.actionSystem.AnAction devToolsAction =
                    com.intellij.openapi.actionSystem.ActionManager.getInstance()
                            .getAction("ClaudeCodeGUI.OpenDevToolsAction");
            if (devToolsAction != null) {
                toolWindow.setTitleActions(java.util.List.of(devToolsAction));
            }
        }

        // Add Rename Tab action to tool window gear menu
        com.intellij.openapi.actionSystem.AnAction renameTabAction =
                com.intellij.openapi.actionSystem.ActionManager.getInstance()
                        .getAction("ClaudeCodeGUI.RenameTabAction");
        if (renameTabAction != null) {
            toolWindow.setAdditionalGearActions(new com.intellij.openapi.actionSystem.DefaultActionGroup(renameTabAction));
        }

        // Add listener to manage tab closeable state based on tab count
        // When there's only one tab, disable the close button to prevent closing the last tab
        contentManager.addContentManagerListener(new ContentManagerListener() {
            @Override
            public void contentAdded(@NotNull ContentManagerEvent event) {
                updateTabCloseableState(contentManager);
                // Save tab count when tab is added
                TabStateService tabStateService = TabStateService.getInstance(project);
                tabStateService.saveTabCount(contentManager.getContentCount());
            }

            @Override
            public void contentRemoved(@NotNull ContentManagerEvent event) {
                updateTabCloseableState(contentManager);
                // Update tab state service when tab is removed
                int removedIndex = event.getIndex();
                TabStateService tabStateService = TabStateService.getInstance(project);
                tabStateService.onTabRemoved(removedIndex);
            }

            @Override
            public void contentRemoveQuery(@NotNull ContentManagerEvent event) {
                // Show confirmation dialog before closing tab
                Content content = event.getContent();
                String tabName = content.getDisplayName();

                int result = com.intellij.openapi.ui.Messages.showYesNoDialog(
                    project,
                    ClaudeCodeGuiBundle.message("tab.close.confirm.message", tabName),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.title"),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.yes"),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.no"),
                    com.intellij.openapi.ui.Messages.getQuestionIcon()
                );

                if (result != com.intellij.openapi.ui.Messages.YES) {
                    // User cancelled, prevent closing
                    event.consume();
                }
            }
        });

        // Initialize closeable state for the first tab
        updateTabCloseableState(contentManager);
    }

    /**
     * Update the closeable state of all tabs based on the tab count.
     * If there's only one tab, disable the close button; otherwise enable it.
     */
    private void updateTabCloseableState(ContentManager contentManager) {
        int tabCount = contentManager.getContentCount();
        boolean closeable = tabCount > 1;

        for (Content tab : contentManager.getContents()) {
            tab.setCloseable(closeable);
        }

        LOG.debug("[TabManager] Updated tab closeable state: count=" + tabCount + ", closeable=" + closeable);
    }

    /**
     * 创建加载面板，在 ai-bridge 准备好之前显示
     */
    private JPanel createLoadingPanel() {
        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBackground(com.github.claudecodegui.util.ThemeConfigService.getBackgroundColor());

        JPanel centerPanel = new JPanel();
        centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
        centerPanel.setOpaque(false);

        // 加载动画图标
        JLabel iconLabel = new JLabel("\u2699");  // ⚙ 齿轮符号
        iconLabel.setFont(iconLabel.getFont().deriveFont(48f));
        iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(iconLabel);

        centerPanel.add(Box.createVerticalStrut(16));

        // 加载提示文字
        JLabel textLabel = new JLabel("Preparing AI Bridge...(插件解压中...)");
        textLabel.setFont(textLabel.getFont().deriveFont(14f));
        textLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(textLabel);

        panel.add(centerPanel);
        return panel;
    }

    /**
     * 更新加载面板显示错误信息
     */
    private void updateLoadingPanelWithError(JPanel loadingPanel, String errorMessage) {
        loadingPanel.removeAll();

        JPanel centerPanel = new JPanel();
        centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
        centerPanel.setOpaque(false);

        // 错误图标
        JLabel iconLabel = new JLabel("\u26A0");  // ⚠ 警告符号
        iconLabel.setFont(iconLabel.getFont().deriveFont(48f));
        iconLabel.setForeground(Color.ORANGE);
        iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(iconLabel);

        centerPanel.add(Box.createVerticalStrut(16));

        // 错误信息
        JLabel textLabel = new JLabel(errorMessage);
        textLabel.setFont(textLabel.getFont().deriveFont(14f));
        textLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(textLabel);

        loadingPanel.add(centerPanel);
        loadingPanel.revalidate();
        loadingPanel.repaint();
    }

    /**
     * 替换加载面板为聊天窗口内容（在原标签页上直接替换）
     * 这样可以避免触发 contentRemoveQuery 事件和竞态条件问题
     */
    private void replaceLoadingPanelWithChatWindow(
            @NotNull Project project,
            @NotNull ToolWindow toolWindow,
            ContentFactory contentFactory,
            ContentManager contentManager,
            Content loadingContent
    ) {
        TabStateService tabStateService = TabStateService.getInstance(project);
        int savedTabCount = tabStateService.getTabCount();
        LOG.info("[TabManager] Restoring " + savedTabCount + " tabs from storage");

        // 创建第一个聊天窗口（主实例）
        ClaudeChatWindow firstChatWindow = new ClaudeChatWindow(project, false);

        // 获取保存的标签页名称
        String firstTabName;
        String savedFirstName = tabStateService.getTabName(0);
        if (savedFirstName != null && !savedFirstName.isEmpty()) {
            firstTabName = savedFirstName;
            LOG.info("[TabManager] Restored tab 0 name from storage: " + firstTabName);
        } else {
            firstTabName = TAB_NAME_PREFIX + "1";
        }

        // 直接替换加载内容的组件和名称，而不是移除并重新创建
        loadingContent.setComponent(firstChatWindow.getContent());
        loadingContent.setDisplayName(firstTabName);

        // 设置 parent content 以支持多标签页代码片段
        firstChatWindow.setParentContent(loadingContent);

        // 设置 disposer
        loadingContent.setDisposer(() -> {
            ClaudeChatWindow window = instances.get(project);
            if (window != null) {
                window.dispose();
            }
        });

        // 如果有多个标签页，创建其余的标签页
        for (int i = 1; i < savedTabCount; i++) {
            ClaudeChatWindow chatWindow = new ClaudeChatWindow(project, true);

            // 获取保存的标签页名称
            String tabName;
            String savedName = tabStateService.getTabName(i);
            if (savedName != null && !savedName.isEmpty()) {
                tabName = savedName;
                LOG.info("[TabManager] Restored tab " + i + " name from storage: " + tabName);
            } else {
                tabName = TAB_NAME_PREFIX + (i + 1);
            }

            Content content = contentFactory.createContent(chatWindow.getContent(), tabName, false);

            // 设置 parent content 以支持多标签页代码片段
            chatWindow.setParentContent(content);

            contentManager.addContent(content);
        }

        // 初始化所有标签页的可关闭状态
        updateTabCloseableState(contentManager);
    }

    /**
     * 创建聊天窗口内容（从原来的 createToolWindowContent 提取）
     */
    private void createChatWindowContent(
            @NotNull Project project,
            @NotNull ToolWindow toolWindow,
            ContentFactory contentFactory,
            ContentManager contentManager
    ) {
        TabStateService tabStateService = TabStateService.getInstance(project);
        int savedTabCount = tabStateService.getTabCount();
        LOG.info("[TabManager] Restoring " + savedTabCount + " tabs from storage");

        // Create multiple tabs based on saved count
        for (int i = 0; i < savedTabCount; i++) {
            // First tab uses the main instance, subsequent tabs use skipRegister=true
            boolean isFirstTab = (i == 0);
            ClaudeChatWindow chatWindow = new ClaudeChatWindow(project, !isFirstTab);

            // Get saved tab name or use default
            String tabName;
            String savedName = tabStateService.getTabName(i);
            if (savedName != null && !savedName.isEmpty()) {
                tabName = savedName;
                LOG.info("[TabManager] Restored tab " + i + " name from storage: " + tabName);
            } else {
                tabName = TAB_NAME_PREFIX + (i + 1);
            }

            Content content = contentFactory.createContent(chatWindow.getContent(), tabName, false);

            // Set parent content for multi-tab code snippet support
            chatWindow.setParentContent(content);

            contentManager.addContent(content);

            // Only set disposer for the first tab (main instance)
            if (isFirstTab) {
                content.setDisposer(() -> {
                    ClaudeChatWindow window = instances.get(project);
                    if (window != null) {
                        window.dispose();
                    }
                });
            }
        }

        // Initialize closeable state for all tabs
        updateTabCloseableState(contentManager);
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
        private Content parentContent;

        // Session ID for permission service cleanup
        private volatile String sessionId = null;

        // Editor Event Listeners
        private Alarm contextUpdateAlarm;
        private MessageBusConnection connection;

        private JBCefBrowser browser;
        private ClaudeSession session;

        // ===== Webview render watchdog (JCEF stall/black-screen recovery) =====
        private static final long WEBVIEW_HEARTBEAT_TIMEOUT_MS = 45_000L;
        private static final long WEBVIEW_WATCHDOG_INTERVAL_MS = 10_000L;
        private static final long WEBVIEW_RECOVERY_COOLDOWN_MS = 60_000L;
        private volatile long lastWebviewHeartbeatAtMs = System.currentTimeMillis();
        private volatile long lastWebviewRafAtMs = System.currentTimeMillis();
        private volatile String lastWebviewVisibility = null;
        private volatile Boolean lastWebviewHasFocus = null;
        private volatile int webviewStallCount = 0;
        private volatile long lastWebviewRecoveryAtMs = 0L;
        private volatile ScheduledFuture<?> webviewWatchdogFuture = null;

        // ===== 🔧 Streaming message update coalescing =====
        private static final int STREAM_MESSAGE_UPDATE_INTERVAL_MS = 50;
        private final Object streamMessageUpdateLock = new Object();
        private final Alarm streamMessageUpdateAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
        private volatile boolean streamActive = false;
        private volatile boolean streamMessageUpdateScheduled = false;
        private volatile long lastStreamMessageUpdateAtMs = 0L;
        private volatile long streamMessageUpdateSequence = 0L;
        private volatile List<ClaudeSession.Message> pendingStreamMessages = null;
        private volatile List<ClaudeSession.Message> lastMessagesSnapshot = null;

        private volatile boolean disposed = false;
        private volatile boolean initialized = false;
        private volatile boolean frontendReady = false;  // Frontend React app ready flag
        private volatile boolean slashCommandsFetched = false;  // 标记是否已通过 API 获取了完整命令列表
        private volatile int fetchedSlashCommandsCount = 0;

        // Pending QuickFix message (waiting for frontend to be ready)
        private volatile String pendingQuickFixPrompt = null;
        private volatile MessageCallback pendingQuickFixCallback = null;

        // 斜杠命令智能缓存
        private SlashCommandCache slashCommandCache;

        // Handler 相关
        private HandlerContext handlerContext;
        private MessageDispatcher messageDispatcher;
        private PermissionHandler permissionHandler;
        private HistoryHandler historyHandler;

        public ClaudeChatWindow(Project project) {
            this(project, false);
        }

        public ClaudeChatWindow(Project project, boolean skipRegister) {
            this.project = project;
            this.claudeSDKBridge = new ClaudeSDKBridge();
            this.codexSDKBridge = new CodexSDKBridge();
            this.settingsService = new CodemossSettingsService();
            this.htmlLoader = new HtmlLoader(getClass());
            this.mainPanel = new JPanel(new BorderLayout());

            // 设置 mainPanel 背景色，防止冷启动时闪白
            this.mainPanel.setBackground(com.github.claudecodegui.util.ThemeConfigService.getBackgroundColor());

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
            if (!skipRegister) {
                registerInstance();
            }
            initializeStatusBar();

            this.initialized = true;
            LOG.info("窗口实例已完全初始化，项目: " + project.getName());

            // 注意：斜杠命令的加载现在由前端发起
            // 前端在 bridge 准备好后会发送 frontend_ready 和 refresh_slash_commands 事件
            // 这确保了前后端初始化时序正确
        }

        public void setParentContent(Content content) {
            this.parentContent = content;
            // Register this window in the contentToWindowMap for multi-tab support
            if (content != null) {
                contentToWindowMap.put(content, this);
                LOG.debug("[MultiTab] Registered Content -> ClaudeChatWindow mapping for: " + content.getDisplayName());
            }
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
                        // Update status bar
                        com.github.claudecodegui.notifications.ClaudeNotifier.setMode(project, mode);
                    }
                }
            } catch (Exception e) {
                LOG.warn("Failed to load permission mode: " + e.getMessage());
            }
        }

        private void initializeStatusBar() {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (project == null || disposed) return;

                // Set initial mode
                String mode = session != null ? session.getPermissionMode() : "default";
                com.github.claudecodegui.notifications.ClaudeNotifier.setMode(project, mode);

                // Set initial model
                String model = session != null ? session.getModel() : "claude-sonnet-4-5";
                com.github.claudecodegui.notifications.ClaudeNotifier.setModel(project, model);

                // Set initial agent
                try {
                    String selectedId = settingsService.getSelectedAgentId();
                    if (selectedId != null) {
                        JsonObject agent = settingsService.getAgent(selectedId);
                        if (agent != null) {
                            String agentName = agent.has("name") ? agent.get("name").getAsString() : "Agent";
                            com.github.claudecodegui.notifications.ClaudeNotifier.setAgent(project, agentName);
                        }
                    }
                } catch (Exception e) {
                    LOG.warn("Failed to set initial agent in status bar: " + e.getMessage());
                }
            });
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
                if (settingsService.isLocalProviderActive()) {
                    LOG.info("[ClaudeSDKToolWindow] Local provider active, skipping startup sync");
                    return;
                }
                settingsService.applyActiveProviderToClaudeSettings();
            } catch (Exception e) {
                LOG.warn("Failed to sync active provider on startup: " + e.getMessage());
            }
        }

        private void setupPermissionService() {
            String sessionId = this.claudeSDKBridge.getSessionId();

            // Add defensive check for sessionId
            if (sessionId == null || sessionId.isEmpty()) {
                LOG.warn("Failed to get session ID from bridge, generating fallback UUID");
                sessionId = java.util.UUID.randomUUID().toString();
            }

            this.sessionId = sessionId;  // Save session ID for cleanup on dispose
            PermissionService permissionService = PermissionService.getInstance(this.project, sessionId);
            permissionService.start();
            // Use project registration mechanism to support multi-window scenarios
            permissionService.registerDialogShower(this.project, (toolName, inputs) ->
                this.permissionHandler.showFrontendPermissionDialog(toolName, inputs));
            // Register AskUserQuestion dialog shower
            permissionService.registerAskUserQuestionDialogShower(this.project, (requestId, questionsData) ->
                this.permissionHandler.showAskUserQuestionDialog(requestId, questionsData));
            // Register PlanApproval dialog shower
            permissionService.registerPlanApprovalDialogShower(this.project, (requestId, planData) ->
                this.permissionHandler.showPlanApprovalDialog(requestId, planData));
            LOG.info("Started permission service with frontend dialog, AskUserQuestion dialog, and PlanApproval dialog for project: " + this.project.getName());
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
            messageDispatcher.registerHandler(new CodexMcpServerHandler(handlerContext, settingsService.getCodexMcpServerManager()));
            messageDispatcher.registerHandler(new SkillHandler(handlerContext, mainPanel));
            messageDispatcher.registerHandler(new FileHandler(handlerContext));
            messageDispatcher.registerHandler(new SettingsHandler(handlerContext));
            messageDispatcher.registerHandler(new SessionHandler(handlerContext));
            messageDispatcher.registerHandler(new FileExportHandler(handlerContext));
            messageDispatcher.registerHandler(new DiffHandler(handlerContext));
            messageDispatcher.registerHandler(new PromptEnhancerHandler(handlerContext));
            messageDispatcher.registerHandler(new AgentHandler(handlerContext));
            messageDispatcher.registerHandler(new TabHandler(handlerContext));
            messageDispatcher.registerHandler(new RewindHandler(handlerContext));
            messageDispatcher.registerHandler(new UndoFileHandler(handlerContext));
            messageDispatcher.registerHandler(new DependencyHandler(handlerContext));

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
                // Check if bridge extraction is still in progress or just completed
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

                // Additional check: extraction completed but not yet effective (race condition)
                // This can happen when extraction just finished on another thread but checkEnvironment
                // was called before the directory became available
                if (sharedResolver.isExtractionComplete()) {
                    LOG.info("[ClaudeSDKToolWindow] checkEnvironment failed but extraction just completed, retrying initialization with exponential backoff...");
                    // Use exponential backoff retry strategy for more robust handling
                    retryCheckEnvironmentWithBackoff(0);
                    // Show loading panel while waiting for retry
                    showLoadingPanel();
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

            // Check JCEF support before creating browser
            if (!JBCefBrowserFactory.isJcefSupported()) {
                LOG.warn("JCEF is not supported in this environment");
                showJcefNotSupportedPanel();
                return;
            }

            try {
                browser = JBCefBrowserFactory.create();
                handlerContext.setBrowser(browser);

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

                // Reset webview health markers and start watchdog once the browser is created.
                lastWebviewHeartbeatAtMs = System.currentTimeMillis();
                lastWebviewRafAtMs = lastWebviewHeartbeatAtMs;
                webviewStallCount = 0;
                startWebviewWatchdog();

                JComponent browserComponent = browser.getComponent();

                // 设置 webview 容器背景色，防止 HTML 加载前闪白
                // 根据 IDE 主题设置背景色，与注入到 HTML 的颜色保持一致
                browserComponent.setBackground(com.github.claudecodegui.util.ThemeConfigService.getBackgroundColor());

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

            } catch (IllegalStateException e) {
                // JCEF-related errors typically throw IllegalStateException
                if (e.getMessage() != null && e.getMessage().contains("JCEF")) {
                    LOG.error("JCEF initialization failed: " + e.getMessage(), e);
                    showJcefNotSupportedPanel();
                } else {
                    LOG.error("Failed to create UI components: " + e.getMessage(), e);
                    showErrorPanel();
                }
            } catch (NullPointerException e) {
                // JCEF remote mode causes NPE when creating JBCefJSQuery
                // Error message: "Cannot read field \"isNull\" because \"robj\" is null"
                String msg = e.getMessage();
                if (msg != null && msg.contains("isNull") && msg.contains("robj")) {
                    LOG.error("JCEF remote mode incompatibility: " + e.getMessage(), e);
                    showJcefRemoteModeErrorPanel();
                } else {
                    LOG.error("Failed to create UI components (NPE): " + e.getMessage(), e);
                    showErrorPanel();
                }
            } catch (Exception e) {
                LOG.error("Failed to create UI components: " + e.getMessage(), e);
                showErrorPanel();
            }
        }

        private void showErrorPanel() {
            String message = "无法找到 Node.js（下方保存后请重启尝试）\n\n" +
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

        private void showJcefNotSupportedPanel() {
            JPanel errorPanel = new JPanel(new BorderLayout());
            errorPanel.setBackground(new Color(30, 30, 30));

            JPanel centerPanel = new JPanel();
            centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
            centerPanel.setBackground(new Color(30, 30, 30));
            centerPanel.setBorder(BorderFactory.createEmptyBorder(50, 50, 50, 50));

            JLabel iconLabel = new JLabel("⚠️");
            iconLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 48));
            iconLabel.setForeground(Color.WHITE);
            iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

            JLabel titleLabel = new JLabel("当前IDE JCEF 模块未安装");
            titleLabel.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 18));
            titleLabel.setForeground(Color.WHITE);
            titleLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

            JTextArea messageArea = new JTextArea();
            messageArea.setText(
                "解决方案：\n" +
                "双击 Shift 键，搜索 Choose Boot Java Runtime for the IDE\n" +
                "在弹出窗口的下拉列表中，选择一个标记有 with JCEF 的版本进行下载和安装。\n" +
                "等待下载完成并点击确定，随后重启 Android Studio"
            );
            messageArea.setEditable(false);
            messageArea.setBackground(new Color(45, 45, 45));
            messageArea.setForeground(new Color(200, 200, 200));
            messageArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 13));
            messageArea.setBorder(BorderFactory.createEmptyBorder(15, 15, 15, 15));
            messageArea.setAlignmentX(Component.CENTER_ALIGNMENT);
            messageArea.setMaximumSize(new Dimension(500, 300));

            centerPanel.add(iconLabel);
            centerPanel.add(Box.createVerticalStrut(15));
            centerPanel.add(titleLabel);
            centerPanel.add(Box.createVerticalStrut(20));
            centerPanel.add(messageArea);

            errorPanel.add(centerPanel, BorderLayout.CENTER);
            mainPanel.add(errorPanel, BorderLayout.CENTER);
        }

        private void showJcefRemoteModeErrorPanel() {
            JPanel errorPanel = new JPanel(new BorderLayout());
            errorPanel.setBackground(new Color(30, 30, 30));

            JPanel centerPanel = new JPanel();
            centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
            centerPanel.setBackground(new Color(30, 30, 30));
            centerPanel.setBorder(BorderFactory.createEmptyBorder(50, 50, 50, 50));

            JLabel iconLabel = new JLabel("⚠️");
            iconLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 48));
            iconLabel.setForeground(Color.WHITE);
            iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

            JLabel titleLabel = new JLabel("编辑器 JCEF 模块报错");
            titleLabel.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 18));
            titleLabel.setForeground(Color.WHITE);
            titleLabel.setAlignmentX(Component.CENTER_ALIGNMENT);

            JTextArea messageArea = new JTextArea();
            messageArea.setText(
                "解决方案：\n" +
                "✅ 彻底退出您当前的编辑器，重新启动编辑器就好了\n" +
                "⚠️ 请注意，一定要彻底退出，不要只退到项目选择页面" 
            );
            messageArea.setEditable(false);
            messageArea.setBackground(new Color(45, 45, 45));
            messageArea.setForeground(new Color(200, 200, 200));
            messageArea.setFont(new Font(Font.MONOSPACED, Font.PLAIN, 13));
            messageArea.setBorder(BorderFactory.createEmptyBorder(15, 15, 15, 15));
            messageArea.setAlignmentX(Component.CENTER_ALIGNMENT);
            messageArea.setMaximumSize(new Dimension(500, 300));

            centerPanel.add(iconLabel);
            centerPanel.add(Box.createVerticalStrut(15));
            centerPanel.add(titleLabel);
            centerPanel.add(Box.createVerticalStrut(20));
            centerPanel.add(messageArea);

            errorPanel.add(centerPanel, BorderLayout.CENTER);
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
            titleLabel.setHorizontalAlignment(SwingConstants.CENTER);

            JLabel descLabel = new JLabel("<html><center>First-time setup: extracting AI Bridge components.<br>This only happens once.<br>仅在首次安装/更新时候需要解压（大约10s~30s），解压后就没有此页面了</center></html>");
            descLabel.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 12));
            descLabel.setForeground(new Color(180, 180, 180));
            descLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
            descLabel.setHorizontalAlignment(SwingConstants.CENTER);

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

        /**
         * Retry environment check with exponential backoff strategy.
         * Delays: 100ms, 200ms, 400ms (max 3 retries)
         * This handles race conditions where extraction just completed but environment isn't ready yet.
         *
         * @param attempt current retry attempt (0-based)
         */
        private void retryCheckEnvironmentWithBackoff(int attempt) {
            final int MAX_RETRIES = 3;
            final int[] BACKOFF_DELAYS_MS = {100, 200, 400};

            if (attempt >= MAX_RETRIES) {
                LOG.warn("[ClaudeSDKToolWindow] All " + MAX_RETRIES + " retry attempts failed after extraction completion");
                ApplicationManager.getApplication().invokeLater(this::showErrorPanel);
                return;
            }

            int delayMs = BACKOFF_DELAYS_MS[attempt];
            LOG.info("[ClaudeSDKToolWindow] Retry attempt " + (attempt + 1) + "/" + MAX_RETRIES + ", waiting " + delayMs + "ms...");

            CompletableFuture.runAsync(() -> {
                try {
                    Thread.sleep(delayMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }).thenRun(() -> {
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (claudeSDKBridge.checkEnvironment()) {
                        LOG.info("[ClaudeSDKToolWindow] Retry attempt " + (attempt + 1) + " succeeded after extraction completion");
                        reinitializeAfterExtraction();
                    } else {
                        // Try next attempt with longer delay
                        retryCheckEnvironmentWithBackoff(attempt + 1);
                    }
                });
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

        private void handleWebviewHeartbeat(String content) {
            long now = System.currentTimeMillis();
            lastWebviewHeartbeatAtMs = now;

            if (content == null || content.isEmpty()) {
                lastWebviewRafAtMs = now;
                lastWebviewVisibility = null;
                lastWebviewHasFocus = null;
                return;
            }

            try {
                JsonObject json = new Gson().fromJson(content, JsonObject.class);
                if (json != null) {
                    if (json.has("raf")) {
                        lastWebviewRafAtMs = json.get("raf").getAsLong();
                    } else {
                        lastWebviewRafAtMs = now;
                    }
                    if (json.has("visibility")) {
                        lastWebviewVisibility = json.get("visibility").getAsString();
                    }
                    if (json.has("focus")) {
                        lastWebviewHasFocus = json.get("focus").getAsBoolean();
                    }
                }
            } catch (Exception ignored) {
                // Non-JSON heartbeat payload (backward compatibility)
                lastWebviewRafAtMs = now;
            }
        }

        private void startWebviewWatchdog() {
            if (webviewWatchdogFuture != null) {
                return;
            }

            webviewWatchdogFuture = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(() -> {
                try {
                    checkWebviewHealth();
                } catch (Exception e) {
                    LOG.debug("[WebviewWatchdog] Unexpected error: " + e.getMessage(), e);
                }
            }, WEBVIEW_WATCHDOG_INTERVAL_MS, WEBVIEW_WATCHDOG_INTERVAL_MS, TimeUnit.MILLISECONDS);
        }

        private void checkWebviewHealth() {
            if (disposed) return;
            if (!mainPanel.isShowing()) return;

            long now = System.currentTimeMillis();
            long heartbeatAgeMs = now - lastWebviewHeartbeatAtMs;
            long rafAgeMs = now - lastWebviewRafAtMs;

            boolean visible = lastWebviewVisibility == null || "visible".equals(lastWebviewVisibility);
            boolean focused = lastWebviewHasFocus == null || lastWebviewHasFocus;
            if (!visible || !focused) {
                return;
            }

            if (now - lastWebviewRecoveryAtMs < WEBVIEW_RECOVERY_COOLDOWN_MS) {
                return;
            }

            boolean stalled = heartbeatAgeMs > WEBVIEW_HEARTBEAT_TIMEOUT_MS || rafAgeMs > WEBVIEW_HEARTBEAT_TIMEOUT_MS;
            if (!stalled) {
                webviewStallCount = 0;
                return;
            }

            if (disposed) return;

            webviewStallCount += 1;
            String reason = "heartbeatAgeMs=" + heartbeatAgeMs + ", rafAgeMs=" + rafAgeMs;
            LOG.warn("[WebviewWatchdog] Webview appears stalled (" + webviewStallCount + "), attempting recovery. " + reason);

            lastWebviewRecoveryAtMs = now;
            // Give the webview a grace window after initiating recovery to avoid repeated triggers.
            lastWebviewHeartbeatAtMs = now;
            lastWebviewRafAtMs = now;

            if (webviewStallCount <= 1) {
                reloadWebview("watchdog_reload");
            } else {
                recreateWebview("watchdog_recreate");
                webviewStallCount = 0;
            }
        }

        private void reloadWebview(String reason) {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (disposed) return;
                if (browser == null) {
                    recreateWebview(reason + "_no_browser");
                    return;
                }
                frontendReady = false;
                try {
                    browser.loadHTML(htmlLoader.loadChatHtml());
                    mainPanel.revalidate();
                    mainPanel.repaint();
                } catch (Exception e) {
                    LOG.warn("[WebviewWatchdog] Reload failed: " + e.getMessage(), e);
                }
            });
        }

        private void recreateWebview(String reason) {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (disposed) return;

                frontendReady = false;
                try {
                    if (browser != null) {
                        try {
                            mainPanel.remove(browser.getComponent());
                        } catch (Exception ignored) {
                        }
                        try {
                            browser.dispose();
                        } catch (Exception e) {
                            LOG.debug("[WebviewWatchdog] Failed to dispose old browser: " + e.getMessage(), e);
                        }
                        browser = null;
                    }

                    LOG.info("[WebviewWatchdog] Recreating webview (" + reason + ")");
                    mainPanel.removeAll();
                    createUIComponents();
                    mainPanel.revalidate();
                    mainPanel.repaint();
                } catch (Exception e) {
                    LOG.warn("[WebviewWatchdog] Recreate failed: " + e.getMessage(), e);
                }
            });
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

            // Webview heartbeat (used by watchdog to detect JCEF stalls/black screens)
            if ("heartbeat".equals(type)) {
                handleWebviewHeartbeat(content);
                return;
            }

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
                frontendReady = true;

                // 发送当前权限模式到前端
                sendCurrentPermissionMode();

                // 如果缓存中已有数据，立即发送
                if (slashCommandCache != null && !slashCommandCache.isEmpty()) {
                    LOG.info("Cache has data, sending immediately");
                    sendCachedSlashCommands();
                }

                // [FIX] Process pending QuickFix message if exists
                if (pendingQuickFixPrompt != null && pendingQuickFixCallback != null) {
                    LOG.info("Processing pending QuickFix message after frontend ready");
                    String prompt = pendingQuickFixPrompt;
                    MessageCallback callback = pendingQuickFixCallback;
                    pendingQuickFixPrompt = null;
                    pendingQuickFixCallback = null;
                    // Execute on a separate thread to avoid blocking
                    ApplicationManager.getApplication().executeOnPooledThread(() -> {
                        executePendingQuickFix(prompt, callback);
                    });
                }

                // Re-push the latest message snapshot after a webview reload/recreate.
                // This ensures the UI can recover from a stalled/blank JCEF render state.
                flushStreamMessageUpdates(null);
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

            // 清理所有待处理的权限请求，防止旧会话的请求干扰新会话
            permissionHandler.clearPendingRequests();

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
                    lastMessagesSnapshot = messages;
                    // Always use throttled update mechanism to prevent excessive refreshes
                    // regardless of whether streamActive is true or false
                    enqueueStreamMessageUpdate(messages);
                }

                @Override
                public void onStateChange(boolean busy, boolean loading, String error) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        // FIX: 流式传输期间不发送 loading=false，避免 loading 状态被意外重置
                        // 由 onStreamEnd 统一处理状态清理
                        synchronized (streamMessageUpdateLock) {
                            if (!loading && streamActive) {
                                LOG.debug("Suppressing showLoading(false) during active streaming");
                                if (error != null) {
                                    callJavaScript("updateStatus", JsUtils.escapeJs("错误: " + error));
                                }
                                return;
                            }
                        }

                        callJavaScript("showLoading", String.valueOf(loading));
                        if (error != null) {
                            callJavaScript("updateStatus", JsUtils.escapeJs("错误: " + error));
                        }
                        if (!busy && !loading) {
                            VirtualFileManager.getInstance().asyncRefresh(null);
                        }
                    });
                }

                @Override
                public void onStatusMessage(String message) {
                    if (message == null || message.trim().isEmpty()) {
                        return;
                    }
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("updateStatus", JsUtils.escapeJs(message));
                    });
                }

                @Override
                public void onSessionIdReceived(String sessionId) {
                    LOG.info("Session ID: " + sessionId);
                    // Send sessionId to frontend for rewind feature
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("setSessionId", JsUtils.escapeJs(sessionId));
                    });
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

                @Override
                public void onSummaryReceived(String summary) {
                    LOG.debug("Summary received: " + (summary != null ? summary.substring(0, Math.min(50, summary.length())) : "null"));
                }

                @Override
                public void onNodeLog(String log) {
                    LOG.debug("Node log: " + (log != null ? log.substring(0, Math.min(100, log.length())) : "null"));
                }
                // ===== 🔧 流式传输回调方法 =====

                @Override
                public void onStreamStart() {
                    synchronized (streamMessageUpdateLock) {
                        streamActive = true;
                        pendingStreamMessages = null;
                        streamMessageUpdateAlarm.cancelAllRequests();
                        streamMessageUpdateScheduled = false;
                        lastStreamMessageUpdateAtMs = 0L;
                        streamMessageUpdateSequence += 1;
                    }
                    ApplicationManager.getApplication().invokeLater(() -> {
                        // FIX: 流式开始时确保 loading 状态为 true
                        // 防止在 stream_start 之前 loading 被意外重置
                        callJavaScript("showLoading", "true");
                        callJavaScript("onStreamStart");
                        LOG.debug("Stream started - notified frontend with loading=true");
                    });
                }

                @Override
                public void onStreamEnd() {
                    synchronized (streamMessageUpdateLock) {
                        streamActive = false;
                    }
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("onStreamEnd");
                        callJavaScript("showLoading", "false");
                        LOG.debug("Stream ended - notified frontend with onStreamEnd then loading=false");
                    });
                    flushStreamMessageUpdates(null);
                }

                @Override
                public void onContentDelta(String delta) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("onContentDelta", JsUtils.escapeJs(delta));
                    });
                }

                @Override
                public void onThinkingDelta(String delta) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("onThinkingDelta", JsUtils.escapeJs(delta));
                    });
                }
            });
        }

        private void enqueueStreamMessageUpdate(List<ClaudeSession.Message> messages) {
            if (disposed) {
                return;
            }
            synchronized (streamMessageUpdateLock) {
                pendingStreamMessages = messages;
            }
            scheduleStreamMessageUpdatePush();
        }

        private void scheduleStreamMessageUpdatePush() {
            if (disposed) {
                return;
            }

            final int delayMs;
            final long sequence;
            synchronized (streamMessageUpdateLock) {
                // Removed streamActive check - throttling should work regardless of stream mode
                if (streamMessageUpdateScheduled) {
                    return;
                }
                long elapsed = System.currentTimeMillis() - lastStreamMessageUpdateAtMs;
                delayMs = (int) Math.max(0L, STREAM_MESSAGE_UPDATE_INTERVAL_MS - elapsed);
                streamMessageUpdateScheduled = true;
                sequence = ++streamMessageUpdateSequence;
            }

            streamMessageUpdateAlarm.addRequest(() -> {
                final List<ClaudeSession.Message> snapshot;
                synchronized (streamMessageUpdateLock) {
                    streamMessageUpdateScheduled = false;
                    lastStreamMessageUpdateAtMs = System.currentTimeMillis();
                    snapshot = pendingStreamMessages;
                    pendingStreamMessages = null;
                }

                if (disposed) {
                    return;
                }

                if (snapshot != null) {
                    sendStreamMessagesToWebView(snapshot, sequence, null);
                }

                boolean hasPending;
                synchronized (streamMessageUpdateLock) {
                    hasPending = pendingStreamMessages != null;
                }
                // Continue scheduling if there are pending messages (regardless of stream mode)
                if (hasPending && !disposed) {
                    scheduleStreamMessageUpdatePush();
                }
            }, delayMs);
        }

        private void flushStreamMessageUpdates(Runnable afterFlushOnEdt) {
            if (disposed) {
                return;
            }

            final List<ClaudeSession.Message> snapshot;
            final long sequence;
            synchronized (streamMessageUpdateLock) {
                streamMessageUpdateAlarm.cancelAllRequests();
                streamMessageUpdateScheduled = false;
                snapshot = pendingStreamMessages != null ? pendingStreamMessages : lastMessagesSnapshot;
                pendingStreamMessages = null;
                sequence = ++streamMessageUpdateSequence;
            }

            if (snapshot == null) {
                if (afterFlushOnEdt != null) {
                    ApplicationManager.getApplication().invokeLater(afterFlushOnEdt);
                }
                return;
            }

            sendStreamMessagesToWebView(snapshot, sequence, afterFlushOnEdt);
        }

        private void sendStreamMessagesToWebView(
            List<ClaudeSession.Message> messages,
            long sequence,
            Runnable afterSendOnEdt
        ) {
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                final String escapedMessagesJson;
                try {
                    escapedMessagesJson = JsUtils.escapeJs(convertMessagesToJson(messages));
                } catch (Exception e) {
                    LOG.warn("Failed to serialize messages for streaming update: " + e.getMessage(), e);
                    if (afterSendOnEdt != null) {
                        ApplicationManager.getApplication().invokeLater(afterSendOnEdt);
                    }
                    return;
                }

                ApplicationManager.getApplication().invokeLater(() -> {
                    if (disposed) {
                        return;
                    }

                    synchronized (streamMessageUpdateLock) {
                        if (sequence != streamMessageUpdateSequence) {
                            return;
                        }
                    }

                    callJavaScript("updateMessages", escapedMessagesJson);
                    pushUsageUpdateFromMessages(messages);

                    if (afterSendOnEdt != null) {
                        afterSendOnEdt.run();
                    }
                });
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

                // [FIX] Reset stream state and notify frontend
                // This ensures streamActive flag is reset and loading=false takes effect
                synchronized (streamMessageUpdateLock) {
                    streamActive = false;
                }
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("onStreamEnd");
                    callJavaScript("showLoading", "false");
                });

                // 清理所有待处理的权限请求，防止旧会话的请求干扰新会话
                permissionHandler.clearPendingRequests();

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
            this.session.interrupt().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
                // 通知前端权限被拒绝，让前端标记未完成的工具调用为"中断"状态
                callJavaScript("onPermissionDenied");
                // Align with explicit interrupt behavior to clear streaming/loading UI state.
                callJavaScript("onStreamEnd");
                callJavaScript("showLoading", "false");
                com.github.claudecodegui.notifications.ClaudeNotifier.clearStatus(project);
            }));
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
         *
         * [FIX] Now sends code to the currently selected tab instead of always the first tab
         */
        static void addSelectionFromExternalInternal(Project project, String selectionInfo) {
            if (project == null) {
                LOG.error("project 参数为 null");
                return;
            }

            // [FIX] Try to get the currently selected tab's window first
            ClaudeChatWindow window = getSelectedTabWindow(project);

            // Fallback to instances map if no selected tab window found
            if (window == null) {
                window = instances.get(project);
            }

            if (window == null) {
                // 如果窗口不存在，自动打开工具窗口
                LOG.info("窗口实例不存在，自动打开工具窗口: " + project.getName());
                ApplicationManager.getApplication().invokeLater(() -> {
                    try {
                        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                        if (toolWindow != null) {
                            toolWindow.show(null);
                            // Use Alarm for proper delayed retry instead of nested invokeLater
                            scheduleCodeSnippetRetry(project, selectionInfo, 3);
                        } else {
                            LOG.error("无法找到 CCG 工具窗口");
                        }
                    } catch (Exception e) {
                        LOG.error("打开工具窗口时出错: " + e.getMessage());
                    }
                });
                return;
            }

            if (window.disposed) {
                // Clean up from contentToWindowMap as well
                if (window.parentContent != null) {
                    contentToWindowMap.remove(window.parentContent);
                }
                instances.remove(project);
                return;
            }

            if (!window.initialized) {
                // Use proper retry mechanism instead of Thread.sleep on EDT
                scheduleCodeSnippetRetry(project, selectionInfo, 3);
                return;
            }

            // 从外部调用，使用 addCodeSnippet 添加代码片段标签
            window.addCodeSnippet(selectionInfo);
        }

        /**
         * Get the ClaudeChatWindow for the currently selected tab
         * Returns null if no selected tab or mapping not found
         */
        private static ClaudeChatWindow getSelectedTabWindow(Project project) {
            if (project == null || project.isDisposed()) {
                return null;
            }

            try {
                ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                if (toolWindow == null) {
                    return null;
                }

                ContentManager contentManager = toolWindow.getContentManager();
                Content selectedContent = contentManager.getSelectedContent();

                if (selectedContent != null) {
                    ClaudeChatWindow window = contentToWindowMap.get(selectedContent);
                    if (window != null) {
                        LOG.debug("[MultiTab] Found window for selected tab: " + selectedContent.getDisplayName());
                        return window;
                    }
                }
            } catch (Exception e) {
                LOG.debug("[MultiTab] Failed to get selected tab window: " + e.getMessage());
            }

            return null;
        }

        /**
         * Schedule code snippet addition with retry mechanism using ScheduledExecutorService.
         * Uses exponential backoff (200ms, 400ms, 800ms) to avoid resource waste.
         *
         * [FIX] Now uses getSelectedTabWindow to send to the currently selected tab
         */
        private static void scheduleCodeSnippetRetry(Project project, String selectionInfo, int retriesLeft) {
            if (retriesLeft <= 0) {
                LOG.warn("Failed to add code snippet after max retries");
                return;
            }

            // Calculate delay with exponential backoff (200ms, 400ms, 800ms)
            int delay = 200 * (int) Math.pow(2, 3 - retriesLeft);

            AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> {
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (project.isDisposed()) {
                        return;
                    }

                    // [FIX] Try to get the currently selected tab's window first
                    ClaudeChatWindow retryWindow = getSelectedTabWindow(project);

                    // Fallback to instances map if no selected tab window found
                    if (retryWindow == null) {
                        retryWindow = instances.get(project);
                    }

                    if (retryWindow != null && retryWindow.initialized && !retryWindow.disposed) {
                        retryWindow.addCodeSnippet(selectionInfo);
                    } else {
                        LOG.debug("Window not ready, retrying (retries left: " + (retriesLeft - 1) + ")");
                        scheduleCodeSnippetRetry(project, selectionInfo, retriesLeft - 1);
                    }
                });
            }, delay, java.util.concurrent.TimeUnit.MILLISECONDS);
        }

        /**
         * 发送 QuickFix 消息 - 供 QuickFixWithClaudeAction 调用
         * Send QuickFix message - called by QuickFixWithClaudeAction
         */
        public void sendQuickFixMessage(String prompt, boolean isQuickFix, MessageCallback callback) {
            if (session == null) {
                LOG.warn("QuickFix: Session is null, cannot send message");
                ApplicationManager.getApplication().invokeLater(() -> {
                    callback.onError("Session not initialized. Please wait for the tool window to fully load.");
                });
                return;
            }

            session.getContextCollector().setQuickFix(isQuickFix);

            // [FIX] If frontend is not ready yet, queue the message for later processing
            if (!frontendReady) {
                LOG.info("QuickFix: Frontend not ready, queuing message for later");
                pendingQuickFixPrompt = prompt;
                pendingQuickFixCallback = callback;
                return;
            }

            // Frontend is ready, execute immediately
            executeQuickFixInternal(prompt, callback);
        }

        /**
         * Execute pending QuickFix message after frontend is ready
         */
        private void executePendingQuickFix(String prompt, MessageCallback callback) {
            if (session == null || disposed) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    callback.onError("Session not available");
                });
                return;
            }
            executeQuickFixInternal(prompt, callback);
        }

        /**
         * Internal method to execute QuickFix message
         */
        private void executeQuickFixInternal(String prompt, MessageCallback callback) {
            // [FIX] Issue 1: Immediately show user message in frontend before sending
            // Issue 2: Set loading state to disable send button during AI response
            String escapedPrompt = JsUtils.escapeJs(prompt);
            callJavaScript("addUserMessage", escapedPrompt);
            callJavaScript("showLoading", "true");

            session.send(prompt).thenRun(() -> {
                List<ClaudeSession.Message> messages = session.getMessages();
                if (!messages.isEmpty()) {
                    ClaudeSession.Message last = messages.get(messages.size() - 1);
                    if (last.type == ClaudeSession.Message.Type.ASSISTANT && last.content != null) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            callback.onComplete(SDKResult.success(last.content));
                        });
                    }
                }
            }).exceptionally(ex -> {
                ApplicationManager.getApplication().invokeLater(() -> {
                    callback.onError(ex.getMessage());
                });
                return null;
            });
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
            try {
                streamMessageUpdateAlarm.cancelAllRequests();
                streamMessageUpdateAlarm.dispose();
            } catch (Exception e) {
                LOG.warn("Failed to dispose stream message update alarm: " + e.getMessage());
            }

            try {
                if (webviewWatchdogFuture != null) {
                    webviewWatchdogFuture.cancel(true);
                    webviewWatchdogFuture = null;
                }
            } catch (Exception e) {
                LOG.debug("Failed to cancel webview watchdog: " + e.getMessage(), e);
            }

            // 清理斜杠命令缓存
            if (slashCommandCache != null) {
                slashCommandCache.dispose();
                slashCommandCache = null;
            }

            // 注销权限服务的 dialogShower、askUserQuestionDialogShower 和 planApprovalDialogShower，防止内存泄漏
            try {
                // Get permission service using sessionId to avoid deprecated method
                if (this.sessionId != null && !this.sessionId.isEmpty()) {
                    PermissionService permissionService = PermissionService.getInstance(project, this.sessionId);
                    permissionService.unregisterDialogShower(project);
                    permissionService.unregisterAskUserQuestionDialogShower(project);
                    permissionService.unregisterPlanApprovalDialogShower(project);

                    // Clean up the session instance from static map to prevent memory leak
                    // This removes the PermissionService instance from instancesBySessionId
                    PermissionService.removeInstance(this.sessionId);
                    LOG.info("Removed PermissionService instance for sessionId: " + this.sessionId);
                }
            } catch (Exception e) {
                LOG.warn("Failed to unregister dialog showers or remove session instance: " + e.getMessage());
            }

            LOG.info("开始清理窗口资源，项目: " + project.getName());

            disposed = true;
            handlerContext.setDisposed(true);

            // [FIX] Clean up contentToWindowMap for multi-tab support
            if (parentContent != null) {
                contentToWindowMap.remove(parentContent);
                LOG.debug("[MultiTab] Removed Content -> ClaudeChatWindow mapping during dispose");
            }

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
