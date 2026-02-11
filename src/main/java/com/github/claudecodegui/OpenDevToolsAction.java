package com.github.claudecodegui;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.BrowserUtil;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.popup.JBPopupFactory;
import com.intellij.openapi.ui.popup.ListPopup;
import com.intellij.openapi.ui.popup.PopupStep;
import com.intellij.openapi.ui.popup.util.BaseListPopupStep;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.*;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Action to open JCEF DevTools for the current chat window.
 * Supports both embedded DevTools window and Chrome remote debugging.
 */
public class OpenDevToolsAction extends AnAction {

    private static final Logger LOG = Logger.getInstance(OpenDevToolsAction.class);

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setEnabled(e.getProject() != null && JBCefApp.isSupported());
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }

        // Show popup menu with options
        List<DevToolsOption> options = List.of(
                new DevToolsOption("Open Embedded DevTools", this::openEmbeddedDevTools),
                new DevToolsOption("Open in Chrome DevTools", this::openChromeDevTools),
                new DevToolsOption("Copy Debug Info", this::copyDebugInfo)
        );

        ListPopup popup = JBPopupFactory.getInstance().createListPopup(
                new BaseListPopupStep<>("DevTools Options", options) {
                    @Override
                    public @NotNull String getTextFor(DevToolsOption value) {
                        return value.name;
                    }

                    @Override
                    public @Nullable PopupStep<?> onChosen(DevToolsOption selectedValue, boolean finalChoice) {
                        return doFinalStep(() -> selectedValue.action.accept(project));
                    }
                }
        );

        popup.showInFocusCenter();
    }

    /**
     * Open embedded DevTools window using JBCef's built-in method.
     */
    private void openEmbeddedDevTools(Project project) {
        JBCefBrowser browser = findBrowserInToolWindow(project);
        if (browser == null) {
            LOG.warn("[OpenDevToolsAction] No JBCefBrowser found in CCG tool window");
            showNotification(project, "No browser found in tool window", NotificationType.WARNING);
            return;
        }

        try {
            if (browser.getCefBrowser() != null) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    try {
                        browser.openDevtools();
                        LOG.info("[OpenDevToolsAction] Opened embedded DevTools");
                    } catch (Exception ex) {
                        LOG.error("[OpenDevToolsAction] Failed to open embedded DevTools", ex);
                        showNotification(project, "Failed to open DevTools: " + ex.getMessage(), NotificationType.ERROR);
                    }
                });
            }
        } catch (Exception ex) {
            LOG.error("[OpenDevToolsAction] Error accessing browser", ex);
        }
    }

    /**
     * Open Chrome DevTools by fetching the WebSocket debug URL from the remote debugging port.
     */
    private void openChromeDevTools(Project project) {
        try {
            JBCefApp.getInstance().getRemoteDebuggingPort(port -> {
                if (port == null || port <= 0) {
                    ApplicationManager.getApplication().invokeLater(() ->
                            showNotification(project,
                                    "Remote debugging port not available.\n" +
                                            "Set 'ide.browser.jcef.debug.port' in Registry (Help > Find Action > Registry)",
                                    NotificationType.WARNING));
                    return;
                }

                // Fetch targets from /json endpoint in background
                ApplicationManager.getApplication().executeOnPooledThread(() -> {
                    try {
                        String jsonUrl = "http://127.0.0.1:" + port + "/json";
                        String jsonResponse = fetchUrl(jsonUrl);

                        if (jsonResponse == null || jsonResponse.isEmpty()) {
                            ApplicationManager.getApplication().invokeLater(() ->
                                    showNotification(project, "No response from debug port " + port, NotificationType.ERROR));
                            return;
                        }

                        // Parse JSON to find the devtools URL
                        JsonArray targets = JsonParser.parseString(jsonResponse).getAsJsonArray();
                        String devtoolsUrl = null;

                        for (JsonElement element : targets) {
                            JsonObject target = element.getAsJsonObject();
                            // Look for our webview page
                            String targetUrl = target.has("url") ? target.get("url").getAsString() : "";
                            if (targetUrl.contains("webview") || targetUrl.contains("claude")) {
                                if (target.has("devtoolsFrontendUrl")) {
                                    devtoolsUrl = target.get("devtoolsFrontendUrl").getAsString();
                                    break;
                                }
                            }
                        }

                        // If not found, use the first available target
                        if (devtoolsUrl == null && !targets.isEmpty()) {
                            JsonObject firstTarget = targets.get(0).getAsJsonObject();
                            if (firstTarget.has("devtoolsFrontendUrl")) {
                                devtoolsUrl = firstTarget.get("devtoolsFrontendUrl").getAsString();
                            }
                        }

                        if (devtoolsUrl != null) {
                            // Convert to full URL if needed
                            String finalUrl = devtoolsUrl;
                            if (devtoolsUrl.startsWith("/")) {
                                finalUrl = "http://127.0.0.1:" + port + devtoolsUrl;
                            }
                            String urlToOpen = finalUrl;
                            LOG.info("[OpenDevToolsAction] Opening DevTools URL: " + urlToOpen);

                            ApplicationManager.getApplication().invokeLater(() -> BrowserUtil.browse(urlToOpen));
                        } else {
                            // Fallback: open the json list page
                            ApplicationManager.getApplication().invokeLater(() -> {
                                BrowserUtil.browse("http://127.0.0.1:" + port);
                                showNotification(project,
                                        "DevTools URL not found. Opening target list.\n" +
                                                "Click on 'inspect' link for any target.",
                                        NotificationType.INFORMATION);
                            });
                        }

                    } catch (Exception ex) {
                        LOG.error("[OpenDevToolsAction] Failed to fetch DevTools URL", ex);
                        ApplicationManager.getApplication().invokeLater(() ->
                                showNotification(project, "Failed to fetch DevTools URL: " + ex.getMessage(), NotificationType.ERROR));
                    }
                });
            });
        } catch (Exception ex) {
            LOG.error("[OpenDevToolsAction] Failed to get remote debugging port", ex);
            showNotification(project, "Failed to get remote debugging port: " + ex.getMessage(), NotificationType.ERROR);
        }
    }

    /**
     * Copy debug connection info to clipboard.
     */
    private void copyDebugInfo(Project project) {
        try {
            JBCefApp.getInstance().getRemoteDebuggingPort(port -> {
                if (port == null || port <= 0) {
                    ApplicationManager.getApplication().invokeLater(() ->
                            showNotification(project,
                                    "Remote debugging port not available.\n" +
                                            "Set 'ide.browser.jcef.debug.port' in Registry",
                                    NotificationType.WARNING));
                    return;
                }

                String debugInfo = String.format(
                        "JCEF Remote Debug Info:\n" +
                                "━━━━━━━━━━━━━━━━━━━━━━\n" +
                                "Port: %d\n" +
                                "Target List: http://127.0.0.1:%d/json\n" +
                                "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                                "To debug in Chrome:\n" +
                                "1. Open chrome://inspect\n" +
                                "2. Click 'Configure...' next to 'Discover network targets'\n" +
                                "3. Add: 127.0.0.1:%d\n" +
                                "4. Click 'inspect' on the target",
                        port, port, port
                );

                ApplicationManager.getApplication().invokeLater(() -> {
                    copyToClipboard(debugInfo);
                    showNotification(project, "Debug info copied to clipboard!\nPort: " + port, NotificationType.INFORMATION);
                });
                LOG.info("[OpenDevToolsAction] Copied debug info for port: " + port);
            });
        } catch (Exception ex) {
            LOG.error("[OpenDevToolsAction] Failed to copy debug info", ex);
        }
    }

    @Nullable
    private String fetchUrl(String urlString) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlString);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);

            if (conn.getResponseCode() == 200) {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    return reader.lines().collect(Collectors.joining("\n"));
                }
            }
        } catch (Exception e) {
            LOG.warn("[OpenDevToolsAction] Failed to fetch URL: " + urlString, e);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
        return null;
    }

    private void copyToClipboard(String text) {
        java.awt.datatransfer.StringSelection selection = new java.awt.datatransfer.StringSelection(text);
        java.awt.Toolkit.getDefaultToolkit().getSystemClipboard().setContents(selection, selection);
    }

    private void showNotification(Project project, String message, NotificationType type) {
        NotificationGroupManager.getInstance()
                .getNotificationGroup("Claude Code GUI Notifications")
                .createNotification(message, type)
                .notify(project);
    }

    @Nullable
    private JBCefBrowser findBrowserInToolWindow(Project project) {
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            return null;
        }

        Content selectedContent = toolWindow.getContentManager().getSelectedContent();
        if (selectedContent == null) {
            return null;
        }

        JComponent component = selectedContent.getComponent();
        return findBrowser(component);
    }

    @Nullable
    private JBCefBrowser findBrowser(Component component) {
        if (component instanceof JComponent) {
            Object browserInstance = ((JComponent) component).getClientProperty("JBCefBrowser.instance");
            if (browserInstance instanceof JBCefBrowser) {
                return (JBCefBrowser) browserInstance;
            }
        }

        if (component instanceof Container) {
            for (Component child : ((Container) component).getComponents()) {
                JBCefBrowser found = findBrowser(child);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /**
     * Helper class for popup menu options.
     */
    private static class DevToolsOption {
        final String name;
        final java.util.function.Consumer<Project> action;

        DevToolsOption(String name, java.util.function.Consumer<Project> action) {
            this.name = name;
            this.action = action;
        }
    }
}
