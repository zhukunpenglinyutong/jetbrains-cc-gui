package com.github.claudecodegui.session;

import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.util.TokenUsageUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.ArrayList;
import java.util.List;

/**
 * Claude message callback handler.
 * Processes various message types returned by Claude AI,
 * including thinking content, text responses, and tool call results.
 */
public class ClaudeMessageHandler implements MessageCallback {
    private static final Logger LOG = Logger.getInstance(ClaudeMessageHandler.class);

    private final Project project;
    private final SessionState state;
    private final CallbackHandler callbackHandler;
    private final MessageParser messageParser;
    private final MessageMerger messageMerger;
    private final Gson gson;

    // Content accumulator for the current assistant message
    private final StringBuilder assistantContent = new StringBuilder();

    // Current assistant message object being processed
    private Message currentAssistantMessage = null;

    // Whether the AI is currently in thinking mode
    private boolean isThinking = false;

    // Streaming state tracking — volatile because these fields are read/written across
    // message callback threads and EDT, with no other happens-before guarantee.
    private volatile boolean isStreaming = false;

    private volatile boolean streamEndedThisTurn = false;
    private volatile boolean errorReportedThisTurn = false;
    private volatile String lastReportedError = null;

    // Streaming segment state (used to split text/thinking around tool calls)
    private volatile boolean textSegmentActive = false;
    private volatile boolean thinkingSegmentActive = false;

    // Offset tracking for deduplication after conservative sync.
    // Volatile: same threading pattern as textSegmentActive/thinkingSegmentActive
    // (read/written across SDK callback threads and EDT).
    private volatile int syncedContentOffset = 0;
    private volatile int syncedThinkingOffset = 0;

    /**
     * Constructor.
     */
    public ClaudeMessageHandler(
            Project project,
            SessionState state,
            CallbackHandler callbackHandler,
            MessageParser messageParser,
            MessageMerger messageMerger,
            Gson gson
    ) {
        this.project = project;
        this.state = state;
        this.callbackHandler = callbackHandler;
        this.messageParser = messageParser;
        this.messageMerger = messageMerger;
        this.gson = gson;
    }

    /**
     * Handle a received message by dispatching to the appropriate handler based on type.
     */
    @Override
    public void onMessage(String type, String content) {
        // Route to the appropriate handler based on message type
        switch (type) {
            case "user":
                handleUserMessage(content);
                break;
            case "assistant":
                handleAssistantMessage(content);
                break;
            case "thinking":
                handleThinkingMessage();
                break;
            case "content":
                // Non-streaming mode: complete content block, update message
                handleContent(content);
                break;
            case "content_delta":
                // Streaming: incremental content, forward to frontend
                handleContentDelta(content);
                break;
            // Streaming: thinking delta
            case "thinking_delta":
                handleThinkingDelta(content);
                break;
            // Streaming: start and end markers
            case "stream_start":
                handleStreamStart();
                break;
            case "stream_end":
                handleStreamEnd();
                break;
            case "session_id":
                handleSessionId(content);
                break;
            case "tool_result":
                handleToolResult(content);
                break;
            case "message_end":
                handleMessageEnd();
                break;
            case "result":
                handleResult(content);
                break;
            case "usage":
                handleUsage(content);
                break;
            case "slash_commands":
                handleSlashCommands(content);
                break;
            case "system":
                handleSystemMessage(content);
                break;
            case "node_log":
                // Forward Node.js logs to frontend console
                callbackHandler.notifyNodeLog(content);
                break;
        }
    }

