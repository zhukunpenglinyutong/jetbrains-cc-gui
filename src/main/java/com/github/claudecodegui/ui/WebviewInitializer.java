package com.github.claudecodegui.ui;

import com.github.claudecodegui.ClaudeCodeGuiBundle;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.util.FontConfigService;
import com.github.claudecodegui.util.HtmlLoader;
import com.github.claudecodegui.util.JBCefBrowserFactory;
import com.github.claudecodegui.util.LanguageConfigService;
import com.github.claudecodegui.util.ThemeConfigService;
import com.google.gson.JsonArray;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;
import com.intellij.ui.jcef.JBCefJSQuery;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;

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
import java.util.concurrent.CompletableFuture;

/**
 * Handles webview (JCEF browser) creation, configuration, error panels,
 * and webview lifecycle (reload, recreate, recovery).
 */
public class WebviewInitializer {

    private static final Logger LOG = Logger.getInstance(WebviewInitializer.class);
    private static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    /**
     * Host interface providing access to window-level dependencies.
     */
    public interface WebviewHost {
        Project getProject();
        ClaudeSDKBridge getClaudeSDKBridge();
        CodexSDKBridge getCodexSDKBridge();
        JPanel getMainPanel();
        HtmlLoader getHtmlLoader();
        HandlerContext getHandlerContext();
        JBCefBrowser getBrowser();
        void setBrowser(JBCefBrowser browser);
        boolean isDisposed();
        void handleJavaScriptMessage(String message);
        WebviewWatchdog getWebviewWatchdog();
        void setFrontendReady(boolean ready);
    }

    private final WebviewHost host;

    public WebviewInitializer(WebviewHost host) {
        this.host = host;
    }

    /**
     * If an ai-bridge directory exists under the project root, prefer using it.
     */
    public void overrideBridgePathIfAvailable() {
        try {
            String basePath = host.getProject().getBasePath();
            if (basePath == null) return;
            File bridgeDir = new File(basePath, "ai-bridge");
            File channelManager = new File(bridgeDir, "channel-manager.js");
            if (bridgeDir.exists() && bridgeDir.isDirectory() && channelManager.exists()) {
                host.getClaudeSDKBridge().setSdkTestDir(bridgeDir.getAbsolutePath());
                LOG.info("Overriding ai-bridge path to project directory: " + bridgeDir.getAbsolutePath());
            } else {
                LOG.info("Project ai-bridge not found, using default resolver");
            }
        } catch (Exception e) {
            LOG.warn("Failed to override bridge path: " + e.getMessage());
        }
    }

