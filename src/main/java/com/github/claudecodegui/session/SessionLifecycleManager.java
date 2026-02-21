package com.github.claudecodegui.session;

import com.github.claudecodegui.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.CodemossSettingsService;
import com.github.claudecodegui.handler.HandlerContext;
import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;

import java.io.File;
import java.util.concurrent.CompletableFuture;

/**
 * Manages session lifecycle operations: creation, history loading,
 * working directory resolution, slash commands, and permission mode sync.
 */
public class SessionLifecycleManager {

    private static final Logger LOG = Logger.getInstance(SessionLifecycleManager.class);
    private static final String PERMISSION_MODE_PROPERTY_KEY = "claude.code.permission.mode";

    /**
     * Host interface providing access to window-level dependencies.
     */
    public interface SessionHost {
        Project getProject();
        ClaudeSDKBridge getClaudeSDKBridge();
        CodexSDKBridge getCodexSDKBridge();
        ClaudeSession getSession();
        void setSession(ClaudeSession session);
        HandlerContext getHandlerContext();
        StreamMessageCoalescer getStreamCoalescer();
        void clearPendingPermissionRequests();
        void callJavaScript(String functionName, String... args);
        boolean isDisposed();
        JBCefBrowser getBrowser();
        void setupSessionCallbacks();
        void setSlashCommandsFetched(boolean fetched);
        void setFetchedSlashCommandsCount(int count);
    }

    private final SessionHost host;

    public SessionLifecycleManager(SessionHost host) {
        this.host = host;
    }

    /**
     * Create a new session, interrupting the old one first.
     */
    public void createNewSession() {
        LOG.info("Creating new session...");

        ClaudeSession oldSession = host.getSession();
        String previousPermissionMode = (oldSession != null) ? oldSession.getPermissionMode() : "bypassPermissions";
        String previousProvider = (oldSession != null) ? oldSession.getProvider() : "claude";
        String previousModel = (oldSession != null) ? oldSession.getModel() : "claude-sonnet-4-6";
        LOG.info("Preserving session state: mode=" + previousPermissionMode
            + ", provider=" + previousProvider + ", model=" + previousModel);

        host.callJavaScript("clearMessages");

        CompletableFuture<Void> interruptFuture = oldSession != null
            ? oldSession.interrupt()
            : CompletableFuture.completedFuture(null);

        interruptFuture.thenRun(() -> {
            LOG.info("Old session interrupted, creating new session");

            host.getStreamCoalescer().resetStreamState();
            ApplicationManager.getApplication().invokeLater(() -> {
                host.callJavaScript("onStreamEnd");
                host.callJavaScript("showLoading", "false");
            });

            host.clearPendingPermissionRequests();

            ClaudeSession newSession = new ClaudeSession(
                host.getProject(), host.getClaudeSDKBridge(), host.getCodexSDKBridge());
            newSession.setPermissionMode(previousPermissionMode);
            newSession.setProvider(previousProvider);
            newSession.setModel(previousModel);
            LOG.info("Restored session state to new session: mode=" + previousPermissionMode
                + ", provider=" + previousProvider + ", model=" + previousModel);

            host.setSession(newSession);
            host.getHandlerContext().setSession(newSession);
            host.setupSessionCallbacks();

            String workingDirectory = determineWorkingDirectory();
            newSession.setSessionInfo(null, workingDirectory);
            LOG.info("New session created successfully, working directory: " + workingDirectory);

            ApplicationManager.getApplication().invokeLater(() -> {
                host.callJavaScript("updateStatus",
                    JsUtils.escapeJs(ClaudeCodeGuiBundle.message("toast.newSessionCreatedReady")));
                resetTokenUsage();
            });
        }).exceptionally(ex -> {
            LOG.error("Failed to create new session: " + ex.getMessage(), ex);
            ApplicationManager.getApplication().invokeLater(() -> {
                host.callJavaScript("updateStatus",
                    JsUtils.escapeJs("Failed to create new session: " + ex.getMessage()));
            });
            return null;
        });
    }

