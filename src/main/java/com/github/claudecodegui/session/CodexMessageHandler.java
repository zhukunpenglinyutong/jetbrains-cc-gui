package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.util.UsageCostCalculator;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Codex message callback handler.
 * Processes messages returned by Codex AI.
 * Similar to ClaudeMessageHandler but handles Codex's simpler message format,
 * primarily dealing with streaming text output.
 */
public class CodexMessageHandler implements MessageCallback {
    /**
     * log.
     */
    private static final Logger LOG = Logger.getInstance(CodexMessageHandler.class);

    /**
     * state.
     */
    private final SessionState state;
    private final Object turnOwner;
    private final String runtimeSessionEpoch;
    private final CompletableFuture<Void> turnCompletion;
    /**
     * callback handler.
     */
    private final CallbackHandler callbackHandler;
    private final boolean reportStateErrors;
    private final String clientMessageId;
    /**
     * message merger.
     */
    private final MessageMerger messageMerger = new MessageMerger();

    /** Stable native item id to the message already materialized in the session. */
    private final Map<String, Message> nativeItemMessages = new HashMap<>();

    /**
     * assistant content.
     */ // Content accumulator for the current assistant message
    private final StringBuilder assistantContent = new StringBuilder();

    /**
     * current assistant message.
     */ // Current assistant message object being processed
    private Message currentAssistantMessage = null;

    /**
     * is streaming.
     */
    private boolean isStreaming = false;
    /**
     * stream ended this turn.
     */
    private boolean streamEndedThisTurn = false;

    private com.google.gson.JsonObject currentTurnContextUsage;

