package com.github.claudecodegui.provider.zcode;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.provider.ModelProviderHandler;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * ZCode SDK bridge (Claude-template architecture, mirrors GrokSDKBridge).
 *
 * Java contract mirrors {@code ClaudeSDKBridge} send shape:
 * session/epoch/cwd/attachments/permissionMode/model/openedFiles/agentPrompt/streaming/reasoning.
 *
 * Node transport is a persistent ZCode app-server child ({@code node zcode.cjs app-server},
 * stdio JSON-RPC) which emits Claude-compatible tags. Credentials are resolved
 * entirely Node-side from the ZCode desktop client config — the Java layer never
 * sees or forwards API keys.
 */
public class ZcodeSDKBridge extends BaseSDKBridge {

    private final ZcodeDaemonCoordinator daemonCoordinator;
    private final ZcodeDaemonRequestExecutor daemonRequestExecutor;

    /** Last observed token total from [USAGE] for /context synthesis. */
    private final AtomicInteger lastUsedTokens = new AtomicInteger(0);
    private volatile String lastUsageModel = "";

    public ZcodeSDKBridge() {
        super(ZcodeSDKBridge.class);

        this.daemonCoordinator = new ZcodeDaemonCoordinator(
                LOG,
                nodeDetector,
                this::getDirectoryResolver,
                envConfigurator,
                env -> configureProviderEnv(env, "{}")
        );
        this.daemonRequestExecutor = new ZcodeDaemonRequestExecutor(LOG, this);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "zcode";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("ZCODE_USE_STDIN", "true");
        env.put("CI", "1");
        // No credentials here: the Node layer resolves ZCode auth from the
        // desktop client's own config (see ai-bridge zcode-config.js).
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    ) {
        if (line.contains("[DEBUG]") || line.startsWith("[ZCODE]") || line.startsWith("[DIAG-")) {
            LOG.debug("[ZCode] " + line);
            return;
        }

        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[COMMAND_ERROR]")
                || line.startsWith("[UNCAUGHT_ERROR]")
                || line.startsWith("[UNHANDLED_REJECTION]")) {
            lastNodeError.set(line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
            return;
        }
        if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
            return;
        }
        if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
            return;
        }
        if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
            return;
        }
        if (line.startsWith("[BLOCK_RESET]")) {
            callback.onMessage("block_reset", "");
            return;
        }
        if (line.startsWith("[SESSION_ID]")) {
            String id = line.substring("[SESSION_ID]".length()).trim();
            if (!id.isEmpty()) {
                callback.onMessage("session_id", id);
            }
            return;
        }
        if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    result.messages.add(msg);
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "assistant";
                    callback.onMessage(msgType, jsonStr);

                    if ("assistant".equals(msgType)) {
                        String text = extractAssistantText(msg);
                        if (text != null && !text.isEmpty() && assistantContent.indexOf(text) < 0) {
                            // Prefer full message text when longer than deltas
                            if (text.length() >= assistantContent.length()) {
                                assistantContent.setLength(0);
                                assistantContent.append(text);
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            return;
        }
        if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
            return;
        }
        if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            assistantContent.append(content);
            callback.onMessage("content", content);
            return;
        }
        if (line.startsWith("[THINKING_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", delta);
            return;
        }
        if (line.startsWith("[THINKING]")) {
            callback.onMessage("thinking", line.substring("[THINKING]".length()).trim());
            return;
        }
        if (line.startsWith("[TOOL_RESULT]")) {
            callback.onMessage("tool_result", line.substring("[TOOL_RESULT]".length()).trim());
            return;
        }
        if (line.startsWith("[USAGE]")) {
            String usageJson = line.substring("[USAGE]".length()).trim();
            try {
                JsonObject usage = gson.fromJson(usageJson, JsonObject.class);
                // Canonical snake_case for Java consumers; camelCase is fallback input.
                JsonObject canonical = ZcodeContextUsageBuilder.normalizeUsageToSnakeCase(usage);
                if (canonical != null) {
                    usageJson = gson.toJson(canonical);
                    usage = canonical;
                }
                int used = ZcodeContextUsageBuilder.extractUsedTokens(usage);
                if (used > 0) {
                    lastUsedTokens.set(used);
                }
            } catch (Exception ignored) {
            }
            callback.onMessage("usage", usageJson);
            return;
        }
        if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj != null && obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
            return;
        }

        // Final JSON result line from Node (success envelope)
        if (line.startsWith("{") && line.contains("\"success\"")) {
            try {
                JsonObject obj = gson.fromJson(line, JsonObject.class);
                if (obj != null && obj.has("success") && !obj.get("success").getAsBoolean()) {
                    String err = obj.has("error") ? obj.get("error").getAsString() : line;
                    hadSendError.set(true);
                    result.success = false;
                    result.error = err;
                    callback.onError(err);
                } else if (obj != null && obj.has("sessionId") && !obj.get("sessionId").isJsonNull()) {
                    String sid = obj.get("sessionId").getAsString();
                    if (sid != null && !sid.isEmpty()) {
                        callback.onMessage("session_id", sid);
                    }
                }
            } catch (Exception ignored) {
            }
        }
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            return jsonStr;
        }
    }

    private String extractAssistantText(JsonObject msg) {
        if (msg == null || !msg.has("message")) {
            return null;
        }
        try {
            JsonObject message = msg.getAsJsonObject("message");
            if (message == null || !message.has("content")) {
                return null;
            }
            com.google.gson.JsonElement contentEl = message.get("content");
            if (contentEl.isJsonArray()) {
                StringBuilder sb = new StringBuilder();
                for (com.google.gson.JsonElement el : contentEl.getAsJsonArray()) {
                    if (el.isJsonObject()) {
                        JsonObject block = el.getAsJsonObject();
                        if (block.has("text")) {
                            sb.append(block.get("text").getAsString());
                        }
                    }
                }
                return sb.toString();
            } else if (contentEl.isJsonPrimitive()) {
                return contentEl.getAsString();
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    // ============================================================================
    // Daemon lifecycle (parity with Grok)
    // ============================================================================

    public void addDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        this.daemonCoordinator.addDaemonEventListener(listener);
    }

    public void removeDaemonEventListener(DaemonBridge.DaemonEventListener listener) {
        this.daemonCoordinator.removeDaemonEventListener(listener);
    }

    public void shutdownDaemon() {
        daemonCoordinator.shutdownDaemon();
    }

    public DaemonBridge getCurrentDaemonBridgeForInspection() {
        return daemonCoordinator.getCurrentDaemonBridge();
    }

    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch) {
        daemonCoordinator.prewarmDaemonAsync(cwd, runtimeSessionEpoch);
    }

    public void prewarmDaemonAsync(String cwd, String runtimeSessionEpoch, String sessionId) {
        daemonCoordinator.prewarmDaemonAsync(cwd, runtimeSessionEpoch, sessionId);
    }

    public void resetPersistentRuntime(String runtimeSessionEpoch) {
        daemonCoordinator.resetPersistentRuntime(runtimeSessionEpoch);
    }

    /**
     * Push permission mode to the live ZCode daemon runtime so the new mode takes
     * effect mid-turn, not only on the next user message.
     *
     * <p>Mirrors {@code GrokSDKBridge#setPermissionModeLive}: best-effort against
     * an already-running daemon only (no spawn). A fresh daemon has no runtime, so
     * pushing would be a no-op.
     *
     * @return JSON with success/applied/reason (or error) for diagnostics
     */
    public CompletableFuture<JsonObject> setPermissionModeLive(String sessionId, String epoch, String mode) {
        // Non-spawning accessor: only push to an already-running daemon.
        DaemonBridge db = this.daemonCoordinator.getCurrentDaemonBridge();
        if (db == null || !db.isAlive()) {
            JsonObject skipped = new JsonObject();
            skipped.addProperty("success", true);
            skipped.addProperty("applied", false);
            skipped.addProperty("reason", "no-daemon");
            LOG.info("[ZCode] setPermissionModeLive skipped (no live daemon): mode=" + mode);
            return CompletableFuture.completedFuture(skipped);
        }

        JsonObject params = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            params.addProperty("sessionId", sessionId);
        }
        if (epoch != null && !epoch.isEmpty()) {
            params.addProperty("runtimeSessionEpoch", epoch);
        }
        if (mode != null && !mode.isEmpty()) {
            params.addProperty("permissionMode", mode);
        }

        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        // setPermissionMode only emits {id, done, success} — complete from onComplete/onError.
        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) { }

            @Override
            public void onStderr(String text) { }

            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", error != null ? error : "unknown");
                    resultFuture.complete(err);
                }
            }

            @Override
            public void onComplete(boolean success) {
                if (!resultFuture.isDone()) {
                    JsonObject ok = new JsonObject();
                    ok.addProperty("success", success);
                    // Daemon applied flag is best-effort; success=true means command finished.
                    ok.addProperty("applied", success);
                    resultFuture.complete(ok);
                }
            }
        };

        try {
            LOG.info("[ZCode] setPermissionModeLive → zcode.setPermissionMode mode=" + mode
                    + " sessionId=" + (sessionId != null ? sessionId : "(none)")
                    + " epoch=" + (epoch != null ? epoch : "(none)"));
            CompletableFuture<Boolean> commandFuture = db.sendCommand("zcode.setPermissionMode", params, callback);
            commandFuture.exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", ex.getMessage() != null ? ex.getMessage() : "sendCommand failed");
                    resultFuture.complete(err);
                }
                return false;
            });
        } catch (Exception e) {
            LOG.error("[ZCode] setPermissionModeLive failed: " + e.getMessage(), e);
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", e.getMessage() != null ? e.getMessage() : "exception");
            return CompletableFuture.completedFuture(err);
        }

        return resultFuture.orTimeout(10, TimeUnit.SECONDS).exceptionally(ex -> {
            JsonObject err = new JsonObject();
            err.addProperty("success", false);
            err.addProperty("error", "setPermissionMode timed out after 10 seconds");
            return err;
        });
    }

    /**
     * Context usage for the /context dialog.
     * Prefer daemon runtime snapshot when available; otherwise synthesize from the
     * last [USAGE] line + static model context limits.
     */
    public CompletableFuture<JsonObject> getContextUsage(String sessionId, String cwd, String model) {
        String effectiveModel = (model != null && !model.isEmpty()) ? model : lastUsageModel;
        int maxTokens = ModelProviderHandler.getModelContextLimit(effectiveModel);
        int usedTokens = lastUsedTokens.get();

        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db != null && db.isAlive()) {
            return fetchContextUsageFromDaemon(db, sessionId, cwd, effectiveModel)
                    .exceptionally(ex -> {
                        LOG.warn("[ZCode] daemon getContextUsage failed, using local synthesis: " + ex.getMessage());
                        return ZcodeContextUsageBuilder.build(usedTokens, maxTokens, effectiveModel);
                    });
        }

        return CompletableFuture.completedFuture(
                ZcodeContextUsageBuilder.build(usedTokens, maxTokens, effectiveModel)
        );
    }

    private CompletableFuture<JsonObject> fetchContextUsageFromDaemon(
            DaemonBridge db, String sessionId, String cwd, String model) {
        JsonObject params = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            params.addProperty("sessionId", sessionId);
        }
        if (cwd != null && !cwd.isEmpty()) {
            params.addProperty("cwd", cwd);
        }
        if (model != null && !model.isEmpty()) {
            params.addProperty("model", model);
        }
        params.addProperty("usedTokens", lastUsedTokens.get());
        params.addProperty("maxTokens", ModelProviderHandler.getModelContextLimit(model));

        AtomicReference<JsonObject> resultRef = new AtomicReference<>();
        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                try {
                    JsonObject parsed = gson.fromJson(line, JsonObject.class);
                    if (parsed != null) {
                        resultRef.set(parsed);
                    }
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onStderr(String text) { }

            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    resultFuture.completeExceptionally(
                            new RuntimeException(error != null ? error : "getContextUsage error"));
                }
            }

            @Override
            public void onComplete(boolean success) {
                if (resultFuture.isDone()) {
                    return;
                }
                JsonObject result = resultRef.get();
                if (success && result != null && (!result.has("success") || result.get("success").getAsBoolean())) {
                    resultFuture.complete(result);
                } else if (result != null && result.has("success") && !result.get("success").getAsBoolean()) {
                    // Fall through to local synthesis via exceptionally path
                    resultFuture.completeExceptionally(new RuntimeException(
                            result.has("error") ? result.get("error").getAsString() : "daemon context usage failed"));
                } else {
                    resultFuture.completeExceptionally(new RuntimeException("No context usage response"));
                }
            }
        };

        try {
            db.sendCommand("zcode.getContextUsage", params, callback).exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    resultFuture.completeExceptionally(ex);
                }
                return false;
            });
        } catch (Exception e) {
            resultFuture.completeExceptionally(e);
        }

        return resultFuture.orTimeout(15, TimeUnit.SECONDS);
    }

    /**
     * Live ZCode quota/billing snapshot for the Usage Statistics panel.
     * Tries the daemon (which talks to the app-server); on failure returns
     * a structured {@code data.unavailable} payload so the UI can stop loading.
     */
    public CompletableFuture<JsonObject> getUsage(String cwd) {
        // Non-spawning: Settings panel must not start a cold daemon just to refresh billing.
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db == null || !db.isAlive()) {
            return CompletableFuture.completedFuture(buildUsageUnavailable(
                    "ZCode daemon is not running. Open a ZCode chat turn first, or check Node/daemon setup."));
        }

        JsonObject params = new JsonObject();
        if (cwd != null && !cwd.isEmpty()) {
            params.addProperty("cwd", cwd);
        }

        AtomicReference<JsonObject> resultRef = new AtomicReference<>();
        CompletableFuture<JsonObject> resultFuture = new CompletableFuture<>();

        DaemonBridge.DaemonOutputCallback callback = new DaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                try {
                    JsonObject parsed = gson.fromJson(line, JsonObject.class);
                    if (parsed != null) {
                        resultRef.set(parsed);
                    }
                } catch (Exception ignored) {
                }
            }

            @Override
            public void onStderr(String text) { }

            @Override
            public void onError(String error) {
                if (!resultFuture.isDone()) {
                    resultFuture.complete(buildUsageUnavailable(
                            error != null ? error : "getUsage failed"));
                }
            }

            @Override
            public void onComplete(boolean success) {
                if (resultFuture.isDone()) {
                    return;
                }
                JsonObject result = resultRef.get();
                if (result != null) {
                    resultFuture.complete(result);
                } else {
                    resultFuture.complete(buildUsageUnavailable(
                            success ? "No usage payload from ZCode daemon" : "getUsage command failed"));
                }
            }
        };

        try {
            db.sendCommand("zcode.getUsage", params, callback).exceptionally(ex -> {
                if (!resultFuture.isDone()) {
                    resultFuture.complete(buildUsageUnavailable(
                            ex.getMessage() != null ? ex.getMessage() : "sendCommand failed"));
                }
                return false;
            });
        } catch (Exception e) {
            return CompletableFuture.completedFuture(buildUsageUnavailable(e.getMessage()));
        }

        return resultFuture.orTimeout(45, TimeUnit.SECONDS).exceptionally(ex ->
                buildUsageUnavailable("getUsage timed out: " + (ex.getMessage() != null ? ex.getMessage() : "timeout"))
        );
    }

    /** Payload shape that {@code useUsageStatistics} accepts without hanging the spinner. */
    static JsonObject buildUsageUnavailable(String message) {
        JsonObject root = new JsonObject();
        root.addProperty("success", true);
        JsonObject data = new JsonObject();
        data.addProperty("unavailable", true);
        data.addProperty("message", message != null ? message : "ZCode usage is unavailable");
        data.addProperty("source", "plugin-fallback");
        root.add("data", data);
        return root;
    }

    /** Package-visible for tests: last captured usage total. */
    int getLastUsedTokensForTest() {
        return lastUsedTokens.get();
    }

    void setLastUsedTokensForTest(int tokens) {
        lastUsedTokens.set(tokens);
    }

    /**
     * Interrupt a channel. In daemon mode, sends an abort command to cancel the
     * active ZCode turn. Also delegates to ProcessManager for fallback.
     */
    @Override
    public void interruptChannel(String channelId) {
        DaemonBridge db = daemonCoordinator.getCurrentDaemonBridge();
        if (db != null && db.isAlive()) {
            LOG.info("[ZcodeSDKBridge] Sending daemon abort for channel: " + channelId);
            try {
                db.sendAbort();
            } catch (Exception e) {
                LOG.error("[ZcodeSDKBridge] Daemon abort failed: " + e.getMessage());
            }
        }
        // Also try per-process interrupt (covers one-shot fallback)
        super.interruptChannel(channelId);
    }

    @Override
    public void cleanupAllProcesses() {
        shutdownDaemon();
        super.cleanupAllProcesses();
    }

    // ============================================================================
    // Message sending (Claude-shaped)
    // ============================================================================

    /**
     * Full Claude-shaped send entry (preferred). Tries daemon first for the persistent
     * app-server runtime.
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
            boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        String normalizedCwd = normalizeCwdForNode(cwd);

        DaemonBridge db = daemonCoordinator.getDaemonBridge();
        if (db != null) {
            return sendMessageViaDaemon(db, channelId, message, sessionId, runtimeSessionEpoch,
                    normalizedCwd, attachments, permissionMode, model, openedFiles,
                    agentPrompt, streaming, disableThinking, reasoningEffort, callback);
        }

        LOG.info("[ZcodeSDKBridge] Using per-process (channel-manager) mode (daemon unavailable)");
        // Fallback to one-shot
        JsonObject stdinInput = buildStdinPayloadForDaemon(
                message, sessionId, runtimeSessionEpoch, normalizedCwd, attachments,
                permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort
        );
        String stdinJson = gson.toJson(stdinInput);
        List<String> command = buildBaseCommand("send");
        LOG.info("[ZCode] sendMessage (fallback) sessionId=" + (sessionId != null ? sessionId : "(new)")
                + ", epoch=" + (runtimeSessionEpoch != null ? runtimeSessionEpoch : "(none)")
                + ", model=" + (model != null ? model : "(default)"));

        return executeStreamingCommand(channelId, command, stdinJson, normalizedCwd, callback);
    }

    private String normalizeCwdForNode(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            return cwd;
        }
        String nodePath = nodeDetector.getCachedNodePath();
        boolean isWsl = nodePath != null && NodeDetector.isWslPath(nodePath);
        return isWsl ? NodeDetector.convertToWslPath(cwd) : cwd;
    }

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
            boolean disableThinking,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return daemonRequestExecutor.sendMessageViaDaemon(
                daemon, channelId, message, sessionId, runtimeSessionEpoch, cwd,
                attachments, permissionMode, model, openedFiles, agentPrompt,
                streaming, disableThinking, reasoningEffort, callback
        );
    }

    /**
     * Compatibility overload used by older call sites.
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            MessageCallback callback
    ) {
        return sendMessage(
                channelId,
                message,
                sessionId,
                null,
                cwd,
                attachments,
                permissionMode,
                model,
                null,
                agentPrompt,
                true,
                false,
                null,
                callback
        );
    }

    // Package-visible for ZcodeDaemonRequestExecutor
    JsonObject buildStdinPayloadForDaemon(
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
            boolean disableThinking,
            String reasoningEffort
    ) {
        return buildStdinPayload(
                message, sessionId, runtimeSessionEpoch, cwd, attachments,
                permissionMode, model, openedFiles, agentPrompt, streaming, disableThinking, reasoningEffort
        );
    }

    private JsonObject buildStdinPayload(
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
            boolean disableThinking,
            String reasoningEffort
    ) {
        JsonObject stdinInput = new JsonObject();
        stdinInput.addProperty("message", message != null ? message : "");
        stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
        if (runtimeSessionEpoch != null && !runtimeSessionEpoch.isEmpty()) {
            stdinInput.addProperty("runtimeSessionEpoch", runtimeSessionEpoch);
        }
        stdinInput.addProperty("cwd", cwd != null ? cwd : "");
        stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        stdinInput.addProperty("model", model != null ? model : "");
        stdinInput.addProperty("agentPrompt", agentPrompt != null ? agentPrompt : "");
        stdinInput.addProperty("streaming", streaming == null || streaming);
        stdinInput.addProperty("disableThinking", disableThinking);
        if (reasoningEffort != null && !reasoningEffort.isEmpty()) {
            stdinInput.addProperty("reasoningEffort", reasoningEffort);
        }
        if (openedFiles != null) {
            stdinInput.add("openedFiles", openedFiles);
        }
        if (attachments != null && !attachments.isEmpty()) {
            JsonArray attArr = new JsonArray();
            for (ClaudeSession.Attachment a : attachments) {
                JsonObject o = new JsonObject();
                o.addProperty("fileName", a.fileName);
                o.addProperty("mediaType", a.mediaType);
                o.addProperty("data", a.data);
                attArr.add(o);
            }
            stdinInput.add("attachments", attArr);
        }
        return stdinInput;
    }

    /**
     * Session messages from the ZCode app-server history (live query via
     * channel-manager; ZCode does not expose an on-disk transcript layout).
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new ZcodeHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[ZcodeSDKBridge] Failed to load session messages: " + e.getMessage());
            return java.util.Collections.emptyList();
        }
    }
}