    /**
     * Handle an error from the SDK.
     */
    @Override
    public void onError(String error) {
        if (errorReportedThisTurn && error != null && error.equals(lastReportedError)) {
            LOG.debug("Suppressing duplicate error for current Claude turn");
            return;
        }

        boolean wasStreaming = isStreaming;
        isStreaming = false;
        streamEndedThisTurn = false;
        errorReportedThisTurn = true;
        lastReportedError = error;
        textSegmentActive = false;
        thinkingSegmentActive = false;
        syncedContentOffset = 0;
        syncedThinkingOffset = 0;

        // Reset thinking state if still active — same as onComplete() and handleStreamEnd()
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }

        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);

        Message errorMessage = new Message(Message.Type.ERROR, error);
        state.addMessage(errorMessage);
        callbackHandler.notifyMessageUpdate(state.getMessages());
        if (wasStreaming) {
            callbackHandler.notifyStreamEnd();
        }
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());

        // Show error in status bar
        ClaudeNotifier.showError(project, error);
    }

    /**
     * Handle completion of a response turn.
     */
    @Override
    public void onComplete(SDKResult result) {
        if (streamEndedThisTurn) {
            streamEndedThisTurn = false;
            errorReportedThisTurn = false;
            lastReportedError = null;
            // Safety net: ensure loading state is cleared even when stream_end
            // was received normally.  handleStreamEnd() already calls
            // notifyStateChange, but the async JCEF chain may drop it.
            // This redundant call is harmless (idempotent) and prevents the UI
            // from getting stuck in "responding" state.
            state.setBusy(false);
            state.setLoading(false);
            callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
            return;
        }

        // If streaming was active but [STREAM_END] was never received (e.g., SDK error,
        // timeout, or process interruption), we must explicitly end the stream here.
        // Without this, the StreamMessageCoalescer remains in streamActive=true state,
        // which causes SessionCallbackAdapter.onStateChange() to suppress showLoading(false),
        // leaving the UI stuck in "responding" state forever.
        // This mirrors the same pattern used in onError() above.
        boolean wasStreaming = isStreaming;
        isStreaming = false;
        textSegmentActive = false;
        thinkingSegmentActive = false;
        syncedContentOffset = 0;
        syncedThinkingOffset = 0;

        // Reset thinking state if still active
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }

        errorReportedThisTurn = false;
        lastReportedError = null;
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();

        if (wasStreaming) {
            LOG.warn("onComplete called without prior stream_end — forcing stream cleanup");
            callbackHandler.notifyMessageUpdate(state.getMessages());
            callbackHandler.notifyStreamEnd();
        }

        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    // ===== Private methods: handle different message types =====

    /**
     * Handle an assistant message in full JSON format.
     */
    private void handleAssistantMessage(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            // Parse the complete JSON message
            JsonObject messageJson = gson.fromJson(content, JsonObject.class);
            JsonObject previousRaw = currentAssistantMessage != null ? currentAssistantMessage.raw : null;
            JsonObject mergedRaw = messageMerger.mergeAssistantMessage(previousRaw, messageJson);

            if (currentAssistantMessage == null) {
                currentAssistantMessage = new Message(Message.Type.ASSISTANT, "", mergedRaw);
                state.addMessage(currentAssistantMessage);
            } else {
                currentAssistantMessage.raw = mergedRaw;
            }

            // Streaming mode: do not overwrite accumulated streaming content with the full message
            //   (tool call messages typically don't contain text)
            // Non-streaming mode: rebuild content from the full message text
            String aggregatedText = messageParser.extractMessageContent(mergedRaw);
            if (!isStreaming) {
                assistantContent.setLength(0);
                if (aggregatedText != null) {
                    assistantContent.append(aggregatedText);
                }
                currentAssistantMessage.content = assistantContent.toString();
            } else if (aggregatedText != null && aggregatedText.length() > assistantContent.length()) {
                // Conservative sync: if full text is longer, update accumulator (prevents delta loss edge cases)
                assistantContent.setLength(0);
                assistantContent.append(aggregatedText);
                currentAssistantMessage.content = assistantContent.toString();
                syncedContentOffset = assistantContent.length();
            }
            currentAssistantMessage.raw = mergedRaw;

            // Streaming: check if the message contains tool calls
            // If tool_use is present, we need to update messages even in streaming mode to render tool blocks
            boolean hasToolUse = false;
            if (mergedRaw.has("message") && mergedRaw.getAsJsonObject("message").has("content")) {
                var contentArray = mergedRaw.getAsJsonObject("message").get("content");
                if (contentArray.isJsonArray()) {
                    for (var element : contentArray.getAsJsonArray()) {
                        if (element.isJsonObject() && element.getAsJsonObject().has("type")) {
                            String type = element.getAsJsonObject().get("type").getAsString();
                            if ("tool_use".equals(type)) {
                                hasToolUse = true;
                                break;
                            }
                        }
                    }
                }
            }

            // Tool calls act as segment boundaries: subsequent text/thinking should go into new blocks
            if (hasToolUse) {
                textSegmentActive = false;
                thinkingSegmentActive = false;
            }

            // Streaming: skip full message update in streaming mode unless there is a tool call
            if (!isStreaming || hasToolUse) {
                callbackHandler.notifyMessageUpdate(state.getMessages());
                if (hasToolUse) {
                    LOG.debug("Streaming active but tool_use detected, sending message update");
                }
            } else {
                LOG.debug("Streaming active, skipping full message update in handleAssistantMessage");
            }

            // Update status bar with usage from the final assistant message (matches CLI's PP1 behavior).
            // This ensures the displayed value matches what resume shows from JSONL history.
            // The assistant message's usage field is the authoritative final value.
            //
            // IMPORTANT: This update MUST happen in BOTH streaming and non-streaming modes:
            // - In streaming mode: [USAGE] tags provide intermediate updates for real-time feedback,
            //   but the assistant message's usage is the authoritative final value that must overwrite
            //   any intermediate values to ensure consistency with JSONL history and CLI behavior.
            // - In non-streaming mode: This is the primary path to update token usage.
            //
            // DO NOT add !isStreaming check here - it was previously introduced in commit 03640408
            // and caused incorrect token display in streaming mode (see commit history for details).
            if (mergedRaw.has("message") && mergedRaw.get("message").isJsonObject()) {
                JsonObject messageObj = mergedRaw.getAsJsonObject("message");
                if (messageObj.has("usage") && messageObj.get("usage").isJsonObject()) {
                    JsonObject usage = messageObj.getAsJsonObject("usage");
                    int usedTokens = TokenUsageUtils.extractUsedTokens(usage, state.getProvider());
                    int maxTokens = SettingsHandler.getModelContextLimit(state.getModel());
                    ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
                    callbackHandler.notifyUsageUpdate(usedTokens, maxTokens);
                    LOG.debug("Updated token usage from assistant message: " + usedTokens);
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to parse assistant message JSON: " + e.getMessage());
        }
    }

    /**
     * Handle the thinking message indicating AI is reasoning.
     */
    private void handleThinkingMessage() {
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
            // Update StatusBar to show thinking status
            ClaudeNotifier.setThinking(project);
            LOG.debug("Thinking started");
        }
    }

    /**
     * Handle complete content in non-streaming mode.
     */
    private void handleContent(String content) {
        // If previously thinking, content output means thinking is complete
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
            ClaudeNotifier.setGenerating(project);
            LOG.debug("Thinking completed, generating response");
        }

        assistantContent.append(content);

        if (currentAssistantMessage == null) {
            currentAssistantMessage = new Message(Message.Type.ASSISTANT, assistantContent.toString());
            state.addMessage(currentAssistantMessage);
        } else {
            currentAssistantMessage.content = assistantContent.toString();
        }

        // Streaming: skip full message update in streaming mode
        if (!isStreaming) {
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } else {
            LOG.debug("Streaming active, skipping full message update in handleContent");
        }
    }

    /**
     * Handle incremental content delta in streaming mode.
     */
    private void handleContentDelta(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }
        // If previously thinking, content output means thinking is complete
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
            // Update StatusBar to show generating status
            ClaudeNotifier.setGenerating(project);
            LOG.debug("Thinking completed, generating response");
        }

        // Content output means the current thinking segment has ended
        thinkingSegmentActive = false;

        // Dedup: skip if delta was already included via conservative sync.
        // Heuristic: checks if assistantContent ends with the delta. This may produce
        // false positives for very short deltas (1-2 chars) that coincidentally match
        // the suffix, but the SDK sends deltas in token-level chunks (typically whole
        // words) making this extremely rare in practice.
        // CRITICAL: Do NOT notify frontend when dedup triggers - frontend has no dedup
        // and will accumulate the delta, causing content duplication.
        if (syncedContentOffset > 0
                && assistantContent.length() >= content.length()
                && assistantContent.substring(assistantContent.length() - content.length()).equals(content)) {
            LOG.debug("Skipping duplicate content delta (len=" + content.length() + ")");
            if (!isStreaming) {
                callbackHandler.notifyMessageUpdate(state.getMessages());
            }
            return;
        }

        // Accumulate content for the final message
        assistantContent.append(content);

        ensureCurrentAssistantMessageExists();
        currentAssistantMessage.content = assistantContent.toString();
        applyTextDeltaToRaw(content);
        syncedContentOffset = assistantContent.length();
        textSegmentActive = true;

        callbackHandler.notifyContentDelta(content);
        if (!isStreaming) {
            callbackHandler.notifyMessageUpdate(state.getMessages());
        }
    }

    /**
     * Handle session ID received from the SDK.
     */
    private void handleSessionId(String content) {
        state.setSessionId(content);
        callbackHandler.notifySessionIdReceived(content);
        LOG.info("Captured session ID: " + content);
    }

    /**
     * Handle user message from SDK.
     * SDK-returned user messages contain a uuid that needs to be applied to existing user messages.
     * Messages containing tool_result need to be added to the message list.
     */
    private void handleUserMessage(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            JsonObject userMsg = gson.fromJson(content, JsonObject.class);

            // Check if the message contains a tool_result
            if (messageParser.hasToolResult(userMsg)) {
                // This is a user message with tool_result; add it to the message list
                Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", userMsg);
                state.addMessage(toolResultMessage);
                LOG.debug("Added tool_result user message to state");
                callbackHandler.notifyMessageUpdate(state.getMessages());
                return;
            }

            // Extract uuid (used for rewind functionality)
            String uuid = userMsg.has("uuid") ? userMsg.get("uuid").getAsString() : null;
            if (uuid == null) {
                LOG.debug("User message from SDK has no uuid, skipping update");
                return;
            }

            String userText = messageParser.extractMessageContent(userMsg);
            if (userText == null || userText.isEmpty()) {
                LOG.debug("User message from SDK has no text content, skipping uuid patch");
                return;
            }

            // Find the latest unresolved matching user message and patch its uuid.
            List<Message> messages = state.getMessagesReference();
            for (int i = messages.size() - 1; i >= 0; i--) {
                Message msg = messages.get(i);
                if (msg.type != Message.Type.USER) {
                    continue;
                }
                if (!userText.equals(msg.content)) {
                    continue;
                }
                if (msg.raw == null) {
                    msg.raw = new JsonObject();
                }
                if (msg.raw.has("uuid") && !msg.raw.get("uuid").isJsonNull()) {
                    continue;
                }
                msg.raw.addProperty("uuid", uuid);
                LOG.info("Updated user message with uuid: " + uuid);
                callbackHandler.notifyUserMessageUuidPatched(msg.content != null ? msg.content : "", uuid);
                break;
            }
        } catch (Exception e) {
            LOG.warn("Failed to parse user message from SDK: " + e.getMessage());
        }
    }

    /**
     * Handle a tool call result.
     */
    private void handleToolResult(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            JsonObject toolResultBlock = gson.fromJson(content, JsonObject.class);
            String toolUseId = toolResultBlock.has("tool_use_id")
                    ? toolResultBlock.get("tool_use_id").getAsString()
                    : null;

            if (toolUseId != null) {
                // Build a user message containing the tool_result
                JsonArray contentArray = new JsonArray();
                contentArray.add(toolResultBlock);

                JsonObject messageObj = new JsonObject();
                messageObj.add("content", contentArray);

                JsonObject rawUser = new JsonObject();
                rawUser.addProperty("type", "user");
                rawUser.add("message", messageObj);

                // Create the user message and add it to the message list
                Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", rawUser);
                state.addMessage(toolResultMessage);

                LOG.debug("Tool result received for tool_use_id: " + toolUseId);
                callbackHandler.notifyMessageUpdate(state.getMessages());
            }
        } catch (Exception e) {
            LOG.warn("Failed to parse tool_result JSON: " + e.getMessage());
        }
    }

    /**
     * Handle the end of a message.
     */
    private void handleMessageEnd() {
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        ClaudeNotifier.clearStatus(project);

        // FIX: handleMessageEnd should not reset loading/busy state.
        // Regardless of streaming or non-streaming mode, state reset should be handled uniformly by:
        // - Streaming mode: onStreamEnd
        // - Non-streaming mode: onComplete
        // This prevents state from being unexpectedly reset during message processing.
        LOG.debug("message_end received, deferring state cleanup to onComplete/onStreamEnd");
    }

    /**
     * Handle the result message as a fallback for non-streaming mode.
     * In streaming mode, usage is updated via handleUsage() from [USAGE] tags.
     * In non-streaming mode, [USAGE] tags may not be emitted, so result.usage
     * serves as the fallback data source to ensure token usage is displayed.
     */
    private void handleResult(String content) {
        if (content == null || !content.startsWith("{")) {
            LOG.debug("Result message received (non-JSON, skipping)");
            return;
        }
        try {
            JsonObject resultJson = gson.fromJson(content, JsonObject.class);
            LOG.debug("Result message received");
            // Fallback: only update usage from result if no usage was received via [USAGE] tag or assistant message
            if (resultJson.has("usage") && resultJson.get("usage").isJsonObject()
                    && currentAssistantMessage != null && currentAssistantMessage.raw != null) {
                JsonObject msg = currentAssistantMessage.raw.has("message")
                        && currentAssistantMessage.raw.get("message").isJsonObject()
                        ? currentAssistantMessage.raw.getAsJsonObject("message") : null;
                boolean hasExistingUsage = msg != null && msg.has("usage") && msg.get("usage").isJsonObject();
                if (!hasExistingUsage) {
                    JsonObject usageJson = resultJson.getAsJsonObject("usage");
                    if (msg != null) {
                        msg.add("usage", usageJson);
                    }
                    int usedTokens = TokenUsageUtils.extractUsedTokens(usageJson, state.getProvider());
                    int maxTokens = SettingsHandler.getModelContextLimit(state.getModel());
                    ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
                    callbackHandler.notifyUsageUpdate(usedTokens, maxTokens);
                    LOG.debug("Fallback: updated token usage from result message: " + usedTokens);
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to parse result message: " + e.getMessage());
        }
    }

    /**
     * Handle the list of available slash commands.
     */
    private void handleSlashCommands(String content) {
        try {
            JsonArray commandsArray = gson.fromJson(content, JsonArray.class);
            List<String> commands = new ArrayList<>();
            for (int i = 0; i < commandsArray.size(); i++) {
                commands.add(commandsArray.get(i).getAsString());
            }
            state.setSlashCommands(commands);
            LOG.debug("Received " + commands.size() + " slash commands");
            callbackHandler.notifySlashCommandsReceived(commands);
        } catch (Exception e) {
            LOG.warn("Failed to parse slash commands: " + e.getMessage());
        }
    }

    /**
     * Handle a system-level message (not from AI, but from the system).
     */
    private void handleSystemMessage(String content) {
        LOG.debug("System message: " + content);

        // Parse slash_commands field from the system message
        try {
            JsonObject systemObj = gson.fromJson(content, JsonObject.class);
            if (systemObj.has("slash_commands") && systemObj.get("slash_commands").isJsonArray()) {
                JsonArray commandsArray = systemObj.getAsJsonArray("slash_commands");
                List<String> commands = new ArrayList<>();
                for (int i = 0; i < commandsArray.size(); i++) {
                    commands.add(commandsArray.get(i).getAsString());
                }
                state.setSlashCommands(commands);
                LOG.debug("Extracted " + commands.size() + " slash commands from system message");
                callbackHandler.notifySlashCommandsReceived(commands);
            }
        } catch (Exception e) {
            LOG.warn("Failed to extract slash commands from system message: " + e.getMessage());
        }
    }

    // ===== Streaming message handlers =====

    /**
     * Handle stream start event. Notifies the frontend to prepare for incremental content.
     */
    private void handleStreamStart() {
        LOG.debug("Stream started");
        isStreaming = true;  // Mark streaming as active
        streamEndedThisTurn = false;
        errorReportedThisTurn = false;
        lastReportedError = null;
        textSegmentActive = false;
        thinkingSegmentActive = false;
        syncedContentOffset = 0;
        syncedThinkingOffset = 0;
        callbackHandler.notifyStreamStart();
    }

    /**
     * Handle stream end event. Notifies the frontend that the message is complete.
     */
    private void handleStreamEnd() {
        LOG.debug("Stream ended");
        isStreaming = false;  // Mark streaming as inactive
        streamEndedThisTurn = true;
        textSegmentActive = false;
        thinkingSegmentActive = false;
        syncedContentOffset = 0;
        syncedThinkingOffset = 0;

        // Reset thinking state — stream end is the definitive boundary for a turn.
        // If thinking was active when the stream ended (e.g., extended thinking without
        // subsequent content), it must be cleared here to prevent the frontend from being
        // stuck in "thinking" state.
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }

        // Ensure raw blocks are consistent with the accumulated content before sending the final update.
        // Conservative sync may leave raw text/thinking blocks shorter than assistantContent
        // if deltas arrived after the sync but before stream end.
        ensureRawBlocksConsistency();

        // After streaming ends, send a final message update to ensure the message list is in sync
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStreamEnd();
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    /**
     * Handle an incremental thinking delta. Forwards it to the frontend for real-time display.
     */
    private void handleThinkingDelta(String content) {
        if (content == null || content.isEmpty()) {
            return;
        }
        // Ensure thinking state is enabled
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
        }
        // Write thinking delta to raw to prevent data loss after stream ends
        ensureCurrentAssistantMessageExists();
        boolean applied = applyThinkingDeltaToRaw(content);
        if (applied) {
            // Note: uses += (not absolute assignment like syncedContentOffset)
            // because there is no thinkingContent StringBuilder to take length from
            syncedThinkingOffset += content.length();
            thinkingSegmentActive = true;
            // CRITICAL: Only notify frontend when delta was actually applied.
            // Frontend has no dedup and will accumulate, causing duplication.
            callbackHandler.notifyThinkingDelta(content);
            if (!isStreaming) {
                callbackHandler.notifyMessageUpdate(state.getMessages());
            }
        } else {
            LOG.debug("Skipping duplicate thinking delta (len=" + content.length() + ")");
        }
    }

    private void ensureCurrentAssistantMessageExists() {
        if (currentAssistantMessage == null) {
            JsonObject raw = new JsonObject();
            raw.addProperty("type", "assistant");
            JsonObject messageObj = new JsonObject();
            messageObj.add("content", new JsonArray());
            raw.add("message", messageObj);
            currentAssistantMessage = new Message(Message.Type.ASSISTANT, "", raw);
            state.addMessage(currentAssistantMessage);
        }
        if (currentAssistantMessage.raw == null) {
            JsonObject raw = new JsonObject();
            raw.addProperty("type", "assistant");
            JsonObject messageObj = new JsonObject();
            messageObj.add("content", new JsonArray());
            raw.add("message", messageObj);
            currentAssistantMessage.raw = raw;
        }
    }

    private JsonArray ensureAssistantContentArray() {
        ensureCurrentAssistantMessageExists();
        JsonObject raw = currentAssistantMessage.raw;
        JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message")
                : new JsonObject();
        JsonArray content = message.has("content") && message.get("content").isJsonArray()
                ? message.getAsJsonArray("content")
                : new JsonArray();
        message.add("content", content);
        raw.add("message", message);
        currentAssistantMessage.raw = raw;
        return content;
    }

    private boolean applyTextDeltaToRaw(String delta) {
        if (delta == null || delta.isEmpty()) {
            return false;
        }
        JsonArray contentArray = ensureAssistantContentArray();
        JsonObject target = null;

        if (textSegmentActive) {
            for (int i = contentArray.size() - 1; i >= 0; i--) {
                if (!contentArray.get(i).isJsonObject()) {
                    continue;
                }
                JsonObject block = contentArray.get(i).getAsJsonObject();
                if (block.has("type") && "text".equals(block.get("type").getAsString())) {
                    target = block;
                    break;
                }
            }
        }

        if (target == null) {
            target = new JsonObject();
            target.addProperty("type", "text");
            target.addProperty("text", "");
            contentArray.add(target);
        }

        String existing = target.has("text") && !target.get("text").isJsonNull()
                ? target.get("text").getAsString()
                : "";

        // Dedup: skip if delta was already included after the last conservative sync
        if (syncedContentOffset > 0 && existing.endsWith(delta)) {
            return false;
        }

        target.addProperty("text", existing + delta);
        return true;
    }

    /**
     * Ensure raw text blocks are consistent with the accumulated assistantContent.
     * Conservative sync may leave the last raw text block shorter than the actual
     * streamed content when deltas arrive after the sync. This safety net runs
     * before the final notifyMessageUpdate to guarantee the frontend receives complete data.
     *
     * <p>Since assistantContent accumulates ALL text deltas (concatenation of all text blocks),
     * we calculate the total length of preceding text blocks and use only the tail portion
     * of assistantContent to fix the last block. This prevents incorrectly overwriting
     * the last block with the full concatenated content when multiple text blocks exist.</p>
     *
     * <p>Note: Only text blocks are fixed here because assistantContent is the
     * authoritative accumulator for text. Thinking content has no separate
     * accumulator — it is written directly to raw blocks — so there is no
     * external source of truth to compare against.</p>
     */
    private void ensureRawBlocksConsistency() {
        if (this.currentAssistantMessage == null || this.currentAssistantMessage.raw == null) {
            return;
        }
        JsonObject raw = this.currentAssistantMessage.raw;
        JsonObject message = raw.has("message") && raw.get("message").isJsonObject()
                ? raw.getAsJsonObject("message") : null;
        if (message == null || !message.has("content") || !message.get("content").isJsonArray()) {
            return;
        }
        JsonArray contentArray = message.getAsJsonArray("content");

        String accumulatedText = this.assistantContent.toString();
        if (accumulatedText.isEmpty()) {
            return;
        }

        // Find the last text block and calculate total text length from all preceding text blocks.
        // We need this because assistantContent is the concatenation of ALL text deltas,
        // but each text block should only contain its respective portion.
        JsonObject lastTextBlock = null;
        int precedingTextLength = 0;
        for (int i = 0; i < contentArray.size(); i++) {
            if (!contentArray.get(i).isJsonObject()) {
                continue;
            }
            JsonObject block = contentArray.get(i).getAsJsonObject();
            String blockType = block.has("type") && !block.get("type").isJsonNull()
                    ? block.get("type").getAsString() : "";
            if ("text".equals(blockType)) {
                lastTextBlock = block;
                precedingTextLength += block.has("text") && !block.get("text").isJsonNull()
                        ? block.get("text").getAsString().length() : 0;
            }
        }

        // The last iteration added the last block's length to precedingTextLength,
        // so subtract it to get the actual preceding length.
        if (lastTextBlock != null) {
            String lastBlockText = lastTextBlock.has("text") && !lastTextBlock.get("text").isJsonNull()
                    ? lastTextBlock.get("text").getAsString() : "";
            precedingTextLength -= lastBlockText.length();

            // Invariant: assistantContent must cover all preceding text blocks.
            // A violation indicates raw blocks and the accumulator drifted, which is
            // worth surfacing for diagnosis rather than silently producing an empty tail.
            if (accumulatedText.length() < precedingTextLength) {
                LOG.warn("ensureRawBlocksConsistency: accumulatedText (" + accumulatedText.length()
                        + ") shorter than precedingTextLength (" + precedingTextLength
                        + "); raw blocks may be out of sync with assistantContent");
                return;
            }

            // The expected content for the last block is the tail of assistantContent
            // starting from the end of all preceding text blocks.
            String expectedLastBlockText = accumulatedText.substring(precedingTextLength);
            if (lastBlockText.length() < expectedLastBlockText.length()) {
                lastTextBlock.addProperty("text", expectedLastBlockText);
            }
        }
    }

    /**
     * Handle usage data from the [USAGE] tag emitted by ai-bridge during streaming.
     */
    private void handleUsage(String content) {
        if (content == null || content.isEmpty() || !content.startsWith("{")) return;
        try {
            JsonObject usageJson = gson.fromJson(content, JsonObject.class);
            int usedTokens = TokenUsageUtils.extractUsedTokens(usageJson, state.getProvider());
            int maxTokens = SettingsHandler.getModelContextLimit(state.getModel());
            ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
            // Notify webview of usage update
            callbackHandler.notifyUsageUpdate(usedTokens, maxTokens);
            // Ensure assistant message exists before backfilling usage
            ensureCurrentAssistantMessageExists();
            backfillUsageToAssistantMessage(usageJson);
            LOG.debug("Updated token usage from [USAGE] tag: " + usedTokens);
        } catch (Exception e) {
            LOG.warn("Failed to parse usage data: " + e.getMessage());
        }
    }

    /**
     * Backfill usage data into the current assistant message's raw JSON.
     * Always updates during streaming to capture accumulating usage data.
     *
     * IMPORTANT: This method does NOT perform monotonic increase checks.
     * - The assistant message's final usage value (from handleAssistantMessage) is the authoritative
     *   value that will overwrite any intermediate values from [USAGE] tags.
     * - Monotonic checks were previously added in commit 03640408 but removed because they prevented
     *   the authoritative final value from being applied when messages arrive out of order.
     * - Allowing overwrites ensures consistency with JSONL history and CLI behavior.
     */
    private void backfillUsageToAssistantMessage(JsonObject usageJson) {
        if (currentAssistantMessage == null || currentAssistantMessage.raw == null) return;
        JsonObject message = currentAssistantMessage.raw.has("message") && currentAssistantMessage.raw.get("message").isJsonObject()
                ? currentAssistantMessage.raw.getAsJsonObject("message") : null;
        if (message == null) return;

        // Always update usage during streaming to capture accumulating values
        message.add("usage", usageJson);
        LOG.debug("Updated assistant message usage from [USAGE] tag");
    }

    private boolean applyThinkingDeltaToRaw(String delta) {
        if (delta == null || delta.isEmpty()) {
            return false;
        }
        JsonArray contentArray = ensureAssistantContentArray();
        JsonObject target = null;

        if (thinkingSegmentActive) {
            for (int i = contentArray.size() - 1; i >= 0; i--) {
                if (!contentArray.get(i).isJsonObject()) {
                    continue;
                }
                JsonObject block = contentArray.get(i).getAsJsonObject();
                if (block.has("type") && "thinking".equals(block.get("type").getAsString())) {
                    target = block;
                    break;
                }
            }
        }

        if (target == null) {
            target = new JsonObject();
            target.addProperty("type", "thinking");
            target.addProperty("thinking", "");
            contentArray.add(target);
        }

        String existing = target.has("thinking") && !target.get("thinking").isJsonNull()
                ? target.get("thinking").getAsString()
                : "";

        // Dedup: skip if delta was already included after the last conservative sync
        if (syncedThinkingOffset > 0 && existing.endsWith(delta)) {
            return false;
        }

        target.addProperty("thinking", existing + delta);
        return true;
    }
}
