package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import com.github.claudecodegui.handler.history.HistoryMessageInjector;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.settings.ConfigPathManager;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Codex app-server bridge behind the existing provider facade.
 * Keeps the shared Java provider contract while delegating native thread/turn
 * communication to the long-running Node daemon.
 */
public class CodexSDKBridge extends BaseSDKBridge {

    private static final String IMAGE_STORAGE_DIR_NAME = "codex-images";
    private final CodexHistoryReader historyReader;
    private final boolean nativeHistoryEnabled;
    private final Path imageStorageDir;
    private final CodemossSettingsService settingsService;
    private final CodexDaemonCoordinator daemonCoordinator;
    private final CodexAppServerRequestExecutor appServerRequestExecutor;
    private final Map<String, String> runtimeSessionEpochs = new ConcurrentHashMap<>();
    private final Map<String, RuntimeGenerationScope> runtimeGenerations = new ConcurrentHashMap<>();
    private final Map<String, MessageCallback> activeCallbacks = new ConcurrentHashMap<>();
    private final Map<String, MessageCallback> callbackSubscriptions = new ConcurrentHashMap<>();
    private final String bridgeOwnerId = UUID.randomUUID().toString();
    private final String ownerScope;
    private final CodexInteractionRegistry interactionRegistry = new CodexInteractionRegistry();

    /** Executor for blocking daemon round-trips; never the common pool, never the UI thread. */
    public static java.util.concurrent.Executor codexControlExecutor() {
        return CodexAppServerRequestExecutor.turnWaitExecutor();
    }

    /** Creates the production Codex provider facade. */
    public CodexSDKBridge() {
        super(CodexSDKBridge.class);
        this.settingsService = new CodemossSettingsService();
        this.ownerScope = resolveOwnerScope();
        this.historyReader = new CodexHistoryReader();
        this.nativeHistoryEnabled = true;
        this.imageStorageDir = new ConfigPathManager().getConfigDir().resolve(IMAGE_STORAGE_DIR_NAME);
        this.daemonCoordinator = new CodexDaemonCoordinator(
                LOG, nodeDetector, getDirectoryResolver(), envConfigurator);
        this.appServerRequestExecutor = new CodexAppServerRequestExecutor(LOG, null);
        this.daemonCoordinator.addDaemonEventListener(this::handleCodexDaemonEvent);
    }

    CodexSDKBridge(Path sessionsDir) {
        this(sessionsDir, sessionsDir.resolve(IMAGE_STORAGE_DIR_NAME));
    }

    CodexSDKBridge(Path sessionsDir, Path imageStorageDir) {
        super(CodexSDKBridge.class);
        this.settingsService = new CodemossSettingsService();
        this.ownerScope = resolveOwnerScope();
        this.historyReader = new CodexHistoryReader(sessionsDir, gson);
        this.nativeHistoryEnabled = false;
        this.imageStorageDir = imageStorageDir;
        this.daemonCoordinator = new CodexDaemonCoordinator(
                LOG, nodeDetector, getDirectoryResolver(), envConfigurator);
        this.appServerRequestExecutor = new CodexAppServerRequestExecutor(LOG, null);
        this.daemonCoordinator.addDaemonEventListener(this::handleCodexDaemonEvent);
    }

    /** Assembles native provider integration tests without touching real account configuration. */
    CodexSDKBridge(Path sessionsDir, CodemossSettingsService settingsService,
                   Supplier<DaemonBridge> daemonFactory, String ownerScope) {
        super(CodexSDKBridge.class);
        this.settingsService = settingsService;
        this.ownerScope = ownerScope;
        this.historyReader = new CodexHistoryReader(sessionsDir, this.gson);
        this.nativeHistoryEnabled = true;
        this.imageStorageDir = sessionsDir.resolve(IMAGE_STORAGE_DIR_NAME);
        this.daemonCoordinator = new CodexDaemonCoordinator(LOG, daemonFactory);
        this.appServerRequestExecutor = new CodexAppServerRequestExecutor(LOG, null);
        this.daemonCoordinator.addDaemonEventListener(this::handleCodexDaemonEvent);
    }

    void handleCodexDaemonEvent(String event, JsonObject data) {
        if (!"codex_event".equals(event) || data == null) {
            return;
        }
        String channelId = data.has("channelId") && !data.get("channelId").isJsonNull()
                ? data.get("channelId").getAsString() : null;
        if (channelId == null) {
            return;
        }
        MessageCallback callback = this.activeCallbacks.get(channelId);
        if (callback == null) {
            callback = this.callbackSubscriptions.get(channelId);
        }
        if (callback == null) {
            return;
        }
        String eventEpoch = data.has("sessionEpoch") && !data.get("sessionEpoch").isJsonNull()
                ? data.get("sessionEpoch").getAsString() : null;
        String expectedEpoch = this.runtimeSessionEpochs.get(channelId);
        if (expectedEpoch != null && eventEpoch != null && !expectedEpoch.equals(eventEpoch)) {
            LOG.debug("[Codex] Dropping stale event for channel=" + channelId);
            return;
        }
        String kind = data.has("kind") && !data.get("kind").isJsonNull()
                ? data.get("kind").getAsString() : "codex_event";
        String runtimeGeneration = data.has("runtimeGeneration")
                && !data.get("runtimeGeneration").isJsonNull()
                ? data.get("runtimeGeneration").getAsString() : null;
        if (runtimeGeneration != null) {
            // Node assigns runtimeGeneration per CodexAppServerService instance, so
            // the counter restarts at 1 with every daemon process. Scoping the
            // monotonic gate to the producing daemon keeps a restart from being
            // misread as an out-of-order event.
            RuntimeGenerationScope current = new RuntimeGenerationScope(
                    this.daemonCoordinator.getGenerationCount(),
                    this.daemonCoordinator.getCurrentDaemonProcessGeneration(),
                    runtimeGeneration);
            RuntimeGenerationScope previous = this.runtimeGenerations.get(channelId);
            if (previous != null && isStaleRuntimeEvent(previous, current)) {
                return;
            }
            if (previous != null && !previous.equals(current)) {
                this.closeRuntimeInteractions(channelId, callback, data);
            }
            this.runtimeGenerations.put(channelId, current);
        }
        JsonObject eventPayload = data.has("payload") && data.get("payload").isJsonObject()
                ? data.getAsJsonObject("payload") : new JsonObject();
        if ("runtimeReset".equals(kind) || ("runtimeStateChanged".equals(kind)
                && "failed".equals(nativeString(eventPayload, "state")))) {
            this.closeRuntimeInteractions(channelId, callback, data);
        }
        if ("threadStarted".equals(kind) || "threadResumed".equals(kind) || "threadRelationVerified".equals(kind)) {
            String threadId = data.has("threadId") && !data.get("threadId").isJsonNull()
                    ? data.get("threadId").getAsString() : "";
            if (!threadId.isEmpty()) {
                String rootThreadId = data.has("rootThreadId") && !data.get("rootThreadId").isJsonNull()
                        ? data.get("rootThreadId").getAsString() : threadId;
                CodexThreadOwnerRegistry.ClaimResult claim = CodexThreadOwnerRegistry.claimRelation(
                        this.ownerScope, rootThreadId, threadId, this.bridgeOwnerId);
                if (!claim.acquired()) {
                    LOG.warn("[Codex] Thread is owned by another chat window: " + threadId);
                    callback.onMessage("status",
                            ClaudeCodeGuiBundle.message("error.codexThreadOwnedByAnotherWindow"));
                    return;
                }
                if (threadId.equals(rootThreadId)) {
                    callback.onMessage("session_id", threadId);
                }
            }
        } else if ("interactionResolved".equals(kind)) {
            JsonObject payload = data.has("payload") && data.get("payload").isJsonObject()
                    ? data.getAsJsonObject("payload") : new JsonObject();
            JsonElement rpcId = payload.has("rpcId") ? payload.get("rpcId") : payload.get("requestId");
            CodexInteractionRegistry.Entry entry = this.interactionRegistry.get(
                    rpcId, channelId, eventEpoch, runtimeGeneration);
            if (entry != null) {
                JsonObject routed = data.deepCopy();
                routed.addProperty("interactionKey", entry.interactionKey());
                routed.addProperty("dialogToken", this.interactionRegistry.pageToken(entry.interactionKey()));
                routed.addProperty("deliverySequence", entry.deliverySequence());
                routed.addProperty("resolved", true);
                JsonObject resolvedPayload = payload.deepCopy();
                resolvedPayload.addProperty("method", entry.method());
                routed.add("payload", resolvedPayload);
                this.interactionRegistry.resolve(entry.interactionKey());
                data = routed;
            }
        } else if ("interactionRequested".equals(kind)) {
            JsonObject payload = data.has("payload") && data.get("payload").isJsonObject()
                    ? data.getAsJsonObject("payload") : new JsonObject();
            JsonElement rpcId = payload.get("rpcId");
            JsonObject params = payload.has("params") && payload.get("params").isJsonObject()
                    ? payload.getAsJsonObject("params") : new JsonObject();
            long deadlineAt = params.has("deadlineAt") && params.get("deadlineAt").isJsonPrimitive()
                    ? params.get("deadlineAt").getAsLong() : 0L;
            CodexInteractionRegistry.Entry entry = this.interactionRegistry.register(
                    rpcId,
                    payload.has("method") ? payload.get("method").getAsString() : "",
                    channelId,
                    nativeString(data, "sessionEpoch"),
                    nativeString(data, "runtimeGeneration"),
                    nativeString(data, "rootThreadId"),
                    nativeString(data, "threadId"),
                    nativeString(data, "turnId"),
                    nativeString(data, "itemId"),
                    params,
                    deadlineAt);
            JsonObject routed = data.deepCopy();
            routed.addProperty("interactionKey", entry.interactionKey());
            routed.addProperty("dialogToken", this.interactionRegistry.pageToken(entry.interactionKey()));
            routed.addProperty("deliverySequence", entry.deliverySequence());
            routed.addProperty("resolved", false);
            data = routed;
        }
        callback.onMessage("codex_runtime_event", data.toString());
    }