    /**
     * Load a history session by ID.
     */
    public void loadHistorySession(String sessionId, String projectPath) {
        LOG.info("Loading history session: " + sessionId + " from project: " + projectPath);

        ClaudeSession oldSession = host.getSession();
        String previousPermissionMode;
        String previousProvider;
        String previousModel;

        if (oldSession != null) {
            previousPermissionMode = oldSession.getPermissionMode();
            previousProvider = oldSession.getProvider();
            previousModel = oldSession.getModel();
        } else {
            PropertiesComponent props = PropertiesComponent.getInstance();
            String savedMode = props.getValue(PERMISSION_MODE_PROPERTY_KEY);
            previousPermissionMode = (savedMode != null && !savedMode.trim().isEmpty())
                ? savedMode.trim() : "bypassPermissions";
            previousProvider = "claude";
            previousModel = "claude-sonnet-4-6";
        }
        LOG.info("Preserving session state when loading history: mode=" + previousPermissionMode
            + ", provider=" + previousProvider + ", model=" + previousModel);

        host.callJavaScript("clearMessages");
        host.clearPendingPermissionRequests();

        ClaudeSession newSession = new ClaudeSession(
            host.getProject(), host.getClaudeSDKBridge(), host.getCodexSDKBridge());
        newSession.setPermissionMode(previousPermissionMode);
        newSession.setProvider(previousProvider);
        newSession.setModel(previousModel);
        LOG.info("Restored session state to loaded session: mode=" + previousPermissionMode
            + ", provider=" + previousProvider + ", model=" + previousModel);

        host.setSession(newSession);
        host.getHandlerContext().setSession(newSession);
        host.setupSessionCallbacks();

        String workingDir = (projectPath != null && new File(projectPath).exists())
            ? projectPath : determineWorkingDirectory();
        newSession.setSessionInfo(sessionId, workingDir);

        newSession.loadFromServer().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
            host.callJavaScript("historyLoadComplete");
        })).exceptionally(ex -> {
            ApplicationManager.getApplication().invokeLater(() ->
                host.callJavaScript("addErrorMessage",
                    JsUtils.escapeJs("Failed to load session: " + ex.getMessage())));
            return null;
        });
    }

    /**
     * Determine the working directory for the session.
     */
    public String determineWorkingDirectory() {
        String projectPath = host.getProject().getBasePath();

        if (projectPath == null || !new File(projectPath).exists()) {
            String userHome = System.getProperty("user.home");
            LOG.warn("Using user home directory as fallback: " + userHome);
            return userHome;
        }

        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            String customWorkingDir = settingsService.getCustomWorkingDirectory(projectPath);

            if (customWorkingDir != null && !customWorkingDir.isEmpty()) {
                File workingDirFile = new File(customWorkingDir);
                if (!workingDirFile.isAbsolute()) {
                    workingDirFile = new File(projectPath, customWorkingDir);
                }
                if (workingDirFile.exists() && workingDirFile.isDirectory()) {
                    String resolvedPath = workingDirFile.getAbsolutePath();
                    LOG.info("Using custom working directory: " + resolvedPath);
                    return resolvedPath;
                } else {
                    LOG.warn("Custom working directory does not exist: "
                        + workingDirFile.getAbsolutePath() + ", falling back to project root");
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to read custom working directory: " + e.getMessage());
        }

        return projectPath;
    }

    /**
     * Fetch slash commands from the SDK.
     */
    public void fetchSlashCommandsOnStartup() {
        ClaudeSession currentSession = host.getSession();
        String cwd = currentSession != null ? currentSession.getCwd() : null;
        if (cwd == null) {
            cwd = host.getProject().getBasePath();
        }

        LOG.info("Fetching slash commands from SDK, cwd=" + cwd);

        host.getClaudeSDKBridge().getSlashCommands(cwd).thenAccept(commands -> {
            host.setFetchedSlashCommandsCount(commands.size());
            host.setSlashCommandsFetched(true);
            LOG.info("Slash commands fetched from SDK: " + commands.size() + " commands");

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    String commandsJson = new Gson().toJson(commands);
                    LOG.debug("Calling updateSlashCommands with JSON length=" + commandsJson.length());
                    host.callJavaScript("updateSlashCommands", JsUtils.escapeJs(commandsJson));
                } catch (Exception e) {
                    LOG.warn("Failed to send slash commands to frontend: " + e.getMessage(), e);
                }
            });
        }).exceptionally(e -> {
            LOG.warn("Failed to fetch slash commands from SDK: " + e.getMessage(), e);
            return null;
        });
    }

    /**
     * Send current permission mode to the frontend.
     */
    public void sendCurrentPermissionMode() {
        try {
            String currentMode = "bypassPermissions";

            ClaudeSession currentSession = host.getSession();
            if (currentSession != null) {
                String sessionMode = currentSession.getPermissionMode();
                if (sessionMode != null && !sessionMode.trim().isEmpty()) {
                    currentMode = sessionMode;
                }
            }

            final String modeToSend = currentMode;

            ApplicationManager.getApplication().invokeLater(() -> {
                if (!host.isDisposed() && host.getBrowser() != null) {
                    host.callJavaScript("window.onModeReceived", JsUtils.escapeJs(modeToSend));
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to send current permission mode: " + e.getMessage(), e);
        }
    }

    /**
     * Reset token usage statistics in the frontend (used after new session creation).
     */
    private void resetTokenUsage() {
        int maxTokens = SettingsHandler.getModelContextLimit(host.getHandlerContext().getCurrentModel());
        JsonObject usageUpdate = new JsonObject();
        usageUpdate.addProperty("percentage", 0);
        usageUpdate.addProperty("totalTokens", 0);
        usageUpdate.addProperty("limit", maxTokens);
        usageUpdate.addProperty("usedTokens", 0);
        usageUpdate.addProperty("maxTokens", maxTokens);

        String usageJson = new Gson().toJson(usageUpdate);

        JBCefBrowser browser = host.getBrowser();
        if (browser != null && !host.isDisposed()) {
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
    }
}
