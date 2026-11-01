package com.github.claudecodegui.session;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.model.SessionTemplate;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.handler.UsagePushService;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.skill.SlashCommandRegistry;
import com.github.claudecodegui.util.JsUtils;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.ui.jcef.JBCefBrowser;

import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.function.LongConsumer;

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

        default com.github.claudecodegui.provider.grok.GrokSDKBridge getGrokSDKBridge() {
            return null;
        }

        default com.github.claudecodegui.provider.zcode.ZcodeSDKBridge getZcodeSDKBridge() {
            return null;
        }

        Map<String, MarkerCliBridge> getCliBridges();

        ClaudeSession getSession();

        void setSession(ClaudeSession session);

        HandlerContext getHandlerContext();

        StreamMessageCoalescer getStreamCoalescer();

        void clearPendingPermissionRequests();

        void clearPermissionDecisionMemory();

        void callJavaScript(String functionName, String... args);

        boolean isDisposed();

        JBCefBrowser getBrowser();

        void setupSessionCallbacks();

        void invalidateSessionCallbacks();

        /** Cancel pending history reads without invalidating the currently displayed session. */
        default void invalidatePendingHistoryLoads() { }

        void setSlashCommandsFetched(boolean fetched);

        void setFetchedSlashCommandsCount(int count);
    }

    private final SessionHost host;
    private final Object transitionLock = new Object();
    private long transitionGeneration;

    private record Transition(long generation, String token, ClaudeSession previous) { }

    public SessionLifecycleManager(SessionHost host) {
        this.host = host;
    }

    /**
     * Create a new session, interrupting the old one first.
     */
    public void createNewSession() {
        createNewSession(null);
    }

    /** Starts a frontend-correlated transition, or creates a token for an IDE action. */
    public void createNewSession(String transitionToken) {
        createNewSession(transitionToken, null);
    }

    /** Applies a requested provider only after the old session has safely retired. */
    public void createNewSession(String transitionToken, String targetProvider) {
        LOG.info("Creating new session...");

        Transition transition = beginTransition(transitionToken, "");
        ClaudeSession oldSession = transition.previous();
        ClaudeSession defaultSession = createDefaultSession();
        String previousPermissionMode = (oldSession != null) ? oldSession.getPermissionMode() : defaultSession.getPermissionMode();
        String previousProvider = (oldSession != null) ? oldSession.getProvider() : defaultSession.getProvider();
        String previousModel = (oldSession != null) ? oldSession.getModel() : defaultSession.getModel();
        String previousEffort = oldSession != null ? oldSession.getReasoningEffort() : null;
        boolean previousUltracode = oldSession != null && oldSession.isClaudeUltracode();
        LOG.info("Preserving session state: mode=" + previousPermissionMode
                         + ", provider=" + previousProvider + ", model=" + previousModel);

        CompletableFuture<Void> interruptFuture = interruptTransition(transition);

        interruptFuture.thenCompose(ignored -> this.releaseTransitionResources(transition, "new session"))
                .thenRun(() -> commitTransition(transition, clearBarrierSeq -> {
            LOG.info("Old session interrupted, creating new session");

            ClaudeSession newSession = createDefaultSession();
            newSession.setPermissionMode(previousPermissionMode);
            newSession.setProvider(targetProvider != null && !targetProvider.isBlank() ? targetProvider : previousProvider);
            // Verbatim copy: the live value was already sanitized when set (migrated
            // on restore, or an explicit custom id via set_model), so re-migrating
            // here could only rewrite a user's custom model behind their back.
            newSession.setModelVerbatim(previousModel);
            newSession.setReasoningEffort(previousEffort);
            newSession.setClaudeUltracode(previousUltracode);
            LOG.info("Restored session state to new session: mode=" + previousPermissionMode
                             + ", provider=" + previousProvider + ", model=" + previousModel);

            completeNewSessionBootstrap(newSession, determineWorkingDirectory(),
                    "New session created successfully, working directory: ", transition, clearBarrierSeq);
        })).exceptionally(ex -> {
            LOG.warn("Failed to create new session: " + ex.getMessage(), ex);
            reportTransitionFailure(transition, "Failed to create new session: " + ex.getMessage());
            return null;
        });
    }

    /**
     * Create a new session from a template, interrupting the old one first.
     */
    public void createNewSessionFromTemplate(SessionTemplate template) {
        createNewSessionFromTemplate(template, null);
    }

    /** Starts a template transition with the same acceptance and cancellation fences. */
    public void createNewSessionFromTemplate(SessionTemplate template, String transitionToken) {
        LOG.info("Creating new session from template: " + template.getName());

        Transition transition = beginTransition(transitionToken, "");
        ClaudeSession oldSession = transition.previous();

        CompletableFuture<Void> interruptFuture = interruptTransition(transition);

        interruptFuture.thenCompose(ignored -> this.releaseTransitionResources(transition, "new session from template"))
                .thenRun(() -> commitTransition(transition, clearBarrierSeq -> {
            LOG.info("Old session interrupted, creating new session from template");

            ClaudeSession newSession = createDefaultSession();

            // Apply template settings
            if (template.getPermissionMode() != null) {
                newSession.setPermissionMode(template.getPermissionMode());
            }
            if (template.getProvider() != null) {
                newSession.setProvider(template.getProvider());
            }
            if (template.getModel() != null) {
                // Templates hold an explicit user choice (possibly a custom model id),
                // so keep it verbatim like any other explicit selection.
                newSession.setModelVerbatim(template.getModel());
            }
            if (template.getReasoningEffort() != null) {
                newSession.setReasoningEffort(template.getReasoningEffort());
            }
            newSession.setClaudeUltracode(template.isClaudeUltracode());
            newSession.getState().setPsiContextEnabled(template.isPsiContextEnabled());

            LOG.info("Applied template settings to new session: provider=" + template.getProvider()
                    + ", model=" + template.getModel() + ", mode=" + template.getPermissionMode());

            String workingDirectory = template.getCwd() != null && !template.getCwd().trim().isEmpty()
                    ? template.getCwd() : determineWorkingDirectory();
            completeNewSessionBootstrap(newSession, workingDirectory,
                    "New session created from template successfully, working directory: ", transition, clearBarrierSeq);
        })).exceptionally(ex -> {
            LOG.warn("Failed to create new session from template: " + ex.getMessage(), ex);
            reportTransitionFailure(transition, "Failed to create new session from template: " + ex.getMessage());
            return null;
        });
    }

    /**
     * Load a history session by ID.
     */
    public void loadHistorySession(String sessionId, String projectPath) {
        loadHistorySession(sessionId, projectPath, null, null);
    }

    /**
     * Load a history session by ID and provider.
     */
    public void loadHistorySession(String sessionId, String projectPath, String provider) {
        loadHistorySession(sessionId, projectPath, provider, null);
    }

    /**
     * Load a history session by ID, provider, and optional model from the history row.
     *
     * @param model when non-blank, restores that model instead of keeping the previous UI selection
     */
    public void loadHistorySession(String sessionId, String projectPath, String provider, String model) {
        loadHistorySession(sessionId, projectPath, provider, model, null);
    }

    /** Correlates a history selection with its frontend transition token. */
    public void loadHistorySession(String sessionId, String projectPath, String provider, String model, String transitionToken) {
        LOG.info("Loading history session: " + sessionId + " from project: " + projectPath);

        Transition transition = beginTransition(transitionToken, sessionId);
        ClaudeSession oldSession = transition.previous();
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
            ClaudeSession defaultSession = createDefaultSession();
            previousPermissionMode = (savedMode != null && !savedMode.trim().isEmpty())
                                             ? savedMode.trim() : defaultSession.getPermissionMode();
            previousProvider = defaultSession.getProvider();
            previousModel = defaultSession.getModel();
        }
        String modelToRestore = (model != null && !model.trim().isEmpty()) ? model.trim() : previousModel;
        LOG.info("Preserving session state when loading history: mode=" + previousPermissionMode
                         + ", provider=" + previousProvider + ", model=" + modelToRestore
                         + (model != null && !model.trim().isEmpty() ? " (from history)" : " (previous)"));

        CompletableFuture<Void> interruptFuture = interruptTransition(transition);

        interruptFuture.thenCompose(ignored -> this.releaseTransitionResources(transition, "history load"))
                .thenRun(() -> commitTransition(transition, clearBarrierSeq -> {
            host.clearPendingPermissionRequests();
            host.clearPermissionDecisionMemory();

            ClaudeSession newSession = createDefaultSession();
            newSession.setPermissionMode(previousPermissionMode);
            newSession.setProvider(provider != null && !provider.trim().isEmpty() ? provider : previousProvider);
            // Verbatim: a payload model comes from the webview, which is the authority
            // on custom ids and already applied retired-id migration where it is safe;
            // a fallback previousModel is a live value that was sanitized when set.
            newSession.setModelVerbatim(modelToRestore);
            if (oldSession != null) {
                newSession.setReasoningEffort(oldSession.getReasoningEffort());
                newSession.setClaudeUltracode(oldSession.isClaudeUltracode());
            }
            LOG.info("Restored session state to loaded session: mode=" + previousPermissionMode
                             + ", provider=" + newSession.getProvider() + ", model=" + modelToRestore);

            host.setSession(newSession);
            host.getHandlerContext().setSession(newSession);
            host.setupSessionCallbacks();
            acceptTransition(transition, clearBarrierSeq);

            String workingDir = (projectPath != null && !projectPath.isEmpty())
                                    ? projectPath : NodeDetector.convertToWslPath(determineWorkingDirectory());
            newSession.setSessionInfo(sessionId, workingDir, transition.token());

            newSession.loadFromServer().thenRun(() -> ApplicationManager.getApplication().invokeLater(() -> {
                // loadFromServer only enqueues updateMessages through the coalescer; if we
                // call historyLoadComplete immediately the frontend releases the transition
                // guard before the snapshot arrives (or a reordered clearMessages can wipe a
                // stashed snapshot). Flush the coalescer first so messages land before complete.
                completeHistoryLoadAfterCoalescerFlush(newSession, transition);
            })).exceptionally(ex -> {
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (!isCurrentTransition(transition) || host.getSession() != newSession) { return; }
                    // Release the accepted transition without reviving a superseded selection.
                    host.callJavaScript("sessionTransitionFailed",
                            JsUtils.escapeJs("Failed to load session: " + ex.getMessage()), JsUtils.escapeJs(transition.token()));
                });
                return null;
            });
        })).exceptionally(ex -> {
            LOG.warn("Failed to load history session: " + ex.getMessage(), ex);
            reportTransitionFailure(transition, "Failed to load session: " + ex.getMessage());
            return null;
        });
    }

    private Transition beginTransition(String requestedToken, String targetSessionId) {
        synchronized (transitionLock) {
            String token = requestedToken == null || requestedToken.isBlank()
                    ? "backend:" + java.util.UUID.randomUUID() : requestedToken;
            Transition transition = new Transition(++transitionGeneration, token, host.getSession());
            host.invalidatePendingHistoryLoads();
            host.callJavaScript("sessionTransitionStarted", JsUtils.escapeJs(targetSessionId), "", JsUtils.escapeJs(token));
            return transition;
        }
    }

    /** A provider-specific history loader supersedes any pending session replacement. */
    public void invalidatePendingTransition() {
        synchronized (transitionLock) {
            transitionGeneration++;
        }
    }

    private boolean isCurrentTransition(Transition transition) {
        synchronized (transitionLock) {
            return transition.generation() == transitionGeneration && !host.isDisposed();
        }
    }

    private CompletableFuture<Void> interruptTransition(Transition transition) {
        synchronized (transitionLock) {
            return isCurrentTransition(transition) && transition.previous() != null
                    ? transition.previous().interrupt() : CompletableFuture.completedFuture(null);
        }
    }

    private CompletableFuture<Void> releaseTransitionResources(Transition transition, String reason) {
        synchronized (transitionLock) {
            if (!isCurrentTransition(transition) || host.getSession() != transition.previous()) {
                return CompletableFuture.completedFuture(null);
            }
            return releasePersistentProviderResources(transition.previous(), reason);
        }
    }

    private void commitTransition(Transition transition, LongConsumer replacement) {
        synchronized (transitionLock) {
            if (!isCurrentTransition(transition) || host.getSession() != transition.previous()) {
                return;
            }
            host.invalidateSessionCallbacks();
            long clearBarrierSeq = host.getStreamCoalescer().resetStreamState();
            replacement.accept(clearBarrierSeq);
        }
    }

    /** The frontend may immediately send settings from this acknowledgement. Bind the replacement first. */
    private void acceptTransition(Transition transition, long clearBarrierSeq) {
        host.callJavaScript("clearMessages", String.valueOf(clearBarrierSeq), JsUtils.escapeJs(transition.token()));
    }

    /** Release a refused transition with a fresh old-session snapshot, without discarding its binding. */
    private void reportTransitionFailure(Transition transition, String error) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (!isCurrentTransition(transition)) {
                return;
            }
            ClaudeSession oldSession = transition.previous();
            String escapedError = JsUtils.escapeJs(error);
            if (host.getSession() != oldSession) {
                // Bootstrap failed after acceptance; the old session no longer owns this page.
                host.callJavaScript("sessionTransitionFailed", escapedError, JsUtils.escapeJs(transition.token()));
                return;
            }
            LongConsumer failed = seq -> {
                if (isCurrentTransition(transition) && host.getSession() == oldSession) {
                    host.callJavaScript("sessionTransitionFailed", escapedError, JsUtils.escapeJs(transition.token()));
                }
            };
            StreamMessageCoalescer coalescer = host.getStreamCoalescer();
            if (oldSession != null && coalescer != null) {
                synchronized (oldSession.getState().getMessageStateLock()) {
                    coalescer.flush(oldSession.getMessages(), failed);
                }
            } else {
                failed.accept(0);
            }
        });
    }

    /**
     * Push any pending coalesced message snapshot to the webview, then signal
     * {@code historyLoadComplete} with the message count. Ensures the transcript
     * is not lost when the frontend holds {@code __sessionTransitioning} until complete.
     */
    private void completeHistoryLoadAfterCoalescerFlush(ClaudeSession loadedSession, Transition transition) {
        if (!isCurrentTransition(transition) || host.getSession() != loadedSession) {
            return;
        }
        int messageCount = loadedSession != null ? loadedSession.getMessages().size() : 0;
        StreamMessageCoalescer coalescer = host.getStreamCoalescer();
        if (coalescer == null) {
            host.callJavaScript("historyLoadComplete", String.valueOf(messageCount), JsUtils.escapeJs(transition.token()));
            return;
        }
        LongConsumer signalComplete = seq -> {
            if (isCurrentTransition(transition) && host.getSession() == loadedSession) {
                host.callJavaScript("historyLoadComplete", String.valueOf(messageCount), JsUtils.escapeJs(transition.token()));
            }
        };
        // Same lock contract as enqueue: the flush may deep-copy live messages, and
        // a loaded session is exactly the case where a writer can still exist. No
        // session means no live writer, so the lockless call is safe.
        if (loadedSession != null) {
            synchronized (loadedSession.getState().getMessageStateLock()) {
                coalescer.flush(signalComplete);
            }
        } else {
            coalescer.flush(signalComplete);
        }
    }

    /**
     * Determine the working directory for the session.
     */
    public String determineWorkingDirectory() {
        String projectPath = host.getProject().getBasePath();

        if (projectPath == null || !new File(projectPath).exists()) {
            String userHome = NodeDetector.resolveHomeForFileOps();
            LOG.warn("Using user home directory as fallback: " + userHome);
            return userHome;
        }

        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            // Normalized effective working directory (custom dir if valid, else the
            // project path). Collapsing relative segments here keeps the launched cwd
            // consistent with the directory history is read from.
            String resolvedPath = settingsService.getEffectiveWorkingDirectory(projectPath);
            if (resolvedPath != null && !resolvedPath.isEmpty()) {
                LOG.info("Using working directory: " + resolvedPath);
                return resolvedPath;
            }
        } catch (Exception e) {
            LOG.warn("Failed to resolve working directory: " + e.getMessage());
        }

        return projectPath;
    }

    /**
     * Fetch slash commands using local registry (no SDK/API call needed).
     * Merges built-in commands with skill-derived commands per provider.
     */
    public void fetchSlashCommandsOnStartup() {
        ClaudeSession currentSession = host.getSession();
        String cwd = currentSession != null ? currentSession.getCwd() : null;
        if (cwd == null) {
            cwd = host.getProject().getBasePath();
        }

        // Determine current provider
        String provider = "claude";
        if (currentSession != null && currentSession.getProvider() != null) {
            provider = currentSession.getProvider();
        }

        LOG.info("Fetching slash commands locally, provider=" + provider + ", cwd=" + cwd);

        String currentFilePath = getCurrentEditorFilePath();
        var commands = SlashCommandRegistry.getCommands(provider, cwd, currentFilePath);
        String commandsJson = SlashCommandRegistry.toJson(commands);

        host.setFetchedSlashCommandsCount(commands.size());
        host.setSlashCommandsFetched(true);
        LOG.info("Slash commands resolved locally: " + commands.size() + " commands");

        // Pre-compute Codex skills outside EDT to avoid file I/O on UI thread
        final List<SlashCommandRegistry.SlashCommand> codexSkills;
        final String codexSkillsJson;
        if ("codex".equalsIgnoreCase(provider)) {
            codexSkills = SlashCommandRegistry.getCodexSkills(cwd);
            codexSkillsJson = SlashCommandRegistry.toJson(codexSkills);
            LOG.info("Codex skills resolved: " + codexSkills.size() + " skills");
        } else {
            codexSkills = null;
            codexSkillsJson = null;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                host.callJavaScript("updateSlashCommands", JsUtils.escapeJs(commandsJson));

                // Push Codex skills as separate channel for $ autocomplete
                if (codexSkillsJson != null) {
                    host.callJavaScript("window.updateDollarCommands", JsUtils.escapeJs(codexSkillsJson));
                }
            } catch (Exception e) {
                LOG.warn("Failed to send slash commands to frontend: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Send current permission mode to the frontend.
     */
    public void sendCurrentPermissionMode() {
        try {
            String currentMode = "default";

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
     * Clear transient context usage after creating a new session. The new provider has
     * not reported a trusted token count yet, so used/max values remain unknown.
     */
    private void resetTokenUsage() {
        new UsagePushService(host.getHandlerContext()).clearUsageDisplay();
    }

    private String getCurrentEditorFilePath() {
        return com.github.claudecodegui.util.EditorFileUtils.getCurrentEditorFilePath(this.host.getProject());
    }

    private ClaudeSession createDefaultSession() {
        return new ClaudeSession(
                host.getProject(),
                host.getClaudeSDKBridge(),
                host.getCodexSDKBridge(),
                host.getCliBridges(),
                host.getGrokSDKBridge());
    }

    /**
     * Release process-backed provider state when the user leaves a logical session.
     * Persisted transcripts and session IDs remain available, so the next real
     * message can lazily recreate the selected provider and resume normally.
     */
    private CompletableFuture<Void> releasePersistentProviderResources(ClaudeSession oldSession, String reason) {
        if (oldSession == null) {
            return CompletableFuture.completedFuture(null);
        }

        String oldEpoch = oldSession.getRuntimeSessionEpoch();
        ClaudeSDKBridge claudeBridge = this.host.getClaudeSDKBridge();
        if (claudeBridge != null) {
            claudeBridge.resetPersistentRuntime(oldEpoch);
            claudeBridge.shutdownDaemon();
        }

        if (this.host.getGrokSDKBridge() != null) {
            this.host.getGrokSDKBridge().resetPersistentRuntime(oldEpoch);
            this.host.getGrokSDKBridge().shutdownDaemon();
        }

        if (this.host.getZcodeSDKBridge() != null) {
            this.host.getZcodeSDKBridge().resetPersistentRuntime(oldEpoch);
            this.host.getZcodeSDKBridge().shutdownDaemon();
        }

        CompletableFuture<Void> drained = CompletableFuture.completedFuture(null);
        if ("codex".equals(oldSession.getProvider())) {
            CodexSDKBridge codexBridge = this.host.getCodexSDKBridge();
            if (codexBridge != null) {
                // A restored session reuses the default channel; its next reader must wait for this writer's release.
                drained = codexBridge.releaseCodexThread(oldSession.getChannelId(), oldSession.getCwd(), oldSession.getSessionId())
                        .thenAccept(result -> {
                            if (result.has("error")) {
                                throw new IllegalStateException(result.get("error").getAsString());
                            }
                        });
            }
        }

        return drained.thenRun(() -> LOG.info("[Lifecycle] Released persistent provider resources for " + reason
                + ", old epoch=" + oldEpoch));
    }

    private void completeNewSessionBootstrap(ClaudeSession newSession, String workingDirectory, String successLogPrefix,
                                             Transition transition, long clearBarrierSeq) {
        host.clearPendingPermissionRequests();
        host.clearPermissionDecisionMemory();
        host.setSession(newSession);
        host.getHandlerContext().setSession(newSession);
        host.setupSessionCallbacks();

        newSession.setSessionInfo(null, workingDirectory);
        acceptTransition(transition, clearBarrierSeq);
        LOG.info(successLogPrefix + workingDirectory + ", epoch=" + newSession.getRuntimeSessionEpoch());
        fetchSlashCommandsOnStartup();

        ApplicationManager.getApplication().invokeLater(() -> {
            if (!isCurrentTransition(transition) || host.getSession() != newSession) { return; }
            host.callJavaScript("onStreamEnd");
            host.callJavaScript("showLoading", "false");
            // Release the frontend session transition guard so updateMessages works again.
            // Must come BEFORE updateStatus to ensure the guard is lifted before any
            // subsequent message updates arrive.
            host.callJavaScript("historyLoadComplete", "", JsUtils.escapeJs(transition.token()));
            host.callJavaScript("updateStatus",
                    JsUtils.escapeJs(ClaudeCodeGuiBundle.message("toast.newSessionCreatedReady")));
            resetTokenUsage();
        });
    }
}