    /**
     * Create and configure UI components (browser, JS bridge, drag-and-drop).
     */
    public void createUIComponents() {
        JPanel mainPanel = host.getMainPanel();

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

        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();

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
                claudeSDKBridge.verifyAndCacheNodePath(nodeResult.getNodePath());
            }
        }

        if (!claudeSDKBridge.checkEnvironment()) {
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

            if (sharedResolver.isExtractionComplete()) {
                LOG.info("[ClaudeSDKToolWindow] checkEnvironment failed but extraction just completed, retrying initialization with exponential backoff...");
                retryCheckEnvironmentWithBackoff(0);
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
            JBCefBrowser browser = JBCefBrowserFactory.create();
            host.setBrowser(browser);
            host.getHandlerContext().setBrowser(browser);

            JBCefBrowserBase browserBase = browser;
            JBCefJSQuery jsQuery = JBCefJSQuery.create(browserBase);
            jsQuery.addHandler((msg) -> {
                host.handleJavaScriptMessage(msg);
                return new JBCefJSQuery.Response("ok");
            });

            // Create a dedicated JSQuery for getting clipboard file paths
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

            HtmlLoader htmlLoader = host.getHtmlLoader();
            String htmlContent = htmlLoader.loadChatHtml();

            browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
                @Override
                public void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
                    LOG.debug("onLoadEnd called, isMain=" + frame.isMain() + ", url=" + cefBrowser.getURL());

                    if (!frame.isMain()) {
                        return;
                    }

                    String injection = "window.sendToJava = function(msg) { " + jsQuery.inject("msg") + " };";
                    cefBrowser.executeJavaScript(injection, cefBrowser.getURL(), 0);

                    // Inject clipboard path retrieval function
                    String clipboardPathInjection =
                        "window.getClipboardFilePath = function() {" +
                        "  return new Promise((resolve) => {" +
                        "    " + getClipboardPathQuery.inject("''",
                            "function(response) { resolve(response); }",
                            "function(error_code, error_message) { console.error('Failed to get clipboard path:', error_message); resolve(''); }") +
                        "  });" +
                        "};";
                    cefBrowser.executeJavaScript(clipboardPathInjection, cefBrowser.getURL(), 0);

                    // Forward console logs to IDEA console
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

                    // Pass IDEA editor font configuration to the frontend
                    String fontConfig = FontConfigService.getEditorFontConfigJson();
                    LOG.info("[FontSync] Retrieved font config: " + fontConfig);
                    String fontConfigInjection = String.format(
                        "if (window.applyIdeaFontConfig) { window.applyIdeaFontConfig(%s); } " +
                        "else { window.__pendingFontConfig = %s; }",
                        fontConfig, fontConfig
                    );
                    cefBrowser.executeJavaScript(fontConfigInjection, cefBrowser.getURL(), 0);
                    LOG.info("[FontSync] Font config injected into frontend");

                    // Pass IDEA language configuration to the frontend
                    String languageConfig = LanguageConfigService.getLanguageConfigJson();
                    LOG.info("[LanguageSync] Retrieved language config: " + languageConfig);
                    String languageConfigInjection = String.format(
                        "if (window.applyIdeaLanguageConfig) { window.applyIdeaLanguageConfig(%s); } " +
                        "else { window.__pendingLanguageConfig = %s; }",
                        languageConfig, languageConfig
                    );
                    cefBrowser.executeJavaScript(languageConfigInjection, cefBrowser.getURL(), 0);
                    LOG.info("[LanguageSync] Language config injected into frontend");

                    LOG.debug("onLoadEnd completed, waiting for frontend_ready signal");
                }
            }, browser.getCefBrowser());

            browser.loadHTML(htmlContent);

            // Reset webview health markers and start watchdog once the browser is created.
            host.getWebviewWatchdog().resetTimestamps();
            host.getWebviewWatchdog().start();

            JComponent browserComponent = browser.getComponent();

            // Set webview container background color to prevent white flash before HTML loads.
            browserComponent.setBackground(ThemeConfigService.getBackgroundColor());

            // Add drag-and-drop support - get full file paths
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
                                JsonArray jsonArray = new JsonArray();
                                for (File file : files) {
                                    jsonArray.add(file.getAbsolutePath());
                                }

                                LOG.debug("Dropped " + files.size() + " file(s)");

                                String jsCode = String.format(
                                    "if (window.handleFilePathFromJava) { window.handleFilePathFromJava(%s); }",
                                    jsonArray.toString()
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
            if (e.getMessage() != null && e.getMessage().contains("JCEF")) {
                LOG.error("JCEF initialization failed: " + e.getMessage(), e);
                showJcefNotSupportedPanel();
            } else {
                LOG.error("Failed to create UI components: " + e.getMessage(), e);
                showErrorPanel();
            }
        } catch (NullPointerException e) {
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

    public void showErrorPanel() {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        String message = "\u65e0\u6cd5\u627e\u5230 Node.js\uff08\u4e0b\u65b9\u4fdd\u5b58\u540e\u8bf7\u91cd\u542f\u5c1d\u8bd5\uff09\n\n" +
            "\u8bf7\u786e\u4fdd\uff1a\n" +
            "\u2022 Node.js \u5df2\u5b89\u88c5 (\u53ef\u4ee5\u5728\u7ec8\u7aef\u8fd0\u884c: node --version)\n\n" +
            "\u5982\u679c\u81ea\u52a8\u68c0\u6d4b Node.js \u5931\u8d25\uff0c\u53ef\u4ee5\u5728\u7ec8\u7aef\u8fd0\u884c\u4ee5\u4e0b\u547d\u4ee4\u83b7\u53d6 Node.js \u8def\u5f84\uff1a\n" +
            "    node -p \"process.execPath\"\n\n" +
            "\u5f53\u524d\u68c0\u6d4b\u5230\u7684 Node.js \u8def\u5f84: " + claudeSDKBridge.getNodeExecutable();

        JPanel errorPanel = ErrorPanelBuilder.build(
            "\u73af\u5883\u68c0\u67e5\u5931\u8d25",
            message,
            claudeSDKBridge.getNodeExecutable(),
            this::handleNodePathSave
        );
        host.getMainPanel().add(errorPanel, BorderLayout.CENTER);
    }

    private void showVersionErrorPanel(String currentVersion) {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        int minVersion = NodeDetector.MIN_NODE_MAJOR_VERSION;
        String message = "Node.js \u7248\u672c\u8fc7\u4f4e\n\n" +
            "\u5f53\u524d\u7248\u672c: " + currentVersion + "\n" +
            "\u6700\u4f4e\u8981\u6c42: v" + minVersion + "\n\n" +
            "\u8bf7\u5347\u7ea7 Node.js \u5230 v" + minVersion + " \u6216\u66f4\u9ad8\u7248\u672c\u540e\u91cd\u8bd5\u3002\n\n" +
            "\u5f53\u524d\u68c0\u6d4b\u5230\u7684 Node.js \u8def\u5f84: " + claudeSDKBridge.getNodeExecutable();

        JPanel errorPanel = ErrorPanelBuilder.build(
            "Node.js \u7248\u672c\u4e0d\u6ee1\u8db3\u8981\u6c42",
            message,
            claudeSDKBridge.getNodeExecutable(),
            this::handleNodePathSave
        );
        host.getMainPanel().add(errorPanel, BorderLayout.CENTER);
    }

    private void showInvalidNodePathPanel(String path, String errMsg) {
        String message = "\u4fdd\u5b58\u7684 Node.js \u8def\u5f84\u4e0d\u53ef\u7528: " + path + "\n\n" +
            (errMsg != null ? errMsg + "\n\n" : "") +
            "\u8bf7\u5728\u4e0b\u65b9\u91cd\u65b0\u4fdd\u5b58\u6b63\u786e\u7684 Node.js \u8def\u5f84\u3002";

        JPanel errorPanel = ErrorPanelBuilder.build(
            "Node.js \u8def\u5f84\u4e0d\u53ef\u7528",
            message,
            path,
            this::handleNodePathSave
        );
        host.getMainPanel().add(errorPanel, BorderLayout.CENTER);
    }

    private void showJcefNotSupportedPanel() {
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
            "\u26A0\uFE0F",
            ClaudeCodeGuiBundle.message("toolwindow.jcefNotInstalled"),
            ClaudeCodeGuiBundle.message("toolwindow.jcefNotInstalledSolution")
        );
        host.getMainPanel().add(panel, BorderLayout.CENTER);
    }

    private void showJcefRemoteModeErrorPanel() {
        JPanel panel = ErrorPanelBuilder.buildCenteredPanel(
            "\u26A0\uFE0F",
            ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteError"),
            ClaudeCodeGuiBundle.message("toolwindow.jcefRemoteSolution")
        );
        host.getMainPanel().add(panel, BorderLayout.CENTER);
    }

    private void showLoadingPanel() {
        JPanel panel = ErrorPanelBuilder.buildLoadingPanel(
            "\u23F3",
            ClaudeCodeGuiBundle.message("toolwindow.extractingTitle"),
            ClaudeCodeGuiBundle.message("toolwindow.extractingDesc")
        );
        host.getMainPanel().add(panel, BorderLayout.CENTER);
        LOG.info("[ClaudeSDKToolWindow] Showing loading panel while bridge extracts...");
    }

    /**
     * Reinitialize UI after bridge extraction completes.
     */
    private void reinitializeAfterExtraction() {
        ApplicationManager.getApplication().invokeLater(() -> {
            LOG.info("[ClaudeSDKToolWindow] Bridge extraction complete, reinitializing UI...");
            JPanel mainPanel = host.getMainPanel();
            mainPanel.removeAll();
            createUIComponents();
            mainPanel.revalidate();
            mainPanel.repaint();
        });
    }

    /**
     * Retry environment check with exponential backoff strategy.
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
                if (host.getClaudeSDKBridge().checkEnvironment()) {
                    LOG.info("[ClaudeSDKToolWindow] Retry attempt " + (attempt + 1) + " succeeded after extraction completion");
                    reinitializeAfterExtraction();
                } else {
                    retryCheckEnvironmentWithBackoff(attempt + 1);
                }
            });
        });
    }

    /**
     * Handle Node.js path save from the error panel input.
     */
    public void handleNodePathSave(String manualPath) {
        ClaudeSDKBridge claudeSDKBridge = host.getClaudeSDKBridge();
        CodexSDKBridge codexSDKBridge = host.getCodexSDKBridge();
        JPanel mainPanel = host.getMainPanel();

        try {
            PropertiesComponent props = PropertiesComponent.getInstance();

            if (manualPath == null || manualPath.isEmpty()) {
                props.unsetValue(NODE_PATH_PROPERTY_KEY);
                claudeSDKBridge.setNodeExecutable(null);
                codexSDKBridge.setNodeExecutable(null);
                LOG.info("Cleared manual Node.js path");
            } else {
                props.setValue(NODE_PATH_PROPERTY_KEY, manualPath);
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
                "\u4fdd\u5b58\u6216\u5e94\u7528 Node.js \u8def\u5f84\u65f6\u51fa\u9519: " + ex.getMessage(),
                "\u9519\u8bef", JOptionPane.ERROR_MESSAGE);
        }
    }

    /**
     * Reload the webview HTML content.
     */
    public void reloadWebview(String reason) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (host.isDisposed()) return;
            JBCefBrowser browser = host.getBrowser();
            if (browser == null) {
                recreateWebview(reason + "_no_browser");
                return;
            }
            host.setFrontendReady(false);
            try {
                browser.loadHTML(host.getHtmlLoader().loadChatHtml());
                host.getMainPanel().revalidate();
                host.getMainPanel().repaint();
            } catch (Exception e) {
                LOG.warn("[WebviewWatchdog] Reload failed: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Recreate the webview from scratch (dispose old, create new).
     */
    public void recreateWebview(String reason) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (host.isDisposed()) return;

            host.setFrontendReady(false);
            JPanel mainPanel = host.getMainPanel();
            JBCefBrowser browser = host.getBrowser();
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
                    host.setBrowser(null);
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
}
