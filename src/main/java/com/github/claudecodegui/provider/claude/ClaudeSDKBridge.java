package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonObject;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.SDKResult;

import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Claude Agent SDK bridge.
 * Handles Java to Node.js SDK communication, supports async and streaming responses.
 */
public class ClaudeSDKBridge extends BaseSDKBridge {

    private final ClaudeStreamAdapter streamAdapter;
    private final ClaudeRequestParamsBuilder requestParamsBuilder;
    private final ClaudeJsonOutputExtractor jsonOutputExtractor;
    private final ClaudeDaemonCoordinator daemonCoordinator;
    private final ClaudeProcessInvoker processInvoker;
    private final ClaudeQueryExecutor queryExecutor;
    private final ClaudeSessionQueryService sessionQueryService;
    private final ClaudeMcpQueryService mcpQueryService;
    private final ClaudeRewindService rewindService;
    private final ClaudeDaemonRequestExecutor daemonRequestExecutor;

    public ClaudeSDKBridge() {
        super(ClaudeSDKBridge.class);

        // Shared dependencies extracted once to avoid repeated lambda allocation
        java.util.function.Supplier<File> sdkDirSupplier = () -> getDirectoryResolver().findSdkDir();

        this.streamAdapter = new ClaudeStreamAdapter(gson);
        this.requestParamsBuilder = new ClaudeRequestParamsBuilder(gson);
        this.jsonOutputExtractor = new ClaudeJsonOutputExtractor();
        ClaudeLogSanitizer logSanitizer = new ClaudeLogSanitizer();

        this.daemonCoordinator = new ClaudeDaemonCoordinator(
                LOG, nodeDetector, this::getDirectoryResolver, envConfigurator
        );
        this.processInvoker = new ClaudeProcessInvoker(
                LOG, gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, requestParamsBuilder, logSanitizer, streamAdapter
        );
        this.queryExecutor = new ClaudeQueryExecutor(
                gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, jsonOutputExtractor
        );
        this.sessionQueryService = new ClaudeSessionQueryService(
                LOG, gson, nodeDetector, sdkDirSupplier,
                envConfigurator, jsonOutputExtractor
        );
        this.mcpQueryService = new ClaudeMcpQueryService(
                LOG, gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, jsonOutputExtractor
        );
        this.rewindService = new ClaudeRewindService(
                LOG, gson, nodeDetector, sdkDirSupplier, processManager,
                envConfigurator, jsonOutputExtractor
        );
        this.daemonRequestExecutor = new ClaudeDaemonRequestExecutor(
                LOG, requestParamsBuilder, streamAdapter, jsonOutputExtractor
        );
    }

    /**
     * Shut down the daemon process.
     */
    public void shutdownDaemon() {
        daemonCoordinator.shutdownDaemon();
    }

    public void prewarmDaemonAsync(String cwd) {
        prewarmDaemonAsync(cwd, null);
    }