    private void closeRuntimeInteractions(String channelId, MessageCallback callback, JsonObject context) {
        for (CodexInteractionRegistry.Entry entry : this.interactionRegistry.snapshot(channelId)) {
            JsonObject closed = context.deepCopy();
            closed.addProperty("kind", "interactionResolved");
            closed.addProperty("interactionKey", entry.interactionKey());
            closed.addProperty("dialogToken", this.interactionRegistry.pageToken(entry.interactionKey()));
            closed.addProperty("deliverySequence", entry.deliverySequence());
            closed.addProperty("resolved", true);
            JsonObject payload = new JsonObject();
            payload.addProperty("method", entry.method());
            closed.add("payload", payload);
            this.interactionRegistry.resolve(entry.interactionKey());
            callback.onMessage("codex_runtime_event", closed.toString());
        }
    }

    /**
     * Replay unresolved native interactions to the active session callback.
     *
     * @param channelId chat host identifier
     */
    public void replayPendingCodexInteractions(String channelId) {
        MessageCallback callback = this.activeCallbacks.get(channelId);
        if (callback == null) {
            callback = this.callbackSubscriptions.get(channelId);
        }
        if (callback == null) {
            return;
        }
        for (CodexInteractionRegistry.Entry entry : this.interactionRegistry.snapshot(channelId)) {
            JsonObject replay = new JsonObject();
            replay.addProperty("type", "daemon");
            replay.addProperty("event", "codex_event");
            replay.addProperty("provider", "codex");
            replay.addProperty("channelId", entry.channelId());
            replay.addProperty("sessionEpoch", entry.sessionEpoch());
            replay.addProperty("runtimeGeneration", entry.runtimeGeneration());
            replay.addProperty("rootThreadId", entry.rootThreadId());
            replay.addProperty("threadId", entry.threadId());
            replay.addProperty("turnId", entry.turnId());
            replay.addProperty("itemId", entry.itemId());
            replay.addProperty("kind", "interactionRequested");
            JsonObject payload = new JsonObject();
            payload.addProperty("method", entry.method());
            payload.add("params", entry.params().deepCopy());
            payload.add("rpcId", entry.rpcId() == null ? new JsonObject() : entry.rpcId().deepCopy());
            replay.add("payload", payload);
            replay.addProperty("interactionKey", entry.interactionKey());
            replay.addProperty("dialogToken", this.interactionRegistry.issuePageToken(entry.interactionKey()));
            replay.addProperty("deliverySequence", entry.deliverySequence());
            replay.addProperty("resolved", false);
            callback.onMessage("codex_runtime_event", replay.toString());
        }
    }

    /**
     * Refresh page-owned tokens and replay unresolved native interactions.
     *
     * @param channelId chat host identifier
     * @param pageGeneration frontend page generation used for diagnostics
     */
    public void refreshCodexInteractionPage(String channelId, long pageGeneration) {
        replayPendingCodexInteractions(channelId);
    }