    /**
     * Constructor.
     *
     * @param state state
     * @param callbackHandler callback handler
     * @since 1.0.0
     */
    public CodexMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        this(state, callbackHandler, true, null, state.getTurnOwner(), null);
    }

    /**
     * Control receivers omit duplicate error toasts while retaining turn fencing.
     */
    CodexMessageHandler(SessionState state, CallbackHandler callbackHandler, boolean reportStateErrors) {
        this(state, callbackHandler, reportStateErrors, null, state.getTurnOwner(), null);
    }

    CodexMessageHandler(SessionState state, CallbackHandler callbackHandler, String clientMessageId) {
        this(state, callbackHandler, true, clientMessageId, state.getTurnOwner(), null);
    }

    CodexMessageHandler(SessionState state, CallbackHandler callbackHandler, CompletableFuture<Void> turnCompletion) {
        this(state, callbackHandler, true, null, state.getTurnOwner(), turnCompletion);
    }

    CodexMessageHandler(SessionState state, CallbackHandler callbackHandler, String clientMessageId, CompletableFuture<Void> turnCompletion) {
        this(state, callbackHandler, true, clientMessageId, state.getTurnOwner(), turnCompletion);
    }

    private CodexMessageHandler(SessionState state, CallbackHandler callbackHandler,
                                boolean reportStateErrors, String clientMessageId, Object turnOwner, CompletableFuture<Void> turnCompletion) {
        this.state = state;
        this.turnOwner = turnOwner;
        this.runtimeSessionEpoch = state.getRuntimeSessionEpoch();
        this.callbackHandler = callbackHandler;
        this.turnCompletion = turnCompletion;
        this.reportStateErrors = reportStateErrors;
        this.clientMessageId = clientMessageId;
    }

    /**
     * Handle a received message by dispatching to the appropriate handler based on type.
     *
     * @param type type
     * @param content content
     * @since 1.0.0
     */
    @Override
    public void onMessage(String type, String content) {
        synchronized (state.getMessageStateLock()) {
            if (!ownsCurrentTurn()) {
                return;
            }
            // [FIX] Handle multiple message types
            // Codex message-service.js sends:
            // - type='assistant': contains thinking, tool_use, text
            // - type='user': contains tool_result
            LOG.debug("CodexMessageHandler.onMessage: type=" + type + ", content length=" + (content != null ? content.length() : 0));

            if ("assistant".equals(type)) {
                // Handle assistant message (thinking, tool_use, text)
                handleAssistantMessage(content);
            } else if ("user".equals(type)) {
                // Handle user message (tool_result)
                handleUserMessage(content);
            } else if ("result".equals(type)) {
                // Handle result message (usage stats, etc.)
                handleResultMessage(content);
            } else if ("session_id".equals(type)) {
                // Handle session_id/thread_id (for session recovery)
                handleSessionId(content);
            } else if ("event_msg".equals(type)) {
                handleEventMessage(content);
            } else if ("stream_start".equals(type)) {
                handleStreamStart();
            } else if ("stream_end".equals(type)) {
                handleStreamEnd();
            } else if ("thinking_delta".equals(type)) {
                handleThinkingDelta(content);
            } else if ("content_delta".equals(type) || "content".equals(type)) {
                // Handle streaming content delta (legacy format, kept for compatibility)
                // content_delta: streaming incremental
                // content: complete content block
                handleContentDelta(content);
            } else if ("status".equals(type)) {
                if (content != null && !content.trim().isEmpty()) {
                    callbackHandler.notifyStatusMessage(content);
                }
            } else if ("message_end".equals(type)) {
                handleMessageEnd();
            } else if ("codex_runtime_event".equals(type)) {
                JsonObject event = new com.google.gson.Gson().fromJson(content, JsonObject.class);
                if (event != null && event.has("kind") && "thread/settings/updated".equals(event.get("kind").getAsString())
                        && event.has("threadId") && !event.get("threadId").isJsonNull()
                        && event.get("threadId").getAsString().equals(this.state.getSessionId())
                        && event.has("payload") && event.get("payload").isJsonObject()) {
                    JsonObject settings = event.getAsJsonObject("payload");
                    if (!this.state.isCodexCwdExplicit() && settings.has("cwd") && settings.get("cwd").isJsonPrimitive()) {
                        this.state.setCwd(settings.get("cwd").getAsString());
                    }
                }
                callbackHandler.notifyCodexRuntimeEvent(content);
            } else {
                LOG.debug("CodexMessageHandler: Unhandled message type: " + type);
            }
        }
        // Complete outside the session lock: consumers may perform IPC or start another turn.
        // MESSAGE_END follows the final text (including the no-response fallback), unlike STREAM_END.
        if ("message_end".equals(type) && turnCompletion != null) {
            turnCompletion.complete(null);
        }
    }

    /**
     * Handle an error from the SDK.
     *
     * @param error error
     * @since 1.0.0
     */
    @Override
    public void onError(String error) {
        synchronized (state.getMessageStateLock()) {
            if (!ownsCurrentTurn()) {
                return;
            }
            isStreaming = false;
            streamEndedThisTurn = false;
            state.setError(error);
            state.setBusy(false);
            state.setLoading(false);

            Message errorMessage = new Message(Message.Type.ERROR, error);
            if (this.clientMessageId != null) {
                // A failed startup may reach the page without its user-message prefix.
                errorMessage.raw = new JsonObject();
                errorMessage.raw.addProperty("clientMessageId", this.clientMessageId);
            }
            state.addMessage(errorMessage);

            // Signal stream-end BEFORE pushing the error snapshot (mirrors the PR #1421
            // fix in ClaudeMessageHandler.onError). The webview's onStreamEnd cancels any
            // pending updateMessages rAF; pushing the error snapshot first lets that
            // cancellation drop it, so the "API request failed" bubble never renders.
            // Ending the stream first lets the subsequent snapshot land normally.
            //
            // The page starts waiting optimistically before the native stream exists.
            // Startup and writer errors must end that wait too.
            this.callbackHandler.notifyStreamEnd();
            callbackHandler.notifyMessageUpdate(state.getMessages());
            resetStreamingAccumulator();
            // Controls already report the error in the transcript; a state error would also trigger a toast.
            this.callbackHandler.notifyStateChange(this.state.isBusy(), this.state.isLoading(),
                    this.reportStateErrors ? this.state.getError() : null);
        }
        if (turnCompletion != null) {
            turnCompletion.completeExceptionally(new IllegalStateException(error));
        }
    }

    /**
     * Handle completion of a response turn.
     *
     * @param result result
     * @since 1.0.0
     */
    @Override
    public void onComplete(SDKResult result) {
        synchronized (state.getMessageStateLock()) {
            if (!ownsCurrentTurn()) {
                return;
            }
            boolean streamEndedBeforeComplete = streamEndedThisTurn;
            boolean wasStreaming = isStreaming;

            isStreaming = false;
            streamEndedThisTurn = false;
            state.setBusy(false);
            state.setLoading(false);
            state.updateLastModifiedTime();

            if (wasStreaming && !streamEndedBeforeComplete) {
                LOG.warn("Codex onComplete called without prior stream_end; forcing stream cleanup");
                callbackHandler.notifyMessageUpdate(state.getMessages());
                callbackHandler.notifyStreamEnd();
            }

            resetStreamingAccumulator();
            callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
        }
        if (turnCompletion != null) {
            turnCompletion.complete(null);
        }
    }

    // ===== Private methods =====

    private boolean ownsCurrentTurn() {
        return this.state.isCurrentTurn(this.turnOwner)
                && this.runtimeSessionEpoch.equals(this.state.getRuntimeSessionEpoch())
                && (this.turnCompletion == null || !this.turnCompletion.isDone());
    }

    /**
     * Handle a complete assistant message in JSON format.
     * Contains thinking, tool_use, text, and other content types.
     *
     * @param jsonContent json content
     * @since 1.0.0
     */
    private void handleAssistantMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);

            // Apply v0.1.3-codex filtering logic
            Message parsed = parseServerMessage(msgJson, Message.Type.ASSISTANT);
            if (parsed == null) {
                LOG.debug("Codex assistant message filtered out");
                return;
            }

            String nativeItemId = nativeItemId(parsed.raw);
            Message existingNativeMessage = nativeItemId == null
                    ? null : nativeItemMessages.get(nativeItemId);
            if (existingNativeMessage != null) {
                if (isAuthoritativeSnapshot(parsed.raw)) {
                    existingNativeMessage.content = parsed.content;
                    existingNativeMessage.raw = parsed.raw;
                } else {
                    existingNativeMessage.content = parsed.content;
                    existingNativeMessage.raw = messageMerger.mergeAssistantMessage(
                            existingNativeMessage.raw, parsed.raw);
                }
                currentAssistantMessage = existingNativeMessage;
                assistantContent.setLength(0);
                assistantContent.append(existingNativeMessage.content != null
                        ? existingNativeMessage.content : "");
            } else if (currentAssistantMessage != null
                    && (nativeItemId == null || nativeItemId(currentAssistantMessage.raw) == null)) {
                // A legacy delta placeholder has no native id. Adopt it when
                // the first authoritative item snapshot arrives so the UI
                // does not grow a second assistant bubble.
                com.google.gson.JsonObject mergedRaw = messageMerger.mergeAssistantMessage(currentAssistantMessage.raw, parsed.raw);
                currentAssistantMessage.content = parsed.content;
                currentAssistantMessage.raw = mergedRaw;
                if (nativeItemId != null) {
                    rememberNativeItem(nativeItemId, currentAssistantMessage);
                }
                assistantContent.setLength(0);
                assistantContent.append(parsed.content != null ? parsed.content : "");
            } else {
                state.addMessage(parsed);
                if (nativeItemId != null) {
                    rememberNativeItem(nativeItemId, parsed);
                }
                currentAssistantMessage = parsed;
                assistantContent.setLength(0);
                assistantContent.append(parsed.content != null ? parsed.content : "");
            }
            callbackHandler.notifyMessageUpdate(state.getMessages());

            LOG.debug("Codex assistant message synchronized with raw JSON");
        } catch (Exception e) {
            LOG.warn("Failed to parse assistant message: " + e.getMessage());
        }
    }

    /**
     * Handle a user message (primarily tool_result).
     *
     * @param jsonContent json content
     * @since 1.0.0
     */
    private void handleUserMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);

            // Apply v0.1.3-codex filtering logic
            Message parsed = parseServerMessage(msgJson, Message.Type.USER);
            if (parsed == null) {
                LOG.debug("Codex user message filtered out");
                return;
            }

            if (!replaceOptimisticUserMessage(parsed) && !upsertNativeMessage(parsed)) {
                state.addMessage(parsed);
            }
            callbackHandler.notifyMessageUpdate(state.getMessages());

            LOG.debug("Codex user message (tool_result) added");
        } catch (Exception e) {
            LOG.warn("Failed to parse user message: " + e.getMessage());
        }
    }

    private boolean replaceOptimisticUserMessage(Message nativeMessage) {
        if (nativeMessage == null || nativeMessage.raw == null
                || !nativeMessage.raw.has("clientMessageId")
                || nativeMessage.raw.get("clientMessageId").isJsonNull()) {
            return false;
        }
        String clientMessageId = nativeMessage.raw.get("clientMessageId").getAsString();
        for (Message existing : state.getMessagesReference()) {
            if (existing.raw == null || !existing.raw.has("clientMessageId")
                    || existing.raw.get("clientMessageId").isJsonNull()) {
                continue;
            }
            if (clientMessageId.equals(existing.raw.get("clientMessageId").getAsString())) {
                this.preserveUserImages(existing.raw, nativeMessage.raw);
                existing.content = nativeMessage.content;
                existing.raw = nativeMessage.raw;
                String nativeItemId = nativeItemId(nativeMessage.raw);
                if (nativeItemId != null) {
                    rememberNativeItem(nativeItemId, existing);
                }
                return true;
            }
        }
        return false;
    }

    private void preserveUserImages(JsonObject previous, JsonObject current) {
        if (!previous.has("message") || !previous.get("message").isJsonObject()
                || !current.has("message") || !current.get("message").isJsonObject()) {
            return;
        }
        JsonObject oldMessage = previous.getAsJsonObject("message");
        JsonObject newMessage = current.getAsJsonObject("message");
        if (!oldMessage.has("content") || !oldMessage.get("content").isJsonArray()) {
            return;
        }
        JsonArray content = newMessage.has("content") && newMessage.get("content").isJsonArray()
                ? newMessage.getAsJsonArray("content") : new JsonArray();
        JsonArray combined = new JsonArray();
        for (JsonElement block : oldMessage.getAsJsonArray("content")) {
            if (block.isJsonObject() && block.getAsJsonObject().has("type")
                    && "image".equals(block.getAsJsonObject().get("type").getAsString())) {
                combined.add(block.deepCopy());
            }
        }
        if (combined.isEmpty()) {
            return;
        }
        for (JsonElement block : content) {
            if (!block.isJsonObject() || !block.getAsJsonObject().has("type")
                    || !Set.of("image", "localImage", "local_image").contains(
                            block.getAsJsonObject().get("type").getAsString())) {
                combined.add(block.deepCopy());
            }
        }
        newMessage.add("content", combined);
    }

    /** Upsert a native item that arrived without a matching optimistic bubble. */
    private boolean upsertNativeMessage(Message nativeMessage) {
        String nativeItemId = nativeItemId(nativeMessage.raw);
        if (nativeItemId == null) {
            return false;
        }
        Message existing = nativeItemMessages.get(nativeItemId);
        if (existing == null) {
            rememberNativeItem(nativeItemId, nativeMessage);
            return false;
        }
        existing.content = nativeMessage.content;
        existing.raw = isAuthoritativeSnapshot(nativeMessage.raw)
                ? nativeMessage.raw : messageMerger.mergeAssistantMessage(existing.raw, nativeMessage.raw);
        return true;
    }

    private void rememberNativeItem(String nativeItemId, Message message) {
        nativeItemMessages.put(nativeItemId, message);
        if (nativeItemMessages.size() <= 2048) {
            return;
        }
        Iterator<String> iterator = nativeItemMessages.keySet().iterator();
        if (iterator.hasNext()) {
            iterator.next();
            iterator.remove();
        }
    }

    private String nativeItemId(JsonObject raw) {
        if (raw == null || !raw.has("codexItemId") || raw.get("codexItemId").isJsonNull()) {
            return null;
        }
        String value = raw.get("codexItemId").getAsString();
        if (value.isBlank()) {
            return null;
        }
        // The bridge keeps this identity stable when a start item precedes
        // native turn discovery, so completion updates the original boundary.
        if (raw.has("uuid") && raw.get("uuid").isJsonPrimitive()) {
            return raw.get("codexThreadId") + ":" + raw.get("uuid").getAsString();
        }
        return raw.has("codexThreadId") && raw.has("codexTurnId")
                ? raw.get("codexThreadId") + ":" + raw.get("codexTurnId") + ":" + value : value;
    }

    private boolean isAuthoritativeSnapshot(JsonObject raw) {
        return raw != null && ((raw.has("codexAuthoritative")
                && raw.get("codexAuthoritative").getAsBoolean())
                || (raw.has("codexSnapshot") && raw.get("codexSnapshot").getAsBoolean()));
    }

    /**
     * Handle the session_id (Codex thread ID) for session recovery.
     *
     * @param threadId thread id
     * @since 1.0.0
     */
    private void handleSessionId(String threadId) {
        if (threadId != null && !threadId.trim().isEmpty()) {
            state.setSessionId(threadId);
            callbackHandler.notifySessionIdReceived(threadId);
            LOG.info("Captured Codex thread ID: " + threadId);
        }
    }

    /**
     * Handle the result message containing usage statistics.
     *
     * @param jsonContent json content
     * @since 1.0.0
     */
    private void handleResultMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);
            if (msgJson == null || !msgJson.has("usage") || !msgJson.get("usage").isJsonObject()) {
                return;
            }

            com.google.gson.JsonObject usage = msgJson.getAsJsonObject("usage");
            // The result message carries the turn.completed usage, which covers exactly
            // one turn but counts cached tokens inside input_tokens (OpenAI convention).
            // Normalize to the Claude usage schema (input excludes cache) and stamp it
            // as turnUsage for the per-turn token display in the webview.
            com.google.gson.JsonObject turnUsage = buildTurnUsage(usage);
            // turn.completed usage is per-turn accounting only. Some Codex SDK
            // versions expose session-cumulative values here, and the result never
            // carries the authoritative context window. Only token_count may update
            // the top-level context snapshot.
            boolean updated = attachUsageToLastAssistant(currentTurnContextUsage, turnUsage);
            if (updated) {
                callbackHandler.notifyMessageUpdate(state.getMessages());
                LOG.info("Codex usage applied from result message");
            } else {
                LOG.debug("Codex usage received but no assistant message to attach");
            }
        } catch (Exception e) {
            LOG.debug("Failed to parse Codex result message: " + e.getMessage());
        }
    }

    /**
     * Build a whole-turn usage object in the Claude usage schema from a Codex usage
     * object whose input_tokens include cached tokens.
     *
     * @param usage usage in ai-bridge Claude-compatible format (input includes cache)
     * @return turn usage with input_tokens excluding cache, cache fields separate
     * @since 1.0.0
     */
    private static com.google.gson.JsonObject buildTurnUsage(com.google.gson.JsonObject usage) {
        int input = readInt(usage, "input_tokens");
        int output = readInt(usage, "output_tokens");
        int cacheRead = readInt(usage, "cache_read_input_tokens", "cached_input_tokens");
        com.google.gson.JsonObject turnUsage = new com.google.gson.JsonObject();
        turnUsage.addProperty("input_tokens", Math.max(0, input - cacheRead));
        turnUsage.addProperty("cache_creation_input_tokens", 0);
        turnUsage.addProperty("cache_read_input_tokens", cacheRead);
        turnUsage.addProperty("output_tokens", output);
        return turnUsage;
    }

    private static int readInt(com.google.gson.JsonObject json, String... keys) {
        for (String key : keys) {
            if (json.has(key) && !json.get(key).isJsonNull()) {
                return Math.max(0, json.get(key).getAsInt());
            }
        }
        return 0;
    }

    /**
     * Handle event_msg containing token_count and other events.
     *
     * @param jsonContent json content
     * @since 1.0.0
     */
    private void handleEventMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);
            if (msgJson == null || !msgJson.has("payload") || !msgJson.get("payload").isJsonObject()) {
                return;
            }

            com.google.gson.JsonObject payload = msgJson.getAsJsonObject("payload");
            if (!payload.has("type") || !"token_count".equals(payload.get("type").getAsString())) {
                return;
            }

            if (!payload.has("info") || payload.get("info").isJsonNull() || !payload.get("info").isJsonObject()) {
                return;
            }

            com.google.gson.JsonObject info = payload.getAsJsonObject("info");
            if (!info.has("last_token_usage") || !info.get("last_token_usage").isJsonObject()) {
                // total_token_usage is cumulative across the whole session and can
                // exceed the active model window. It is valid only for Node-side
                // per-turn delta calculation, never as the current-context numerator.
                LOG.debug("Ignoring Codex token_count without last_token_usage");
                return;
            }
            com.google.gson.JsonObject contextUsage = info.getAsJsonObject("last_token_usage");

            int inputTokens = readInt(contextUsage, "input_tokens");
            int outputTokens = readInt(contextUsage, "output_tokens");
            int cachedInputTokens = readInt(contextUsage, "cached_input_tokens");

            com.google.gson.JsonObject usage = new com.google.gson.JsonObject();
            usage.addProperty("input_tokens", inputTokens);
            usage.addProperty("output_tokens", outputTokens);
            usage.addProperty("cache_read_input_tokens", cachedInputTokens);
            usage.addProperty("cache_creation_input_tokens", 0);
            int modelContextWindow = readInt(info, "model_context_window");
            if (modelContextWindow > 0) {
                usage.addProperty("model_context_window", modelContextWindow);
            }
            currentTurnContextUsage = usage.deepCopy();

            // token_count is not turn-scoped, so never stamp it as turnUsage. The latest
            // token usage is used for the context status; cumulative totals are ignored.
            boolean updated = attachUsageToLastAssistant(usage, null);
            if (updated) {
                callbackHandler.notifyMessageUpdate(state.getMessages());
                LOG.debug("Codex token_count applied: input=" + inputTokens + ", output=" + outputTokens + ", cached=" + cachedInputTokens);
            } else {
                LOG.debug("Codex token_count received but no assistant message to attach");
            }
        } catch (Exception e) {
            LOG.debug("Failed to parse Codex event_msg: " + e.getMessage());
        }
    }

    /**
     * Attach usage data to the last assistant message's raw field.
     * The top-level usage field feeds the context-usage status bar; the optional
     * turnUsage field feeds the per-turn token display in the webview.
     *
     * @param usage usage for the status bar (top-level usage field)
     * @param turnUsage whole-turn usage in Claude schema, or null to skip
     * @return boolean
     * @since 1.0.0
     */
    private boolean attachUsageToLastAssistant(com.google.gson.JsonObject usage, com.google.gson.JsonObject turnUsage) {
        java.util.List<Message> messages = state.getMessagesReference();
        for (int i = messages.size() - 1; i >= 0; i--) {
            Message msg = messages.get(i);
            if (msg.type == Message.Type.ASSISTANT && msg.raw != null) {
                if (usage != null) {
                    msg.raw.add("usage", usage);
                }
                if (turnUsage != null) {
                    msg.raw.add("turnUsage", turnUsage);
                    Double turnCostUsd = UsageCostCalculator.calculateTurnCostUsd("codex", turnUsage, state.getModel());
                    if (turnCostUsd != null) {
                        msg.raw.addProperty("turnCostUsd", turnCostUsd);
                    }
                }
                return true;
            }
        }
        return false;
    }

    /**
     * Parse a server message with full filtering and parsing logic (ported from v0.1.3-codex).
     *
     * @param msg msg
     * @param messageType message type
     * @return message
     * @since 1.0.0
     */
    private Message parseServerMessage(com.google.gson.JsonObject msg, Message.Type messageType) {
        if (isMetaMessage(msg)) {
            return null;
        }
        if (isFilteredCommandMessage(msg, messageType)) {
            return null;
        }

        String content = extractMessageContent(msg);
        if (messageType == Message.Type.USER) {
            return buildUserMessage(msg, content);
        }

        Message result = new Message(messageType, content != null ? content : "");
        result.raw = msg;
        return result;
    }

    private boolean isMetaMessage(com.google.gson.JsonObject msg) {
        return msg.has("isMeta") && msg.get("isMeta").getAsBoolean();
    }

    /**
     * Detect Codex internal command messages that must not be shown to the user.
     * Codex prepends instruction blocks to user input; strip them before checking command tags
     * so those hidden blocks do not mask the user's real message.
     * Only filter user messages - assistant messages may contain these tags in code examples.
     */
    private boolean isFilteredCommandMessage(com.google.gson.JsonObject msg, Message.Type messageType) {
        // Only filter user messages - assistant messages may contain command tags in code examples
        if (messageType != Message.Type.USER) {
            return false;
        }

        if (!msg.has("message") || !msg.get("message").isJsonObject()) {
            return false;
        }
        com.google.gson.JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content")) {
            return false;
        }

        String contentStr = extractFirstTextContent(message.get("content"));
        if (contentStr == null) {
            return false;
        }

        String filterContent = CodexMessageConverter.stripSystemTags(contentStr);
        boolean hasCommandMessage = contentStr.contains("<command-message>")
            && contentStr.contains("</command-message>");
        if (hasCommandMessage) {
            return false;
        }
        return filterContent.contains("<command-name>")
            || filterContent.contains("<local-command-stdout>")
            || filterContent.contains("<local-command-stderr>")
            || filterContent.contains("<command-args>");
    }

    private String extractFirstTextContent(com.google.gson.JsonElement contentElement) {
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }
        if (!contentElement.isJsonArray()) {
            return null;
        }
        com.google.gson.JsonArray contentArray = contentElement.getAsJsonArray();
        for (int i = 0; i < contentArray.size(); i++) {
            com.google.gson.JsonElement element = contentArray.get(i);
            if (!element.isJsonObject()) {
                continue;
            }
            com.google.gson.JsonObject block = element.getAsJsonObject();
            if (block.has("type") && "text".equals(block.get("type").getAsString())
                && block.has("text")) {
                return block.get("text").getAsString();
            }
        }
        return null;
    }

    private Message buildUserMessage(com.google.gson.JsonObject msg, String content) {
        boolean hasToolResult = containsToolResult(msg);
        JsonArray imageBlocks = new JsonArray();
        if (!hasToolResult) {
            imageBlocks = collectUserImageBlocks(msg, content);
            content = CodexMessageConverter.stripSystemTags(content);
            if ((content != null && !content.trim().isEmpty()) || imageBlocks.size() > 0) {
                rewriteUserRawContent(msg, content, imageBlocks);
            }
        }
        if (content == null || content.trim().isEmpty()) {
            if (imageBlocks.size() > 0) {
                Message result = new Message(Message.Type.USER, "");
                result.raw = msg;
                return result;
            }
            if (hasToolResult) {
                Message result = new Message(Message.Type.USER, "[tool_result]");
                result.raw = msg;
                return result;
            }
            return null;
        }

        Message result = new Message(Message.Type.USER, content);
        result.raw = msg;
        return result;
    }

    /**
     * Extract message content (ported from v0.1.3-codex).
     *
     * @param msg msg
     * @return string
     * @since 1.0.0
     */
    private String extractMessageContent(com.google.gson.JsonObject msg) {
        if (!msg.has("message")) {
            // Try to get content directly from the top level (some message formats may differ)
            if (msg.has("content")) {
                return extractContentFromElement(msg.get("content"));
            }
            return "";
        }

        com.google.gson.JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return "";
        }

        // Get the content element
        com.google.gson.JsonElement contentElement = message.get("content");
        return extractContentFromElement(contentElement);
    }

    /**
     * Extract content from a JsonElement (ported from v0.1.3-codex).
     *
     * @param contentElement content element
     * @return string
     * @since 1.0.0
     */
    private String extractContentFromElement(com.google.gson.JsonElement contentElement) {
        // String format
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        // Array format
        if (contentElement.isJsonArray()) {
            com.google.gson.JsonArray contentArray = contentElement.getAsJsonArray();
            StringBuilder sb = new StringBuilder();
            boolean hasContent = false;

            for (int i = 0; i < contentArray.size(); i++) {
                com.google.gson.JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    com.google.gson.JsonObject block = element.getAsJsonObject();
                    String blockType = (block.has("type") && !block.get("type").isJsonNull())
                        ? block.get("type").getAsString()
                        : null;

                    // Handle different content block types
                    if (("text".equals(blockType) || "input_text".equals(blockType) || "output_text".equals(blockType))
                            && block.has("text") && !block.get("text").isJsonNull()) {
                        String text = block.get("text").getAsString();
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append(text);
                        hasContent = true;
                    } else if ("tool_use".equals(blockType)) {
                        // Skip tool_use, don't display tool usage text
                    } else if ("tool_result".equals(blockType)) {
                        // Tool result - skip display as it provides no direct value to the user
                        // and is typically long and already reflected in the assistant's response
                    } else if ("thinking".equals(blockType)) {
                        // Skip thinking block, don't display fixed text
                    } else if ("image".equals(blockType)) {
                        // Skip image block, don't display fixed text
                    }
                } else if (element.isJsonPrimitive()) {
                    // In some cases, array elements may be plain strings
                    String text = element.getAsString();
                    if (text != null && !text.trim().isEmpty()) {
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append(text);
                        hasContent = true;
                    }
                }
            }

            return sb.toString();
        }

        // Object format (special cases)
        if (contentElement.isJsonObject()) {
            com.google.gson.JsonObject contentObj = contentElement.getAsJsonObject();
            // Try to extract the text field
            if (contentObj.has("text") && !contentObj.get("text").isJsonNull()) {
                return contentObj.get("text").getAsString();
            }
            LOG.warn("Content is an object but has no 'text' field: " + contentObj.toString());
        }

        return "";
    }

    /**
     * Check whether a server message contains a tool_result block.
     *
     * @param msg msg
     * @return boolean
     * @since 1.0.0
     */
    private boolean containsToolResult(com.google.gson.JsonObject msg) {
        com.google.gson.JsonElement contentElement = getMessageContentElement(msg);
        if (contentElement == null || !contentElement.isJsonArray()) {
            return false;
        }

        com.google.gson.JsonArray contentArray = contentElement.getAsJsonArray();
        for (int i = 0; i < contentArray.size(); i++) {
            com.google.gson.JsonElement element = contentArray.get(i);
            if (element.isJsonObject()) {
                com.google.gson.JsonObject block = element.getAsJsonObject();
                if (block.has("type") && "tool_result".equals(block.get("type").getAsString())) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Replace raw user content with the visible text only.
     *
     * @param msg msg
     * @param content visible content
     * @since 1.0.0
     */
    private void rewriteUserRawContent(com.google.gson.JsonObject msg, String content, JsonArray imageBlocks) {
        JsonArray contentBlocks = CodexMessageConverter.userContentBlocks(imageBlocks, content);

        if (msg.has("message") && msg.get("message").isJsonObject()) {
            msg.getAsJsonObject("message").add("content", contentBlocks);
        } else {
            msg.add("content", contentBlocks);
        }
    }

    private JsonArray collectUserImageBlocks(com.google.gson.JsonObject msg, String originalContent) {
        JsonArray imageBlocks = new JsonArray();
        JsonArray contentArray = CodexMessageConverter.convertToClaudeContentBlocks(this.getMessageContentElement(msg));
        for (JsonElement element : contentArray) {
            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                if (block.has("type") && "image".equals(block.get("type").getAsString())
                        && block.has("src") && !block.get("src").getAsString().isBlank()) {
                    imageBlocks.add(block);
                }
            }
        }
        JsonArray restoredImages = CodexMessageConverter.restoreCodexImagePlaceholderBlocks(originalContent);
        for (JsonElement restoredImage : restoredImages) {
            imageBlocks.add(restoredImage);
        }
        return imageBlocks;
    }

    /**
     * Get the content element from either nested or top-level Codex message shapes.
     *
     * @param msg msg
     * @return element
     * @since 1.0.0
     */
    private com.google.gson.JsonElement getMessageContentElement(com.google.gson.JsonObject msg) {
        if (msg.has("message") && msg.get("message").isJsonObject()) {
            com.google.gson.JsonObject message = msg.getAsJsonObject("message");
            if (message.has("content") && !message.get("content").isJsonNull()) {
                return message.get("content");
            }
        }
        if (msg.has("content") && !msg.get("content").isJsonNull()) {
            return msg.get("content");
        }
        return null;
    }

    /**
     * Handle content delta in streaming mode.
     *
     * @param content content
     * @since 1.0.0
     */
    private void handleContentDelta(String content) {
        // Empty content check (compatible with v0.1.3-codex)
        if (content == null || content.isEmpty()) {
            return;
        }

        assistantContent.append(content);

        if (currentAssistantMessage == null) {
            currentAssistantMessage = new Message(Message.Type.ASSISTANT, assistantContent.toString());
            state.addMessage(currentAssistantMessage);
        } else {
            currentAssistantMessage.content = assistantContent.toString();
        }

        callbackHandler.notifyContentDelta(content);
        callbackHandler.notifyMessageUpdate(state.getMessages());
    }

    /**
     * Handle thinking delta in streaming mode.
     *
     * @param content content
     * @since 1.0.0
     */
    private void handleThinkingDelta(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }

        ensureCurrentAssistantMessageExists();
        applyThinkingDeltaToRaw(content);
        callbackHandler.notifyThinkingDelta(content);
    }

    /**
     * Ensure an assistant message exists for streaming raw updates.
     *
     * @since 1.0.0
     */
    private void ensureCurrentAssistantMessageExists() {
        if (currentAssistantMessage == null) {
            com.google.gson.JsonObject raw = new com.google.gson.JsonObject();
            raw.addProperty("type", "assistant");
            com.google.gson.JsonObject messageObj = new com.google.gson.JsonObject();
            messageObj.add("content", new com.google.gson.JsonArray());
            raw.add("message", messageObj);
            currentAssistantMessage = new Message(Message.Type.ASSISTANT, "", raw);
            state.addMessage(currentAssistantMessage);
        }
        if (currentAssistantMessage.raw == null) {
            com.google.gson.JsonObject raw = new com.google.gson.JsonObject();
            raw.addProperty("type", "assistant");
            com.google.gson.JsonObject messageObj = new com.google.gson.JsonObject();
            messageObj.add("content", new com.google.gson.JsonArray());
            raw.add("message", messageObj);
            currentAssistantMessage.raw = raw;
        }
    }

    /**
     * Append thinking delta to the current assistant raw block.
     *
     * @param delta delta
     * @since 1.0.0
     */
    private void applyThinkingDeltaToRaw(String delta) {
        com.google.gson.JsonObject raw = currentAssistantMessage.raw;
        com.google.gson.JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message")
                : new com.google.gson.JsonObject();
        com.google.gson.JsonArray content = message.has("content") && message.get("content").isJsonArray()
                ? message.getAsJsonArray("content")
                : new com.google.gson.JsonArray();

        com.google.gson.JsonObject target = null;
        if (content.size() > 0) {
            com.google.gson.JsonElement last = content.get(content.size() - 1);
            if (last.isJsonObject()) {
                com.google.gson.JsonObject block = last.getAsJsonObject();
                if (block.has("type") && "thinking".equals(block.get("type").getAsString())) {
                    target = block;
                }
            }
        }

        if (target == null) {
            target = new com.google.gson.JsonObject();
            target.addProperty("type", "thinking");
            target.addProperty("thinking", "");
            target.addProperty("text", "");
            content.add(target);
        }

        String existing = target.has("thinking") && !target.get("thinking").isJsonNull()
                ? target.get("thinking").getAsString()
                : "";
        String next = existing + delta;
        target.addProperty("thinking", next);
        target.addProperty("text", next);

        message.add("content", content);
        raw.add("message", message);
        currentAssistantMessage.raw = raw;
    }

    /**
     * Handle Stream Start
     *
     * @since 1.0.0
     */
    private void handleStreamStart() {
        isStreaming = true;
        streamEndedThisTurn = false;
        currentTurnContextUsage = null;
        resetStreamingAccumulator();
        callbackHandler.notifyStreamStart();
        LOG.debug("Codex stream started");
    }

    /**
     * Handle Stream End
     *
     * @since 1.0.0
     */
    private void handleStreamEnd() {
        if (!isStreaming && streamEndedThisTurn) {
            return;
        }

        isStreaming = false;
        streamEndedThisTurn = true;
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStreamEnd();
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
        LOG.debug("Codex stream ended");
    }

    /**
     * Handle the end of a message.
     *
     * @since 1.0.0
     */
    private void handleMessageEnd() {
        if (turnCompletion != null && !streamEndedThisTurn) {
            handleStreamEnd();
        }
        LOG.debug("Codex message_end received");
    }

    /**
     * Reset per-turn streaming accumulator state.
     *
     * @since 1.0.0
     */
    private void resetStreamingAccumulator() {
        assistantContent.setLength(0);
        currentAssistantMessage = null;
    }
}
