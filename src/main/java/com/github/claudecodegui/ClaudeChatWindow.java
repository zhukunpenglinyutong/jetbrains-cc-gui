package com.github.claudecodegui;

import com.github.claudecodegui.handler.HandlerContext;
import com.github.claudecodegui.handler.HistoryHandler;
import com.github.claudecodegui.handler.MessageDispatcher;
import com.github.claudecodegui.handler.PermissionHandler;
import com.github.claudecodegui.permission.PermissionService;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.session.SessionCallbackAdapter;
import com.github.claudecodegui.session.SessionLifecycleManager;
import com.github.claudecodegui.session.StreamMessageCoalescer;
import com.github.claudecodegui.ui.ChatWindowDelegate;
import com.github.claudecodegui.ui.EditorContextTracker;
import com.github.claudecodegui.ui.WebviewInitializer;
import com.github.claudecodegui.ui.WebviewWatchdog;
import com.github.claudecodegui.util.HtmlLoader;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.ui.content.Content;
import com.intellij.ui.jcef.JBCefBrowser;

import javax.swing.*;
import java.awt.*;

/**
 * Chat window instance. Coordinates UI components, session management,
 * and message dispatching. One instance per tab.
 */
public class ClaudeChatWindow {

    private static final Logger LOG = Logger.getInstance(ClaudeChatWindow.class);

    private final JPanel mainPanel;
    final ClaudeSDKBridge claudeSDKBridge;
    final CodexSDKBridge codexSDKBridge;
    private final Project project;
    private final CodemossSettingsService settingsService;
    private final HtmlLoader htmlLoader;

    private Content parentContent;
    private String originalTabName;
    private volatile String sessionId = null;

    JBCefBrowser browser;
    ClaudeSession session;
    private WebviewWatchdog webviewWatchdog;
    private StreamMessageCoalescer streamCoalescer;

    private volatile boolean disposed = false;
    private volatile boolean initialized = false;
    volatile boolean frontendReady = false;
    private volatile boolean slashCommandsFetched = false;
    private volatile int fetchedSlashCommandsCount = 0;

    HandlerContext handlerContext;
    MessageDispatcher messageDispatcher;
    PermissionHandler permissionHandler;
    private HistoryHandler historyHandler;
    private SessionLifecycleManager sessionLifecycleManager;

    // Delegates
    private WebviewInitializer webviewInitializer;
    private EditorContextTracker editorContextTracker;
    private ChatWindowDelegate chatWindowDelegate;

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

        // Set mainPanel background color to prevent white flash on cold start
        this.mainPanel.setBackground(com.github.claudecodegui.util.ThemeConfigService.getBackgroundColor());

        // Initialize webview watchdog (recreateWebview callback is lazy via webviewInitializer field)
        this.webviewWatchdog = new WebviewWatchdog(
                mainPanel,
                () -> browser,
                htmlLoader,
                () -> webviewInitializer.recreateWebview("watchdog_recreate"),
                () -> disposed
        );

        // Initialize session
        this.session = new ClaudeSession(project, claudeSDKBridge, codexSDKBridge);

        // Create ChatWindowDelegate for init and runtime operations
        this.chatWindowDelegate = new ChatWindowDelegate(createDelegateHost());
        chatWindowDelegate.loadPermissionModeFromSettings();
        chatWindowDelegate.loadNodePathFromSettings();
        chatWindowDelegate.syncActiveProvider();
        chatWindowDelegate.initializeHandlers();
        // setupPermissionService after initializeHandlers (permissionHandler must exist)
        this.sessionId = chatWindowDelegate.setupPermissionService();