    /**
     * Prewarm daemon asynchronously to reduce first-message latency.
     */
    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch) {
        daemonCoordinator.prewarmDaemonAsync(cwd, runtimeSessionEpoch);
    }

    public void resetPersistentRuntime(String runtimeSessionEpoch) {
        daemonCoordinator.resetPersistentRuntime(runtimeSessionEpoch);
    }

    @Override
    public void cleanupAllProcesses() {
        shutdownDaemon();
        super.cleanupAllProcesses();
    }

    /**
     * Interrupt a channel. In daemon mode, sends an abort command to cancel the
     * active request. Also delegates to ProcessManager for per-process fallback.
     */
    @Override
    public void interruptChannel(String channelId) {
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db != null && db.isAlive()) {
            LOG.info("[ClaudeSDKBridge] Sending daemon abort for channel: " + channelId);
            try {
                db.sendAbort();
            } catch (Exception e) {
                LOG.error("[ClaudeSDKBridge] Daemon abort failed: " + e.getMessage());
            }
        }
        // Also try per-process interrupt (covers per-process fallback mode)
        super.interruptChannel(channelId);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "claude";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("CLAUDE_USE_STDIN", "true");
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            boolean[] hadSendError,
            String[] lastNodeError
    ) {
        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[GET_SESSION_ERROR]")
                || line.startsWith("[PERSIST_ERROR]")) {
            LOG.warn("[Node.js ERROR] " + line);
        }
        streamAdapter.processOutputLine(line, callback, result, assistantContent, hadSendError, lastNodeError);
    }

    // ============================================================================
    // Node.js detection methods (Claude-specific extensions)
    // ============================================================================

    /**
     * Detect Node.js and return detailed results.
     */
    public NodeDetectionResult detectNodeWithDetails() {
        return nodeDetector.detectNodeWithDetails();
    }

    /**
     * Clear Node.js detection cache.
     */
    public void clearNodeCache() {
        nodeDetector.clearCache();
    }

    /**
     * Verify Node.js path and return version.
     */
    public String verifyNodePath(String path) {
        return nodeDetector.verifyNodePath(path);
    }

    /**
     * Get cached Node.js version.
     */
    public String getCachedNodeVersion() {
        return nodeDetector.getCachedNodeVersion();
    }

    /**
     * Get cached Node.js path.
     */
    public String getCachedNodePath() {
        return nodeDetector.getCachedNodePath();
    }

    /**
     * Verify and cache Node.js path.
     */
    public NodeDetectionResult verifyAndCacheNodePath(String path) {
        return nodeDetector.verifyAndCacheNodePath(path);
    }

    // ============================================================================
    // Bridge directory methods
    // ============================================================================

    /**
     * Set claude-bridge directory path manually.
     */
    public void setSdkTestDir(String path) {
        getDirectoryResolver().setSdkDir(path);
    }

    /**
     * Get current claude-bridge directory.
     */
    public File getSdkTestDir() {
        return getDirectoryResolver().getSdkDir();
    }

    // ============================================================================
    // Sync query methods (Claude-specific)
    // ============================================================================

    /**
     * Execute query synchronously (blocking).
     */
    public SDKResult executeQuerySync(String prompt) {
        return executeQuerySync(prompt, 60);
    }

    /**
     * Execute query synchronously with timeout.
     */
    public SDKResult executeQuerySync(String prompt, int timeoutSeconds) {
        return queryExecutor.executeQuerySync(prompt, timeoutSeconds);
    }

    /**
     * Execute query asynchronously.
     */
    public CompletableFuture<SDKResult> executeQueryAsync(String prompt) {
        return queryExecutor.executeQueryAsync(prompt);
    }

    /**
     * Execute query with streaming.
     */
    public CompletableFuture<SDKResult> executeQueryStream(String prompt, MessageCallback callback) {
        return queryExecutor.executeQueryStream(prompt, callback);
    }

    // ============================================================================
    // Multi-turn interaction support
    // ============================================================================

    /**
     * Send message in existing channel (streaming response).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, null, cwd, attachments, null, null, null, null, null, false, callback);
    }

    /**
     * Send message in existing channel (streaming response, with permission mode and model selection).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, null, cwd, attachments, permissionMode, model, openedFiles, agentPrompt, null, false, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, null, cwd, attachments, permissionMode, model, openedFiles, agentPrompt, streaming, false, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag and disableThinking).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, null, cwd, attachments, permissionMode,
                model, openedFiles, agentPrompt, streaming, disableThinking, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag and disableThinking).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, runtimeSessionEpoch, cwd, attachments, permissionMode,
                model, openedFiles, agentPrompt, streaming, disableThinking, null, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag, disableThinking, and reasoningEffort).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        // Try daemon mode first (avoids per-request Node.js process spawning)
        DaemonBridge db = daemonCoordinator.getDaemonBridge();
        if (db != null) {
            return sendMessageViaDaemon(db, channelId, message, sessionId, runtimeSessionEpoch, cwd,
                    attachments, permissionMode, model, openedFiles, agentPrompt,
                    streaming, disableThinking, reasoningEffort, callback);
        }

        // Fallback: per-process mode (spawns a new Node.js process per request)
        LOG.info("[ClaudeSDKBridge] Using per-process mode (daemon not available)");
        return processInvoker.sendMessage(
                channelId,
                message,
                sessionId,
                runtimeSessionEpoch,
                cwd,
                attachments,
                permissionMode,
                model,
                openedFiles,
                agentPrompt,
                streaming,
                disableThinking,
                reasoningEffort,
                callback
        );
    }

    /**
     * Get session history messages.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        return sessionQueryService.getSessionMessages(sessionId, cwd);
    }

    public JsonObject getLatestClaudeUserMessage(String sessionId, String cwd) {
        return sessionQueryService.getLatestUserMessage(sessionId, cwd);
    }

    /**
     * Get MCP server connection status.
     */
    public CompletableFuture<List<JsonObject>> getMcpServerStatus(String cwd) {
        return mcpQueryService.getMcpServerStatus(cwd);
    }

    /**
     * Get MCP server tools list.
     */
    public CompletableFuture<JsonObject> getMcpServerTools(String serverId) {
        return mcpQueryService.getMcpServerTools(serverId);
    }

    // ============================================================================
    // Rewind files support
    // ============================================================================

    /**
     * Rewind files to a specific user message state.
     * Uses the SDK's rewindFiles() API to restore files to their state at a given message.
     *
     * @param sessionId The session ID
     * @param userMessageId The user message UUID to rewind to
     * @param cwd Working directory for the session
     * @return CompletableFuture with the result
     */
    public CompletableFuture<JsonObject> rewindFiles(String sessionId, String userMessageId, String cwd) {
        return rewindService.rewindFiles(sessionId, userMessageId, cwd);
    }

    public CompletableFuture<JsonObject> rewindFiles(String sessionId, String userMessageId) {
        return rewindFiles(sessionId, userMessageId, null);
    }

    // ============================================================================
    // Daemon mode message sending
    // ============================================================================

    /**
     * Send message via the long-running daemon process.
     * This avoids the ~5-10s overhead of spawning a new Node.js process per request.
     */
    private CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            Boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return daemonRequestExecutor.sendMessageViaDaemon(
                daemon,
                channelId,
                message,
                sessionId,
                runtimeSessionEpoch,
                cwd,
                attachments,
                permissionMode,
                model,
                openedFiles,
                agentPrompt,
                streaming,
                disableThinking,
                reasoningEffort,
                callback
        );
    }
}