    /** Record a page delivery acknowledgement without resolving native work. */
    public boolean acknowledgeCodexInteractionDelivery(
            String interactionKey,
            String dialogToken,
            long deliverySequence,
            String phase
    ) {
        return this.interactionRegistry.acknowledge(
                interactionKey, dialogToken, deliverySequence, phase);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "codex";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("CODEX_USE_STDIN", "true");
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
        if (line.contains("[DEBUG]")) {
            LOG.debug("[Codex] " + line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
        } else if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
        } else if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
        } else if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        } else if (line.startsWith("[THREAD_ID]")) {
            String receivedThreadId = line.substring("[THREAD_ID]".length()).trim();
            callback.onMessage("session_id", receivedThreadId);
        } else if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = this.gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "unknown";

                    if ("status".equals(msgType)) {
                        String status = "";
                        if (msg.has("message") && !msg.get("message").isJsonNull()) {
                            JsonElement statusEl = msg.get("message");
                            status = statusEl.isJsonPrimitive() ? statusEl.getAsString() : statusEl.toString();
                        }
                        if (status != null && !status.isEmpty()) {
                            callback.onMessage("status", status);
                        }
                        return;
                    }

                    // event_msg is protocol metadata (for example token_count), not a
                    // conversation message. Route it to the callback without inflating
                    // SDKResult.messageCount.
                    if (!"event_msg".equals(msgType)) {
                        String itemId = nativeString(msg, "codexItemId");
                        int existingIndex = -1;
                        if (itemId != null) {
                            for (int index = 0; index < result.messages.size(); index++) {
                                Object previous = result.messages.get(index);
                                if (previous instanceof JsonObject snapshot
                                        && itemId.equals(nativeString(snapshot, "codexItemId"))) {
                                    existingIndex = index;
                                    break;
                                }
                            }
                        }
                        if (existingIndex < 0) {
                            result.messages.add(msg);
                        } else {
                            result.messages.set(existingIndex, msg);
                        }
                    }

                    if ("assistant".equals(msgType)) {
                        try {
                            if (msg.has("codexSnapshot")) {
                                assistantContent.setLength(0);
                                for (Object previous : result.messages) {
                                    if (previous instanceof JsonObject snapshot
                                            && "assistant".equals(nativeString(snapshot, "type"))) {
                                        assistantContent.append(this.extractAssistantText(snapshot));
                                    }
                                }
                            } else {
                                String extracted = this.extractAssistantText(msg);
                                if (extracted != null && !extracted.isEmpty()) {
                                    assistantContent.append(extracted);
                                }
                            }
                        } catch (Exception ignored) {
                        }
                    }

                    callback.onMessage(msgType, jsonStr);
                }
            } catch (Exception ignored) {
            }
        } else if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
        } else if (line.startsWith("[THINKING_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", delta);
        } else if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            // Avoid duplicate
            if (!assistantContent.toString().contains(content)) {
                assistantContent.append(content);
            }
            callback.onMessage("content", content);
        } else if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = this.gson.fromJson(jsonStr, JsonObject.class);
                if (obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
        }
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = this.gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            LOG.warn("[CodexSDKBridge] Failed to decode JSON string payload, falling back to raw: " + e.getMessage());
            return jsonStr;
        }
    }

    // ============================================================================
    // Codex-specific configuration
    // ============================================================================

    // ============================================================================
    // Message sending
    // ============================================================================

    /**
     * Send message to Codex (streaming response).
     *
     * Note: Codex uses threadId instead of sessionId
     * Note: Codex supports images via local_image type (requires file path, not base64)
     * Note: agentPrompt is sent as native developerInstructions and remains separate from user text.
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String threadId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            String reasoningEffort,
            String serviceTier,
            MessageCallback callback
    ) {
        return sendMessage(
                channelId, message, threadId, cwd, attachments, permissionMode,
                model, agentPrompt, reasoningEffort, serviceTier, callback, null);
    }

    /**
     * Send a Codex message with the client identity used for native reconciliation.
     *
     * @param channelId chat host identifier
     * @param message user text
     * @param threadId native thread id, or null for a new thread
     * @param cwd effective working directory
     * @param attachments local image attachments
     * @param permissionMode requested native permission mode
     * @param model selected model
     * @param agentPrompt application developer instructions
     * @param reasoningEffort selected reasoning effort
     * @param serviceTier selected service tier
     * @param callback streaming callback
     * @param clientMessageId stable optimistic-message identity
     * @return future completed at the native turn terminal
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String threadId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            String reasoningEffort,
            String serviceTier,
            MessageCallback callback,
            String clientMessageId
    ) {
        return sendMessage(
                channelId, message, threadId, cwd, attachments, permissionMode,
                model, agentPrompt, reasoningEffort, serviceTier, callback,
                clientMessageId, null);
    }

    /**
     * Send a Codex message with the native collaboration and policy snapshot.
     *
     * @param channelId chat host identifier
     * @param message user text
     * @param threadId native thread id, or null for a new thread
     * @param cwd effective working directory
     * @param attachments local image attachments
     * @param permissionMode legacy compatibility mode
     * @param model selected model
     * @param agentPrompt application developer instructions
     * @param reasoningEffort selected reasoning effort
     * @param serviceTier selected service tier
     * @param callback streaming callback
     * @param clientMessageId stable optimistic-message identity
     * @param nativeSettings filtered native collaboration/policy settings
     * @return future completed at the native turn terminal
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String threadId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            String reasoningEffort,
            String serviceTier,
            MessageCallback callback,
            String clientMessageId,
            JsonObject nativeSettings
    ) {
        return sendMessageViaAppServer(
                channelId, message, threadId, cwd, attachments, permissionMode,
                model, agentPrompt, reasoningEffort, serviceTier, callback, clientMessageId,
                nativeSettings);
    }

    private CompletableFuture<SDKResult> sendMessageViaAppServer(
            String channelId,
            String message,
            String threadId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            String reasoningEffort,
            String serviceTier,
            MessageCallback callback,
            String clientMessageId,
            JsonObject nativeSettings
    ) {
        return CompletableFuture.supplyAsync(() -> {
            String safeChannelId = channelId == null || channelId.trim().isEmpty()
                    ? "codex" : channelId.trim();
            String sessionEpoch = this.runtimeSessionEpochs.computeIfAbsent(
                    safeChannelId, ignored -> UUID.randomUUID().toString());
            SDKResult streamedResult = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicReference<String> lastNodeError = new AtomicReference<>();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            try {
                String accessMode = CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE;
                try {
                    accessMode = this.settingsService.getCodexRuntimeAccessMode();
                } catch (Exception e) {
                    LOG.warn("[Codex] Failed to resolve runtime access mode before app-server send: "
                            + e.getMessage());
                }
                if (!isCodexRuntimeAccessAllowed(accessMode)) {
                    String error = ClaudeCodeGuiBundle.message("error.codexLocalAccessNotAuthorized");
                    streamedResult.success = false;
                    streamedResult.error = error;
                    callback.onError(error);
                    return streamedResult;
                }

                DaemonBridge daemon = this.daemonCoordinator.getDaemonBridge();
                if (daemon == null) {
                    String error = "Codex app-server daemon is unavailable";
                    streamedResult.success = false;
                    streamedResult.error = error;
                    callback.onError(error);
                    return streamedResult;
                }
                if (threadId != null && !threadId.trim().isEmpty()) {
                    CodexThreadOwnerRegistry.ClaimResult claim = CodexThreadOwnerRegistry.claim(
                            this.ownerScope, threadId, this.bridgeOwnerId);
                    if (!claim.acquired()) {
                        String error = "Codex thread is already owned by another chat window";
                        streamedResult.success = false;
                        streamedResult.error = error;
                        callback.onError(error);
                        return streamedResult;
                    }
                }
                JsonArray attachmentArray = buildCodexAttachments(attachments);
                JsonObject params = CodexAppServerRequestExecutor.buildSendParams(
                        safeChannelId,
                        sessionEpoch,
                        clientMessageId == null || clientMessageId.trim().isEmpty()
                                ? UUID.randomUUID().toString() : clientMessageId,
                        message == null ? "" : message,
                        threadId,
                        cwd,
                        permissionMode,
                        model,
                        reasoningEffort,
                        serviceTier,
                        attachmentArray,
                        nativeSettings);
                params.addProperty("developerInstructions", agentPrompt == null ? "" : agentPrompt);
                this.captureRuntimeConfiguration(params);

                // Register the callbacks only after every synchronous setup step
                // has succeeded: a capture failure must not leave a stale entry
                // routing daemon events to a dead turn.
                this.activeCallbacks.put(safeChannelId, callback);
                this.callbackSubscriptions.put(safeChannelId, callback);

                CompletableFuture<SDKResult> resultFuture = this.appServerRequestExecutor.sendMessageViaDaemon(
                        daemon,
                        params,
                        line -> processOutputLine(
                                line,
                                callback,
                                streamedResult,
                                assistantContent,
                                hadSendError,
                                lastNodeError));
                resultFuture.whenComplete((ignored, error) -> this.activeCallbacks.remove(safeChannelId, callback));
                SDKResult result = resultFuture.join();
                if (result == null) {
                    result = new SDKResult();
                }
                result.messages.addAll(streamedResult.messages);
                result.finalResult = assistantContent.toString();
                result.messageCount = result.messages.size();
                if (!result.success && result.error == null) {
                    result.error = streamedResult.error;
                }
                if (result.success || "User interrupted".equals(result.error)) {
                    if (!hadSendError.get()) {
                        callback.onComplete(result);
                    }
                } else if (!hadSendError.get()) {
                    String error = result.error == null ? "Codex app-server request failed" : result.error;
                    callback.onError(error);
                }
                return result;
            } catch (Exception e) {
                Throwable cause = e.getCause() != null ? e.getCause() : e;
                String error = cause.getMessage() == null ? cause.toString() : cause.getMessage();
                streamedResult.success = false;
                streamedResult.error = error;
                if (!hadSendError.get()) {
                    callback.onError(error);
                }
                return streamedResult;
            }
        }, CodexAppServerRequestExecutor.turnWaitExecutor());
    }

    /**
     * Respond to a native interaction while checking the page-owned dialog token.
     *
     * <p>The token is mandatory: a page that lost it must re-request the
     * interaction instead of answering stale.</p>
     *
     * @param channelId chat host identifier
     * @param cwd working directory used to locate the runtime session
     * @param interactionKey registry-issued interaction key
     * @param pageToken page token displayed with the dialog
     * @param result typed native response payload
     * @return control acknowledgement
     */
    public JsonObject respondCodexInteraction(
            String channelId,
            String cwd,
            String interactionKey,
            String pageToken,
            JsonObject result
    ) {
        CodexInteractionRegistry.Entry entry = this.interactionRegistry.get(interactionKey);
        if (entry == null || !sameChannel(channelId, entry.channelId())
                || !this.interactionRegistry.matchesPageToken(interactionKey, pageToken)) {
            return interactionError("Unknown or stale Codex interaction");
        }
        JsonObject acknowledgement = sendCodexControl(
                "codex.respondInteraction",
                channelId,
                cwd,
                params -> {
                    params.add("rpcId", entry.rpcId() == null ? new JsonObject() : entry.rpcId().deepCopy());
                    params.add("result", result == null ? new JsonObject() : result.deepCopy());
                });
        if (!acknowledgement.has("error")) {
            this.interactionRegistry.resolve(interactionKey);
        }
        return acknowledgement;
    }

    /**
     * Reply to a native Codex interaction with a typed error while checking the
     * page-owned dialog token. The token is mandatory — see
     * {@link #respondCodexInteraction(String, String, String, String, JsonObject)}.
     *
     * @param channelId chat host identifier
     * @param cwd working directory used to locate the runtime session
     * @param interactionKey registry-issued interaction key
     * @param pageToken page token displayed with the dialog
     * @param code native error code
     * @param message error message
     * @return control acknowledgement
     */
    public JsonObject rejectCodexInteraction(
            String channelId,
            String cwd,
            String interactionKey,
            String pageToken,
            int code,
            String message
    ) {
        CodexInteractionRegistry.Entry entry = this.interactionRegistry.get(interactionKey);
        if (entry == null || !sameChannel(channelId, entry.channelId())
                || !this.interactionRegistry.matchesPageToken(interactionKey, pageToken)) {
            return interactionError("Unknown or stale Codex interaction");
        }
        JsonObject acknowledgement = sendCodexControl(
                "codex.respondInteractionError",
                channelId,
                cwd,
                params -> {
                    params.add("rpcId", entry.rpcId() == null ? new JsonObject() : entry.rpcId().deepCopy());
                    params.addProperty("code", code);
                    params.addProperty("message", message == null ? "Codex interaction cancelled" : message);
                });
        if (!acknowledgement.has("error")) {
            this.interactionRegistry.resolve(interactionKey);
        }
        return acknowledgement;
    }

    private static boolean sameChannel(String first, String second) {
        return first == null ? second == null : first.equals(second);
    }

    private static JsonObject interactionError(String message) {
        JsonObject error = new JsonObject();
        error.addProperty("error", message);
        return error;
    }

    /**
     * Stop the current native Codex turn through the daemon control path.
     *
     * @param channelId chat host identifier
     * @param cwd working directory used to locate the runtime session
     * @return control acknowledgement
     */
    public JsonObject abortCodexTurn(String channelId, String cwd) {
        return sendCodexControl("codex.abortTurn", channelId, cwd, ignored -> { });
    }

    /**
     * Interrupt the active Codex turn through the native app-server control path.
     *
     * @param channelId chat host identifier
     */
    @Override
    public void interruptChannel(String channelId) {
        JsonObject acknowledgement = abortCodexTurn(channelId, null);
        if (acknowledgement.has("error")) {
            LOG.warn("[Codex] Native interrupt failed: " + acknowledgement.get("error"));
        }
    }

    /**
     * Queue the next complete native settings snapshot for the Codex thread.
     *
     * @param channelId chat host identifier
     * @param cwd working directory used to locate the runtime session
     * @param settings settings fields accepted by the app-server
     * @return revision acknowledgement
     */
    public JsonObject updateCodexSettings(String channelId, String cwd, JsonObject settings) {
        return sendCodexControl(
                "codex.updateSettings",
                channelId,
                cwd,
                params -> params.add("settings", settings == null ? new JsonObject() : settings.deepCopy()));
    }

    /**
     * Queue a native context compaction operation for the current Codex thread.
     *
     * @param channelId chat host identifier
     * @param cwd working directory used to locate the runtime session
     * @param threadId native thread id for the loaded root thread
     * @return future completed when the native compaction reaches a terminal state
     */
    public CompletableFuture<JsonObject> compactCodex(String channelId, String cwd, String threadId) {
        return this.compactCodex(channelId, cwd, threadId, null);
    }

    /**
     * Compact a restored thread with its current display receiver.
     *
     * @param channelId chat host identifier
     * @param cwd working directory
     * @param threadId loaded native thread id
     * @param callback receiver for the restored session's native items
     * @return future completed at the native terminal
     */
    public CompletableFuture<JsonObject> compactCodex(String channelId, String cwd, String threadId, MessageCallback callback) {
        if (threadId == null || threadId.trim().isEmpty()) {
            return CompletableFuture.completedFuture(
                    interactionError("Start a Codex conversation before using /compact"));
        }
        return this.runCodexLongOperation("codex.compact", channelId, cwd, threadId, callback);
    }

    /**
     * Execute a still-current native plan item as one default-mode turn.
     *
     * @param channelId chat host identifier
     * @param cwd effective working directory
     * @param threadId native thread owning the plan
     * @param planItemId native plan item id
     * @param planText authoritative plan text to implement
     * @return future completed at the implementation turn terminal
     */
    public CompletableFuture<JsonObject> executeCodexPlan(
            String channelId,
            String cwd,
            String threadId,
            String planItemId,
            String planText
    ) {
        if (!this.isCodexRuntimeAccessAllowed()) {
            return CompletableFuture.completedFuture(interactionError("Codex runtime access is inactive"));
        }
        DaemonBridge daemon = this.daemonCoordinator.getDaemonBridge();
        if (daemon == null) {
            return CompletableFuture.completedFuture(
                    interactionError("Codex app-server daemon is unavailable"));
        }
        String safeChannelId = channelId == null || channelId.trim().isEmpty()
                ? "codex" : channelId.trim();
        JsonObject params = new JsonObject();
        params.addProperty("channelId", safeChannelId);
        params.addProperty("cwd", cwd == null ? "" : cwd);
        params.addProperty("threadId", threadId == null ? "" : threadId);
        params.addProperty("planItemId", planItemId == null ? "" : planItemId);
        params.addProperty("planText", planText == null ? "" : planText);
        params.addProperty("clientMessageId", UUID.randomUUID().toString());
        params.addProperty("sessionEpoch", this.runtimeSessionEpochs.computeIfAbsent(
                safeChannelId, ignored -> UUID.randomUUID().toString()));
        return this.dispatchCodexLongOperation(daemon, "codex.executePlan", params,
                this.callbackSubscriptions.get(safeChannelId));
    }

    /**
     * Queue an inline review of uncommitted changes for the current Codex thread.
     *
     * @param channelId chat host identifier
     * @param cwd working directory used to locate the runtime session
     * @param threadId native thread id for the loaded root thread
     * @return future completed when the native review reaches a terminal state
     */
    public CompletableFuture<JsonObject> reviewCodex(String channelId, String cwd, String threadId) {
        return this.reviewCodex(channelId, cwd, threadId, null);
    }

    /**
     * Review a restored thread with its current display receiver.
     *
     * @param channelId chat host identifier
     * @param cwd working directory
     * @param threadId loaded native thread id
     * @param callback receiver for the restored session's native items
     * @return future completed at the native terminal
     */
    public CompletableFuture<JsonObject> reviewCodex(String channelId, String cwd, String threadId, MessageCallback callback) {
        if (threadId == null || threadId.trim().isEmpty()) {
            return CompletableFuture.completedFuture(
                    interactionError("Start a Codex conversation before using /review"));
        }
        return this.runCodexLongOperation("codex.review", channelId, cwd, threadId, callback);
    }

    /**
     * Connect the native runtime and resume a selected thread without a turn.
     *
     * @param channelId chat host identifier
     * @param cwd working directory used to locate the runtime session
     * @param threadId native thread id, or null for a fresh runtime
     * @return future completed after runtime bootstrap
     */
    public CompletableFuture<JsonObject> preconnectCodex(String channelId, String cwd, String threadId) {
        if (!this.isCodexRuntimeAccessAllowed()) {
            return CompletableFuture.completedFuture(interactionError("Codex runtime access is inactive"));
        }
        if (threadId != null && !threadId.isBlank() && !CodexThreadOwnerRegistry.claim(
                this.ownerScope, threadId, this.bridgeOwnerId).acquired()) {
            return CompletableFuture.completedFuture(interactionError("Codex thread is already owned by another window"));
        }
        CompletableFuture<JsonObject> preconnect = this.runCodexLifecycleOperation(
                "codex.preconnect", channelId, cwd, threadId);
        // The lifecycle operation registers the channel epoch synchronously; scope
        // the failure cleanup to that epoch so a newer session reusing the channel
        // id is never wiped by a stale preconnect finishing late.
        String sessionEpoch = this.runtimeSessionEpochs.get(safeChannelId(channelId));
        return preconnect.whenComplete((result, error) -> {
            if ((error != null || result != null && result.has("error"))
                    && java.util.Objects.equals(sessionEpoch, this.runtimeSessionEpochs.get(safeChannelId(channelId)))) {
                this.daemonCoordinator.shutdownDaemon();
                this.forgetChannelState(channelId, threadId, sessionEpoch);
            }
        });
    }

    /**
     * Read a native app-server catalog or history resource without starting a
     * turn or entering the send FIFO.
     *
     * @param method daemon read-only method, for example {@code codex.listThreads}
     * @param channelId chat host identifier
     * @param cwd effective working directory
     * @param threadId optional native thread id
     * @param requestParams method-specific native parameters
     * @return future containing the native result or an {@code error} field
     */
    public CompletableFuture<JsonObject> readCodexNative(
            String method,
            String channelId,
            String cwd,
            String threadId,
            JsonObject requestParams
    ) {
        if (!this.isCodexRuntimeAccessAllowed()) {
            return CompletableFuture.completedFuture(
                    interactionError("Codex runtime access is inactive"));
        }
        DaemonBridge daemon = this.daemonCoordinator.getDaemonBridge();
        if (daemon == null) {
            return CompletableFuture.completedFuture(
                    interactionError("Codex app-server daemon is unavailable"));
        }
        String safeChannelId = channelId == null || channelId.trim().isEmpty()
                ? "codex" : channelId.trim();
        JsonObject params = new JsonObject();
        params.addProperty("channelId", safeChannelId);
        params.addProperty("cwd", cwd == null ? "" : cwd);
        params.addProperty("threadId", threadId == null ? "" : threadId);
        params.addProperty("sessionEpoch", this.runtimeSessionEpochs.computeIfAbsent(
                safeChannelId, ignored -> UUID.randomUUID().toString()));
        try {
            this.captureRuntimeConfiguration(params);
        } catch (Exception error) {
            // Contract: failures must surface through the future, not as a
            // synchronous throw that bypasses the caller's whenComplete.
            return CompletableFuture.completedFuture(
                    interactionError(error.getMessage() == null
                            ? "Codex provider configuration could not be captured"
                            : error.getMessage()));
        }
        if (requestParams != null) {
            params.add("params", requestParams.deepCopy());
        }
        long timeoutMs = "codex.readHistoryPage".equals(method) || "codex.readSubagent".equals(method) ? 120_000L : 30_000L;
        return CompletableFuture.supplyAsync(() -> this.appServerRequestExecutor
                .sendReadOnlyCommand(daemon, method, params, timeoutMs),
                CodexAppServerRequestExecutor.turnWaitExecutor());
    }

    /**
     * Release a native thread relation while retaining persisted history.
     *
     * @param channelId chat host identifier
     * @param cwd working directory used to locate the runtime session
     * @param threadId native thread id
     * @return future completed after the relation is drained
     */
    public CompletableFuture<JsonObject> releaseCodexThread(String channelId, String cwd, String threadId) {
        CompletableFuture<JsonObject> release = runCodexLifecycleOperation(
                "codex.releaseThread", channelId, cwd, threadId);
        String sessionEpoch = this.runtimeSessionEpochs.get(safeChannelId(channelId));
        return release.whenComplete((result, error) -> {
            if (error != null || (result != null && result.has("error"))) {
                this.daemonCoordinator.shutdownDaemon();
            }
            this.forgetChannelState(channelId, threadId, sessionEpoch);
        });
    }

    /**
     * Clears channel-scoped runtime state, but only when the given epoch still
     * owns the channel. Release/preconnect complete asynchronously; without the
     * epoch check a late completion could erase the callbacks and epoch a newer
     * session on the same channel id already registered.
     */
    private void forgetChannelState(String channelId, String threadId, String sessionEpoch) {
        String stateChannelId = safeChannelId(channelId);
        String currentEpoch = this.runtimeSessionEpochs.get(stateChannelId);
        boolean ownsChannelEpoch = java.util.Objects.equals(sessionEpoch, currentEpoch);
        if (ownsChannelEpoch) {
            this.activeCallbacks.remove(stateChannelId);
            this.callbackSubscriptions.remove(stateChannelId);
            this.runtimeSessionEpochs.remove(stateChannelId);
            this.runtimeGenerations.remove(stateChannelId);
            this.interactionRegistry.clearSession(stateChannelId, currentEpoch);
        }
        // A late release must not drop a same-thread ownership claimed by a
        // newer session after this operation started.
        if (threadId != null && ownsChannelEpoch) {
            CodexThreadOwnerRegistry.releaseRelation(this.ownerScope, threadId, this.bridgeOwnerId);
        }
    }

    private static String safeChannelId(String channelId) {
        return channelId == null || channelId.trim().isEmpty() ? "codex" : channelId.trim();
    }

    private CompletableFuture<JsonObject> runCodexLifecycleOperation(
            String method,
            String channelId,
            String cwd,
            String threadId
    ) {
        boolean releasing = "codex.releaseThread".equals(method);
        if (!releasing && !this.isCodexRuntimeAccessAllowed()) {
            return CompletableFuture.completedFuture(interactionError("Codex runtime access is inactive"));
        }
        DaemonBridge daemon = releasing ? this.daemonCoordinator.getCurrentDaemonBridge()
                : this.daemonCoordinator.getDaemonBridge();
        if (daemon == null) {
            if (releasing) {
                return CompletableFuture.completedFuture(new JsonObject());
            }
            return CompletableFuture.completedFuture(
                    interactionError("Codex app-server daemon is unavailable"));
        }
        String safeChannelId = channelId == null || channelId.trim().isEmpty()
                ? "codex" : channelId.trim();
        JsonObject params = new JsonObject();
        params.addProperty("channelId", safeChannelId);
        params.addProperty("cwd", cwd == null ? "" : cwd);
        params.addProperty("threadId", threadId == null ? "" : threadId);
        params.addProperty("sessionEpoch", this.runtimeSessionEpochs.computeIfAbsent(
                safeChannelId, ignored -> UUID.randomUUID().toString()));
        if (!releasing) {
            try {
                this.captureRuntimeConfiguration(params);
            } catch (Exception error) {
                // Fail through the future so lifecycle callers' whenComplete chains run.
                return CompletableFuture.completedFuture(
                        interactionError(error.getMessage() == null
                                ? "Codex provider configuration could not be captured"
                                : error.getMessage()));
            }
        }
        // Bootstrap and unload must finish before Java declares the writer safe to release.
        return this.appServerRequestExecutor.sendLongOperationCommand(daemon, method, params);
    }

    private boolean isCodexRuntimeAccessAllowed() {
        try {
            String mode = this.settingsService.getCodexRuntimeAccessMode();
            return isCodexRuntimeAccessAllowed(mode);
        } catch (Exception e) {
            LOG.warn("[Codex] Failed to resolve runtime access mode: " + e.getMessage());
            return false;
        }
    }

    /** Returns whether an authorized runtime access mode may start app-server. */
    static boolean isCodexRuntimeAccessAllowed(String accessMode) {
        return CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED.equals(accessMode)
                || CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN.equals(accessMode);
    }

    private CompletableFuture<JsonObject> runCodexLongOperation(
            String method,
            String channelId,
            String cwd,
            String threadId,
            MessageCallback callback
    ) {
        if (!this.isCodexRuntimeAccessAllowed()) {
            return CompletableFuture.completedFuture(interactionError("Codex runtime access is inactive"));
        }
        if (threadId != null && !threadId.isBlank() && !CodexThreadOwnerRegistry.claim(
                this.ownerScope, threadId, this.bridgeOwnerId).acquired()) {
            return CompletableFuture.completedFuture(interactionError("Codex thread is already owned by another window"));
        }
        DaemonBridge daemon = this.daemonCoordinator.getDaemonBridge();
        if (daemon == null) {
            CodexThreadOwnerRegistry.release(this.ownerScope, threadId, this.bridgeOwnerId);
            return CompletableFuture.completedFuture(
                    interactionError("Codex app-server daemon is unavailable"));
        }
        String safeChannelId = channelId == null || channelId.trim().isEmpty()
                ? "codex" : channelId.trim();
        JsonObject params = new JsonObject();
        params.addProperty("channelId", safeChannelId);
        params.addProperty("cwd", cwd == null ? "" : cwd);
        params.addProperty("threadId", threadId == null ? "" : threadId);
        params.addProperty("sessionEpoch", this.runtimeSessionEpochs.computeIfAbsent(
                safeChannelId, ignored -> UUID.randomUUID().toString()));
        try {
            this.captureRuntimeConfiguration(params);
        } catch (Exception error) {
            CodexThreadOwnerRegistry.release(this.ownerScope, threadId, this.bridgeOwnerId);
            return CompletableFuture.completedFuture(interactionError(error.getMessage()));
        }
        if (callback != null) {
            // Restoring history does not start a send, so it has no send-created subscription.
            this.callbackSubscriptions.put(safeChannelId, callback);
            // Stream-end unlocks controls before the previous send RPC drains.
            // Its trailing receiver must not intercept this control's approvals.
            this.activeCallbacks.put(safeChannelId, callback);
        }
        MessageCallback operationCallback = callback != null ? callback : this.callbackSubscriptions.get(safeChannelId);
        return this.dispatchCodexLongOperation(daemon, method, params, operationCallback)
                .thenApply(acknowledgement -> {
                    if (!acknowledgement.has("error")) {
                        acknowledgement.addProperty("method", method);
                    }
                    return acknowledgement;
                }).whenComplete((response, failure) -> {
                    if (callback != null) {
                        this.activeCallbacks.remove(safeChannelId, callback);
                    }
                    if ((failure != null || response != null && response.has("error"))
                            && java.util.Objects.equals(nativeString(params, "sessionEpoch"), this.runtimeSessionEpochs.get(safeChannelId))) {
                        // Failed bootstrap releases only this operation's lease, preserving a loaded writer's claims.
                        CodexThreadOwnerRegistry.release(this.ownerScope, threadId, this.bridgeOwnerId);
                    }
                });
    }

    private JsonObject sendCodexControl(
            String method,
            String channelId,
            String cwd,
            Consumer<JsonObject> payloadWriter
    ) {
        if ("codex.updateSettings".equals(method) && !this.isCodexRuntimeAccessAllowed()) {
            return interactionError("Codex runtime access is inactive");
        }
        DaemonBridge daemon = this.daemonCoordinator.getCurrentDaemonBridge();
        if (daemon == null) {
            JsonObject error = new JsonObject();
            error.addProperty("error", "Codex app-server daemon is unavailable");
            return error;
        }
        String safeChannelId = channelId == null || channelId.trim().isEmpty()
                ? "codex" : channelId.trim();
        JsonObject params = new JsonObject();
        params.addProperty("channelId", safeChannelId);
        params.addProperty("cwd", cwd == null ? "" : cwd);
        String sessionEpoch = this.runtimeSessionEpochs.computeIfAbsent(
                safeChannelId, ignored -> UUID.randomUUID().toString());
        params.addProperty("sessionEpoch", sessionEpoch);
        payloadWriter.accept(params);
        return this.appServerRequestExecutor.sendControlCommand(daemon, method, params, 10_000L);
    }

    private void captureRuntimeConfiguration(JsonObject params) {
        // Managed credentials never travel per request: the daemon resolves them
        // from its sanitized environment (config.toml env_key, see
        // codex-native-runtime-config.js). Only the auth mode and a provider
        // revision hash travel here, so a provider change rebuilds the runtime.
        params.addProperty("authMode", this.isCodexCliLoginActive() ? "cli_login" : "managed");
        try {
            JsonObject provider = this.settingsService.getActiveCodexProvider();
            if (provider != null) {
                byte[] digest = java.security.MessageDigest.getInstance("SHA-256").digest(
                        provider.toString().getBytes(StandardCharsets.UTF_8));
                params.addProperty("providerRevision", java.util.HexFormat.of().formatHex(digest));
            }
        } catch (Exception error) {
            throw new IllegalStateException("Codex provider configuration could not be captured", error);
        }
    }

    private CompletableFuture<JsonObject> dispatchCodexLongOperation(
            DaemonBridge daemon, String method, JsonObject params, MessageCallback callback
    ) {
        SDKResult streamed = new SDKResult();
        StringBuilder content = new StringBuilder();
        AtomicBoolean hadError = new AtomicBoolean();
        AtomicReference<String> nodeError = new AtomicReference<>();
        return this.appServerRequestExecutor.sendLongOperationCommand(daemon, method, params,
                line -> {
                    if (callback != null) {
                        this.processOutputLine(line, callback, streamed, content, hadError, nodeError);
                    }
                }).handle((result, failure) -> {
                    if (failure != null) {
                        Throwable cause = failure;
                        while ((cause instanceof java.util.concurrent.CompletionException
                                || cause instanceof java.util.concurrent.ExecutionException) && cause.getCause() != null) {
                            cause = cause.getCause();
                        }
                        result = interactionError(cause.getMessage() == null ? "Codex operation failed" : cause.getMessage());
                    }
                    if (callback != null) {
                        boolean cancelled = List.of("interrupted", "cancelled").contains(String.valueOf(nativeString(result, "outcome")));
                        if (result.has("error") && !cancelled) {
                            callback.onError(result.get("error").getAsString());
                            result.addProperty("errorReported", true);
                        } else {
                            streamed.success = !cancelled && !result.has("error");
                            callback.onComplete(streamed);
                        }
                    }
                    return result;
                });
    }

    private static String nativeString(JsonObject object, String name) {
        JsonElement value = object.get(name);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }

    /** Identifies the daemon process that produced a native runtime generation. */
    record RuntimeGenerationScope(long daemonStartGeneration, long processGeneration, String runtimeGeneration) {
    }

    /**
     * A runtime generation only ever counts up inside one daemon process, so a
     * lower value from the SAME process is a trailing event from a runtime that
     * process already replaced. A lower value from a DIFFERENT process is the
     * first event of a restarted daemon (the counter restarts there) and must
     * be delivered, not dropped.
     */
    static boolean isStaleRuntimeEvent(RuntimeGenerationScope previous, RuntimeGenerationScope current) {
        if (previous.daemonStartGeneration() != current.daemonStartGeneration()
                || previous.processGeneration() != current.processGeneration()) {
            return false;
        }
        long generation = parseGenerationSafely(current.runtimeGeneration());
        long previousGeneration = parseGenerationSafely(previous.runtimeGeneration());
        // Malformed values parse to Long.MAX_VALUE ("newest"); two of those are
        // incomparable, so never drop on them.
        return generation != Long.MAX_VALUE && previousGeneration != Long.MAX_VALUE
                && generation < previousGeneration;
    }

    /** Malformed generation values are treated as the newest, never fatal. */
    private static long parseGenerationSafely(String generation) {
        if (generation == null) {
            return Long.MIN_VALUE;
        }
        try {
            return Long.parseLong(generation);
        } catch (NumberFormatException error) {
            return Long.MAX_VALUE;
        }
    }

    /**
     * Get persisted Codex session history messages.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        return this.getSessionMessages(sessionId, cwd, null);
    }

    /** Reads native history on the chat host, with an explicit offline-only legacy fallback. */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd, String channelId) {
        if (this.nativeHistoryEnabled && this.isCodexRuntimeAccessAllowed()) {
            try {
                CodexNativeHistoryReader reader = new CodexNativeHistoryReader(this, channelId, cwd, sessionId);
                List<List<JsonObject>> pages = new java.util.ArrayList<>();
                java.util.Set<JsonElement> cursors = new java.util.HashSet<>();
                JsonElement cursor = null;
                do {
                    CodexNativeHistoryReader.Page page = reader.readPage(cursor, 100);
                    pages.add(page.messages());
                    cursor = page.cursor();
                    if (cursor != null && !cursor.isJsonNull() && !cursors.add(cursor)) {
                        throw new IllegalStateException("Native Codex history repeated its cursor");
                    }
                } while (cursor != null && !cursor.isJsonNull());
                List<JsonObject> messages = new java.util.ArrayList<>();
                java.util.Map<String, Integer> identityPositions = new java.util.HashMap<>();
                for (int index = pages.size() - 1; index >= 0; index--) {
                    for (JsonObject message : pages.get(index)) {
                        String identity = com.github.claudecodegui.session.CodexHistoryMerger.identity(message.getAsJsonObject("raw"));
                        Integer existing = identity == null ? null : identityPositions.get(identity);
                        if (existing != null) {
                            // Pages walk newest→oldest, so this later occurrence is
                            // the fresher snapshot of the same item — same upsert
                            // rule as the Node-side page merger.
                            messages.set(existing, message);
                        } else {
                            if (identity != null) {
                                identityPositions.put(identity, messages.size());
                            }
                            messages.add(message);
                        }
                    }
                }
                try {
                    List<JsonObject> legacy = this.getLegacySessionMessages(sessionId);
                    if (CodexNativeHistoryReader.countBlocks(messages, "tool_use") < CodexNativeHistoryReader.countBlocks(legacy, "tool_use")
                            || CodexNativeHistoryReader.countBlocks(messages, "thinking") < CodexNativeHistoryReader.countBlocks(legacy, "thinking")
                            || (!CodexNativeHistoryReader.hasUsage(messages) && CodexNativeHistoryReader.hasUsage(legacy))
                            || CodexNativeHistoryReader.countCompactions(messages) < CodexNativeHistoryReader.countCompactions(legacy)
                            || CodexNativeHistoryReader.countTimedCompactions(messages) < CodexNativeHistoryReader.countTimedCompactions(legacy)
                            || countHistoryUsers(legacy) > countHistoryUsers(messages)) {
                        return legacy;
                    }
                } catch (Exception unavailable) {
                    LOG.debug("Legacy transcript is unavailable; retaining the native history source");
                }
                return messages;
            } catch (Exception error) {
                if (!CodexNativeHistoryReader.permitsOfflineFallback(error.getMessage())) {
                    throw new IllegalStateException("Native Codex history failed", error);
                }
            }
        }
        try {
            return this.getLegacySessionMessages(sessionId);
        } catch (Exception e) {
            LOG.warn("Failed to load Codex session history: " + e.getMessage(), e);
            throw new IllegalStateException("Codex history is unavailable", e);
        }
    }

    private List<JsonObject> getLegacySessionMessages(String sessionId) {
        JsonArray items = this.gson.fromJson(this.historyReader.getSessionMessagesAsJson(sessionId), JsonArray.class);
        return items == null ? List.of() : HistoryMessageInjector.convertCodexMessagesToFrontendBatch(items);
    }

    private static boolean hasHistoryBlock(List<JsonObject> messages, String type) {
        for (JsonObject message : messages) {
            for (JsonElement block : historyBlocks(message)) {
                if (block.isJsonObject() && type.equals(nativeString(block.getAsJsonObject(), "type"))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static long countHistoryUsers(List<JsonObject> messages) {
        return messages.stream().filter(message -> "user".equals(nativeString(message, "type")))
                .filter(message -> hasHistoryBlock(List.of(message), "text") || hasHistoryBlock(List.of(message), "image")).count();
    }

    private static JsonArray historyBlocks(JsonObject message) {
        JsonObject raw = message.getAsJsonObject("raw");
        if (raw == null) {
            return new JsonArray();
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            raw = raw.getAsJsonObject("message");
        }
        return raw.has("content") && raw.get("content").isJsonArray() ? raw.getAsJsonArray("content") : new JsonArray();
    }

    /**
     * Gets the tool list for the specified Codex MCP server.
     */
    public CompletableFuture<JsonObject> getMcpServerTools(String serverId, JsonObject serverConfig) {
        String cwd = serverConfig == null ? null : nativeString(serverConfig, "cwd");
        return this.getMcpServerTools(serverId, null, cwd, null);
    }

    /** Returns the effective native MCP tool catalog without creating an agent turn. */
    public CompletableFuture<JsonObject> getMcpServerTools(String serverId, String channelId, String cwd, String threadId) {
        return this.readCodexMcpStatus(channelId, cwd, threadId).thenApply(catalog -> {
            JsonObject result = new JsonObject();
            result.addProperty("serverId", serverId);
            JsonArray tools = new JsonArray();
            if (catalog.has("error")) {
                result.add("error", catalog.get("error").deepCopy());
            } else if (catalog.has("data")) {
                boolean found = false;
                for (JsonElement entry : catalog.getAsJsonArray("data")) {
                    JsonObject server = entry.getAsJsonObject();
                    if (!serverId.equals(nativeString(server, "name"))) {
                        continue;
                    }
                    found = true;
                    if (server.has("tools") && server.get("tools").isJsonObject()) {
                        for (var tool : server.getAsJsonObject("tools").entrySet()) {
                            JsonObject value = tool.getValue().getAsJsonObject().deepCopy();
                            if (!value.has("name")) {
                                value.addProperty("name", tool.getKey());
                            }
                            tools.add(value);
                        }
                    }
                    if (server.has("toolsError") && !server.get("toolsError").isJsonNull()) {
                        result.add("error", server.get("toolsError").deepCopy());
                    }
                }
                if (!found) {
                    result.addProperty("error", "Server is absent from the effective native MCP catalog");
                }
            }
            result.add("tools", tools);
            return result;
        });
    }

    /** Collects the current native MCP inventory, retaining opaque pagination and errors. */
    public CompletableFuture<JsonObject> readCodexMcpStatus(String channelId, String cwd, String threadId) {
        // Blocking waits must happen on the dedicated turn-wait executor, never
        // on CompletableFuture's common pool (see CodexAppServerRequestExecutor).
        return CompletableFuture.supplyAsync(() -> {
            JsonArray data = new JsonArray();
            JsonElement cursor = null;
            Set<JsonElement> seen = new HashSet<>();
            try {
                do {
                    JsonObject params = new JsonObject();
                    if (cursor != null) {
                        params.add("cursor", cursor.deepCopy());
                    }
                    JsonObject page;
                    try {
                        page = this.readCodexNative("codex.getMcpStatus", channelId, cwd, threadId, params)
                                .get(35_000L, java.util.concurrent.TimeUnit.MILLISECONDS);
                    } catch (java.util.concurrent.TimeoutException timeout) {
                        return interactionError("Timed out reading the native MCP status");
                    } catch (java.util.concurrent.ExecutionException failed) {
                        return interactionError(String.valueOf(
                                failed.getCause() == null ? failed : failed.getCause()));
                    }
                    if (page.has("error")) {
                        return page;
                    }
                    if (page.has("data") && page.get("data").isJsonArray()) {
                        data.addAll(page.getAsJsonArray("data"));
                    }
                    cursor = page.get("nextCursor");
                    if (cursor != null && !cursor.isJsonNull() && !seen.add(cursor)) {
                        throw new IllegalStateException("Native MCP catalog repeated its cursor");
                    }
                } while (cursor != null && !cursor.isJsonNull());
                JsonObject result = new JsonObject();
                result.add("data", data);
                return result;
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return interactionError("Interrupted while reading the native MCP status");
            } catch (Exception error) {
                return interactionError(error.getMessage());
            }
        }, CodexAppServerRequestExecutor.turnWaitExecutor());
    }

    // ============================================================================
    // Utility methods
    // ============================================================================

    /**
     * Build Codex-compatible attachments array.
     * Native localImage input requires local paths rather than base64 data.
     * Images remain in the application data directory because Codex history stores these paths.
     *
     * @param attachments List of attachments from the UI
     * @return attachment entries normalized to localImage by the native bridge
     */
    JsonArray buildCodexAttachments(List<ClaudeSession.Attachment> attachments) {
        JsonArray result = new JsonArray();

        if (attachments == null || attachments.isEmpty()) {
            return result;
        }

        try {
            java.nio.file.Files.createDirectories(imageStorageDir);
        } catch (Exception e) {
            LOG.warn("[Codex] Failed to create image storage directory: " + e.getMessage());
            return result;
        }

        for (ClaudeSession.Attachment attachment : attachments) {
            if (attachment == null) { continue; }

            String type = attachment.mediaType;
            String data = attachment.data;

            // Only process image types
            if (type == null || !type.startsWith("image/") || data == null) {
                LOG.debug("[Codex] Skipping non-image attachment: " + type);
                continue;
            }

            try {
                // Determine file extension from MIME type
                String extension = getImageExtension(type);

                // Generate unique filename
                String filename = "codex-img-" + System.currentTimeMillis() + "-" +
                                  java.util.UUID.randomUUID().toString().substring(0, 8) + extension;
                Path imagePath = this.imageStorageDir.resolve(filename);

                // Decode base64 and write to file
                byte[] imageBytes = java.util.Base64.getDecoder().decode(data);
                java.nio.file.Files.write(imagePath, imageBytes);

                LOG.info("[Codex] Saved history image: " + imagePath.toAbsolutePath() +
                         " (" + imageBytes.length + " bytes)");

                // Add to result array in Codex SDK format
                JsonObject imageEntry = new JsonObject();
                imageEntry.addProperty("type", "local_image");
                imageEntry.addProperty("path", imagePath.toAbsolutePath().toString());
                result.add(imageEntry);

            } catch (Exception e) {
                LOG.warn("[Codex] Failed to process image attachment: " + e.getMessage());
            }
        }

        return result;
    }

    /**
     * Get file extension from MIME type.
     */
    private String getImageExtension(String mimeType) {
        if (mimeType == null) { return ".png"; }

        switch (mimeType.toLowerCase()) {
            case "image/jpeg":
            case "image/jpg":
                return ".jpg";
            case "image/gif":
                return ".gif";
            case "image/webp":
                return ".webp";
            case "image/bmp":
                return ".bmp";
            case "image/svg+xml":
                return ".svg";
            case "image/png":
            default:
                return ".png";
        }
    }

    private String extractAssistantText(JsonObject msg) {
        if (msg == null) { return ""; }
        if (!msg.has("message") || !msg.get("message").isJsonObject()) { return ""; }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) { return ""; }

        JsonElement contentEl = message.get("content");
        if (contentEl.isJsonPrimitive()) {
            return contentEl.getAsString();
        }
        if (!contentEl.isJsonArray()) {
            return "";
        }

        JsonArray arr = contentEl.getAsJsonArray();
        StringBuilder sb = new StringBuilder();
        for (JsonElement el : arr) {
            if (!el.isJsonObject()) { continue; }
            JsonObject block = el.getAsJsonObject();
            if (!block.has("type") || block.get("type").isJsonNull()) { continue; }
            String type = block.get("type").getAsString();
            if ("text".equals(type) && block.has("text") && !block.get("text").isJsonNull()) {
                if (sb.length() > 0) { sb.append("\n"); }
                sb.append(block.get("text").getAsString());
            }
        }
        return sb.toString();
    }
    /**
     * Check if Codex CLI Login provider is currently active by reading config.json directly.
     */
    private boolean isCodexCliLoginActive() {
        try {
            return CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN
                    .equals(this.settingsService.getCodexRuntimeAccessMode());
        } catch (Exception e) {
            LOG.debug("[Codex] Failed to check CLI login status: " + e.getMessage());
            return false;
        }
    }

    private static String resolveOwnerScope() {
        String codexHome = System.getenv("CODEX_HOME");
        return codexHome == null || codexHome.trim().isEmpty() ? "default" : codexHome.trim();
    }

    /**
     * Stop the Codex daemon and release its app-server child.
     *
     * <p>The daemon owns the native writer and interaction registries, so
     * disposing the bridge must drain that coordinator before the legacy
     * channel process registry is cleared.</p>
     */
    @Override
    public void cleanupAllProcesses() {
        this.daemonCoordinator.shutdownDaemon();
        super.cleanupAllProcesses();
        this.activeCallbacks.clear();
        this.callbackSubscriptions.clear();
        this.runtimeSessionEpochs.clear();
        this.runtimeGenerations.clear();
        this.interactionRegistry.clear();
        CodexThreadOwnerRegistry.releaseOwner(this.bridgeOwnerId);
    }
}