        // Initialize stream message coalescer
        this.streamCoalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
            @Override public void callJavaScript(String functionName, String... args) {
                ClaudeChatWindow.this.callJavaScript(functionName, args);
            }
            @Override public JBCefBrowser getBrowser() { return browser; }
            @Override public boolean isDisposed() { return disposed; }
            @Override public HandlerContext getHandlerContext() { return handlerContext; }
        });

        // Initialize session lifecycle manager
        this.sessionLifecycleManager = new SessionLifecycleManager(new SessionLifecycleManager.SessionHost() {
            @Override public Project getProject() { return project; }
            @Override public ClaudeSDKBridge getClaudeSDKBridge() { return claudeSDKBridge; }
            @Override public CodexSDKBridge getCodexSDKBridge() { return codexSDKBridge; }
            @Override public ClaudeSession getSession() { return session; }
            @Override public void setSession(ClaudeSession s) { session = s; }
            @Override public HandlerContext getHandlerContext() { return handlerContext; }
            @Override public StreamMessageCoalescer getStreamCoalescer() { return streamCoalescer; }
            @Override public void clearPendingPermissionRequests() { permissionHandler.clearPendingRequests(); }
            @Override public void callJavaScript(String fn, String... args) { ClaudeChatWindow.this.callJavaScript(fn, args); }
            @Override public boolean isDisposed() { return disposed; }
            @Override public JBCefBrowser getBrowser() { return browser; }
            @Override public void setupSessionCallbacks() { ClaudeChatWindow.this.setupSessionCallbacks(); }
            @Override public void setSlashCommandsFetched(boolean fetched) { slashCommandsFetched = fetched; }
            @Override public void setFetchedSlashCommandsCount(int count) { fetchedSlashCommandsCount = count; }
        });

        // Initialize editor context tracker
        this.editorContextTracker = new EditorContextTracker(project, new EditorContextTracker.ContextCallback() {
            @Override public void addSelectionInfo(String info) { callJavaScript("addSelectionInfo", info); }
            @Override public void clearSelectionInfo() { callJavaScript("clearSelectionInfo"); }
        });
        editorContextTracker.registerListeners();

        // Create webview initializer
        this.webviewInitializer = new WebviewInitializer(createWebviewHost());

        setupSessionCallbacks();
        initializeSessionInfo();
        webviewInitializer.overrideBridgePathIfAvailable();
        webviewInitializer.createUIComponents();
        registerSessionLoadListener();
        if (!skipRegister) {
            registerInstance();
        }
        chatWindowDelegate.initializeStatusBar();

        this.initialized = true;
        LOG.info("Window instance fully initialized, project: " + project.getName());
    }

    // ==================== Public API ====================

    public void setParentContent(Content content) {
        this.parentContent = content;
        if (content != null) {
            ClaudeSDKToolWindow.registerContentMapping(content, this);
            LOG.debug("[MultiTab] Registered Content -> ClaudeChatWindow mapping for: " + content.getDisplayName());

            if (this.originalTabName == null) {
                String displayName = content.getDisplayName();
                this.originalTabName = displayName.endsWith("...")
                    ? displayName.substring(0, displayName.length() - 3)
                    : displayName;
                LOG.debug("[TabLoading] Auto-initialized original tab name: " + this.originalTabName);
            }
        }
    }

    public void setOriginalTabName(String name) {
        this.originalTabName = name;
        LOG.debug("[TabLoading] Set original tab name: " + name);
    }

    public boolean isDisposed() { return disposed; }
    public boolean isInitialized() { return initialized; }
    public Content getParentContent() { return parentContent; }
    public JPanel getContent() { return mainPanel; }

    public void addCodeSnippetFromExternal(String selectionInfo) {
        addCodeSnippet(selectionInfo);
    }

    public void updateTabStatus(ChatWindowDelegate.TabAnswerStatus status) {
        chatWindowDelegate.updateTabStatus(status);
    }

    @Deprecated
    public void updateTabLoadingState(boolean loading) {
        chatWindowDelegate.updateTabLoadingState(loading);
    }

    public void sendQuickFixMessage(String prompt, boolean isQuickFix, MessageCallback callback) {
        chatWindowDelegate.sendQuickFixMessage(prompt, isQuickFix, callback);
    }

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

    // ==================== JavaScript Bridge ====================

    void callJavaScript(String functionName, String... args) {
        if (disposed || browser == null) {
            LOG.warn("\u65e0\u6cd5\u8c03\u7528 JS \u51fd\u6570 " + functionName + ": disposed=" + disposed + ", browser=" + (browser == null ? "null" : "exists"));
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
                LOG.warn("\u8c03\u7528 JS \u51fd\u6570\u5931\u8d25: " + functionName + ", \u9519\u8bef: " + e.getMessage(), e);
            }
        });
    }

    void handleJavaScriptMessage(String message) {
        // Handle console log forwarding (JSON format)
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
                LOG.warn("Failed to parse console log: " + e.getMessage());
            }
            return;
        }

        // Parse type:content format
        String[] parts = message.split(":", 2);
        if (parts.length < 1) {
            LOG.error("Invalid message format");
            return;
        }

        String type = parts[0];
        String content = parts.length > 1 ? parts[1] : "";

        if (messageDispatcher.dispatch(type, content)) {
            return;
        }

        LOG.warn("Unknown message type: " + type);
    }

    // ==================== Session Delegates ====================

    private void setupSessionCallbacks() {
        session.setCallback(new SessionCallbackAdapter(
            streamCoalescer,
            this::callJavaScript,
            permissionHandler,
            () -> slashCommandsFetched
        ));
    }

    private void initializeSessionInfo() {
        String workingDirectory = sessionLifecycleManager.determineWorkingDirectory();
        session.setSessionInfo(null, workingDirectory);
        LOG.info("Initialized with working directory: " + workingDirectory);
    }

    private void registerSessionLoadListener() {
        SessionLoadService.getInstance().setListener((sessionId, projectPath) -> {
            ApplicationManager.getApplication().invokeLater(() ->
                sessionLifecycleManager.loadHistorySession(sessionId, projectPath));
        });
    }

    private void registerInstance() {
        ClaudeSDKToolWindow.registerWindow(project, this);
    }

    private void interruptDueToPermissionDenial() {
        this.session.interrupt().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("onPermissionDenied");
            callJavaScript("onStreamEnd");
            callJavaScript("showLoading", "false");
            com.github.claudecodegui.notifications.ClaudeNotifier.clearStatus(project);
        }));
    }

    // ==================== Code Snippets ====================

    private void addCodeSnippet(String selectionInfo) {
        if (selectionInfo != null && !selectionInfo.isEmpty()) {
            callJavaScript("addCodeSnippet", JsUtils.escapeJs(selectionInfo));
        }
    }

    // ==================== Dispose ====================

    public void dispose() {
        if (disposed) return;

        chatWindowDelegate.dispose();
        editorContextTracker.dispose();
        streamCoalescer.dispose();
        webviewWatchdog.stop();

        // Unregister permission service dialog showers
        try {
            if (this.sessionId != null && !this.sessionId.isEmpty()) {
                PermissionService permissionService = PermissionService.getInstance(project, this.sessionId);
                permissionService.unregisterDialogShower(project);
                permissionService.unregisterAskUserQuestionDialogShower(project);
                permissionService.unregisterPlanApprovalDialogShower(project);
                PermissionService.removeInstance(this.sessionId);
                LOG.info("Removed PermissionService instance for sessionId: " + this.sessionId);
            }
        } catch (Exception e) {
            LOG.warn("Failed to unregister dialog showers or remove session instance: " + e.getMessage());
        }

        LOG.info("\u5f00\u59cb\u6e05\u7406\u7a97\u53e3\u8d44\u6e90\uff0c\u9879\u76ee: " + project.getName());

        disposed = true;
        handlerContext.setDisposed(true);

        if (parentContent != null) {
            ClaudeSDKToolWindow.unregisterContentMapping(parentContent);
            LOG.debug("[MultiTab] Removed Content -> ClaudeChatWindow mapping during dispose");
        }

        ClaudeSDKToolWindow.unregisterWindow(project, this);

        try {
            if (session != null) session.interrupt();
        } catch (Exception e) {
            LOG.warn("Failed to clean up session: " + e.getMessage());
        }

        try {
            if (claudeSDKBridge != null) {
                int activeCount = claudeSDKBridge.getActiveProcessCount();
                if (activeCount > 0) {
                    LOG.info("\u6b63\u5728\u6e05\u7406 " + activeCount + " \u4e2a\u6d3b\u8dc3\u7684 Claude \u8fdb\u7a0b...");
                }
                claudeSDKBridge.cleanupAllProcesses();
            }
        } catch (Exception e) {
            LOG.warn("\u6e05\u7406 Claude \u8fdb\u7a0b\u5931\u8d25: " + e.getMessage());
        }

        try {
            if (codexSDKBridge != null) {
                int activeCount = codexSDKBridge.getActiveProcessCount();
                if (activeCount > 0) {
                    LOG.info("\u6b63\u5728\u6e05\u7406 " + activeCount + " \u4e2a\u6d3b\u8dc3\u7684 Codex \u8fdb\u7a0b...");
                }
                codexSDKBridge.cleanupAllProcesses();
            }
        } catch (Exception e) {
            LOG.warn("\u6e05\u7406 Codex \u8fdb\u7a0b\u5931\u8d25: " + e.getMessage());
        }

        try {
            if (browser != null) {
                browser.dispose();
                browser = null;
            }
        } catch (Exception e) {
            LOG.warn("\u6e05\u7406\u6d4f\u89c8\u5668\u5931\u8d25: " + e.getMessage());
        }

        messageDispatcher.clear();

        LOG.info("\u7a97\u53e3\u8d44\u6e90\u5df2\u5b8c\u5168\u6e05\u7406\uff0c\u9879\u76ee: " + project.getName());
    }

    // ==================== Host Interface Factories ====================

    private WebviewInitializer.WebviewHost createWebviewHost() {
        return new WebviewInitializer.WebviewHost() {
            @Override public Project getProject() { return project; }                       // Current IDEA project
            @Override public ClaudeSDKBridge getClaudeSDKBridge() { return claudeSDKBridge; } // Claude SDK bridge for AI communication
            @Override public CodexSDKBridge getCodexSDKBridge() { return codexSDKBridge; }   // Codex SDK bridge for AI communication
            @Override public JPanel getMainPanel() { return mainPanel; }                     // Root UI panel for webview embedding
            @Override public HtmlLoader getHtmlLoader() { return htmlLoader; }               // HTML resource loader for webview content
            @Override public HandlerContext getHandlerContext() { return handlerContext; }    // Shared handler context (JS query, bridges, etc.)
            @Override public JBCefBrowser getBrowser() { return browser; }                   // Current JCEF browser instance
            @Override public void setBrowser(JBCefBrowser b) { browser = b; }                // Replace browser instance on recreate
            @Override public boolean isDisposed() { return disposed; }                       // Check if window has been disposed
            @Override public void handleJavaScriptMessage(String msg) { ClaudeChatWindow.this.handleJavaScriptMessage(msg); } // Route JS→Java messages
            @Override public WebviewWatchdog getWebviewWatchdog() { return webviewWatchdog; } // Watchdog for webview health monitoring
            @Override public void setFrontendReady(boolean ready) { frontendReady = ready; } // Mark frontend load state (reset on reload/recreate)
        };
    }

    private ChatWindowDelegate.DelegateHost createDelegateHost() {
        return new ChatWindowDelegate.DelegateHost() {
            // --- Read-only accessors ---
            @Override public Project getProject() { return project; }                       // Current IDEA project
            @Override public ClaudeSDKBridge getClaudeSDKBridge() { return claudeSDKBridge; } // Claude SDK bridge for AI communication
            @Override public CodexSDKBridge getCodexSDKBridge() { return codexSDKBridge; }   // Codex SDK bridge for AI communication
            @Override public ClaudeSession getSession() { return session; }                  // Active Claude session instance
            @Override public CodemossSettingsService getSettingsService() { return settingsService; } // Plugin settings (provider, API key, etc.)
            @Override public JPanel getMainPanel() { return mainPanel; }                     // Root UI panel
            @Override public JBCefBrowser getBrowser() { return browser; }                   // Current JCEF browser instance
            @Override public boolean isDisposed() { return disposed; }                       // Check if window has been disposed
            @Override public Content getParentContent() { return parentContent; }            // Tab content this window belongs to
            @Override public String getOriginalTabName() { return originalTabName; }         // Original tab name before any rename
            @Override public String getSessionId() { return sessionId; }                     // Unique session identifier

            // --- Handler context & wiring (initialized during startup) ---
            @Override public HandlerContext getHandlerContext() { return handlerContext; }    // Shared handler context (JS query, bridges, etc.)
            @Override public void setHandlerContext(HandlerContext ctx) { handlerContext = ctx; }       // Set by initializeHandlers()
            @Override public void setMessageDispatcher(MessageDispatcher d) { messageDispatcher = d; } // Set by initializeHandlers()
            @Override public void setPermissionHandler(PermissionHandler h) { permissionHandler = h; } // Set by initializeHandlers()
            @Override public void setHistoryHandler(HistoryHandler h) { historyHandler = h; }          // Set by initializeHandlers()

            // --- Session & stream management ---
            @Override public SessionLifecycleManager getSessionLifecycleManager() { return sessionLifecycleManager; } // Manages session start/stop lifecycle
            @Override public StreamMessageCoalescer getStreamCoalescer() { return streamCoalescer; }                  // Throttles webview stream updates
            @Override public WebviewWatchdog getWebviewWatchdog() { return webviewWatchdog; }                          // Watchdog for webview health monitoring
            @Override public PermissionHandler getPermissionHandler() { return permissionHandler; }                    // Lazy access — may be null before initializeHandlers()

            // --- Actions & callbacks ---
            @Override public void callJavaScript(String fn, String... args) { ClaudeChatWindow.this.callJavaScript(fn, args); } // Java→JS bridge call
            @Override public void interruptDueToPermissionDenial() { ClaudeChatWindow.this.interruptDueToPermissionDenial(); }  // Abort session on permission deny

            // --- Mutable state flags ---
            @Override public boolean isFrontendReady() { return frontendReady; }                       // Whether webview has finished loading
            @Override public void setFrontendReady(boolean ready) { frontendReady = ready; }           // Updated on load complete / reload
            @Override public void setSlashCommandsFetched(boolean fetched) { slashCommandsFetched = fetched; }       // Slash commands loaded from backend
            @Override public void setFetchedSlashCommandsCount(int count) { fetchedSlashCommandsCount = count; }     // Number of slash commands fetched
        };
    }
}
