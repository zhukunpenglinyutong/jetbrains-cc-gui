package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.ClaudeSession.Message;
import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.notifications.ClaudeNotifier;
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

    // Streaming state tracking
    private boolean isStreaming = false;

    private boolean streamEndedThisTurn = false;

    // Streaming segment state (used to split text/thinking around tool calls)
    private boolean textSegmentActive = false;
    private boolean thinkingSegmentActive = false;

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
        streamEndedThisTurn = false;
        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);

        Message errorMessage = new Message(Message.Type.ERROR, error);
        state.addMessage(errorMessage);
        callbackHandler.notifyMessageUpdate(state.getMessages());
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
            return;
        }
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
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

        // Accumulate content for the final message
        assistantContent.append(content);

        ensureCurrentAssistantMessageExists();
        currentAssistantMessage.content = assistantContent.toString();
        applyTextDeltaToRaw(content);
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

            // Find the last user message and update its raw field with the uuid
            List<Message> messages = state.getMessages();
            for (int i = messages.size() - 1; i >= 0; i--) {
                Message msg = messages.get(i);
                if (msg.type == Message.Type.USER && msg.raw != null) {
                    // Check if this message already has a uuid
                    if (!msg.raw.has("uuid")) {
                        // Update the raw field with the uuid
                        msg.raw.addProperty("uuid", uuid);
                        LOG.info("Updated user message with uuid: " + uuid);
                        // Notify frontend of the update
                        callbackHandler.notifyMessageUpdate(messages);
                        break;
                    }
                }
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
     * Handle the result message containing usage statistics.
     */
    private void handleResult(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            JsonObject resultJson = gson.fromJson(content, JsonObject.class);
            LOG.debug("Result message received");

            // Always update status bar with token usage if available in result
            if (resultJson.has("usage")) {
                JsonObject resultUsage = resultJson.getAsJsonObject("usage");

                int inputTokens = resultUsage.has("input_tokens") ? resultUsage.get("input_tokens").getAsInt() : 0;
                int cacheWriteTokens = resultUsage.has("cache_creation_input_tokens") ? resultUsage.get("cache_creation_input_tokens").getAsInt() : 0;
                int cacheReadTokens = resultUsage.has("cache_read_input_tokens") ? resultUsage.get("cache_read_input_tokens").getAsInt() : 0;

                updateTokenUsageDisplay(inputTokens, cacheWriteTokens, cacheReadTokens);
            }

            // If the current message's raw usage is all zeros, update it with the result's usage
            if (currentAssistantMessage != null && currentAssistantMessage.raw != null) {
                JsonObject message = currentAssistantMessage.raw.has("message") && currentAssistantMessage.raw.get("message").isJsonObject()
                    ? currentAssistantMessage.raw.getAsJsonObject("message")
                    : null;

                // Check if the current message's usage is all zeros
                boolean needsUsageUpdate = false;
                if (message != null && message.has("usage")) {
                    JsonObject usage = message.getAsJsonObject("usage");
                    int inputTokens = usage.has("input_tokens") ? usage.get("input_tokens").getAsInt() : 0;
                    int outputTokens = usage.has("output_tokens") ? usage.get("output_tokens").getAsInt() : 0;
                    if (inputTokens == 0 && outputTokens == 0) {
                        needsUsageUpdate = true;
                    }
                } else {
                    needsUsageUpdate = true;
                }

                if (needsUsageUpdate && resultJson.has("usage")) {
                    JsonObject resultUsage = resultJson.getAsJsonObject("usage");
                    if (message != null) {
                        message.add("usage", resultUsage);
                        callbackHandler.notifyMessageUpdate(state.getMessages());
                        LOG.debug("Updated assistant message usage from result message");
                    }
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
        textSegmentActive = false;
        thinkingSegmentActive = false;
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
        applyThinkingDeltaToRaw(content);
        thinkingSegmentActive = true;
        callbackHandler.notifyThinkingDelta(content);
        if (!isStreaming) {
            callbackHandler.notifyMessageUpdate(state.getMessages());
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

    private void applyTextDeltaToRaw(String delta) {
        if (delta == null || delta.isEmpty()) {
            return;
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
        target.addProperty("text", existing + delta);
    }

    // ===== Token usage helpers =====

    /**
     * Calculate context window token usage for Claude provider.
     * Formula: input_tokens + cache_creation_input_tokens + cache_read_input_tokens
     * (output_tokens excluded — they don't count toward context window until next turn)
     */
    public static int calculateContextWindowTokens(int inputTokens, int cacheCreationTokens, int cacheReadTokens) {
        return inputTokens + cacheCreationTokens + cacheReadTokens;
    }

    /**
     * Extract used token count from a usage JSON object, respecting provider differences.
     * - Claude: input + cache_creation + cache_read (output excluded)
     * - Codex: input + output (input already includes cached tokens)
     */
    public static int extractUsedTokens(JsonObject usage, String provider) {
        if (usage == null) return 0;
        int input = usage.has("input_tokens") ? usage.get("input_tokens").getAsInt() : 0;
        if ("codex".equals(provider)) {
            int output = usage.has("output_tokens") ? usage.get("output_tokens").getAsInt() : 0;
            return input + output;
        }
        int cacheCreation = usage.has("cache_creation_input_tokens") ? usage.get("cache_creation_input_tokens").getAsInt() : 0;
        int cacheRead = usage.has("cache_read_input_tokens") ? usage.get("cache_read_input_tokens").getAsInt() : 0;
        return calculateContextWindowTokens(input, cacheCreation, cacheRead);
    }

    /**
     * Find the last usage JSON from a list of raw server messages (JsonObject).
     * Scans from end to find the last assistant message with usage data.
     */
    public static JsonObject findLastUsageFromRawMessages(List<JsonObject> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            JsonObject msg = messages.get(i);
            if (!msg.has("type") || !"assistant".equals(msg.get("type").getAsString())) continue;
            if (msg.has("message") && msg.get("message").isJsonObject()) {
                JsonObject message = msg.getAsJsonObject("message");
                if (message.has("usage") && message.get("usage").isJsonObject()) {
                    return message.getAsJsonObject("usage");
                }
            }
        }
        return null;
    }

    /**
     * Find the last usage JSON from a list of parsed session messages.
     * Scans from end to find the last assistant message with usage data.
     */
    public static JsonObject findLastUsageFromSessionMessages(List<ClaudeSession.Message> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            ClaudeSession.Message msg = messages.get(i);
            if (msg.type != ClaudeSession.Message.Type.ASSISTANT || msg.raw == null) continue;
            // Check usage inside message object
            if (msg.raw.has("message") && msg.raw.get("message").isJsonObject()) {
                JsonObject message = msg.raw.getAsJsonObject("message");
                if (message.has("usage") && message.get("usage").isJsonObject()) {
                    return message.getAsJsonObject("usage");
                }
            }
            // Check usage at root level
            if (msg.raw.has("usage") && msg.raw.get("usage").isJsonObject()) {
                return msg.raw.getAsJsonObject("usage");
            }
        }
        return null;
    }

    private void updateTokenUsageDisplay(int inputTokens, int cacheCreationTokens, int cacheReadTokens) {
        int usedTokens = calculateContextWindowTokens(inputTokens, cacheCreationTokens, cacheReadTokens);
        int maxTokens = SettingsHandler.getModelContextLimit(state.getModel());
        ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
    }

    /**
     * Handle usage data from the [USAGE] tag emitted by ai-bridge during streaming.
     */
    private void handleUsage(String content) {
        if (content == null || content.isEmpty() || !content.startsWith("{")) return;
        try {
            JsonObject usageJson = gson.fromJson(content, JsonObject.class);
            int usedTokens = extractUsedTokens(usageJson, "claude");
            int maxTokens = SettingsHandler.getModelContextLimit(state.getModel());
            ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
            backfillUsageToAssistantMessage(usageJson);
        } catch (Exception e) {
            LOG.warn("Failed to parse usage data: " + e.getMessage());
        }
    }

    /**
     * Backfill usage data into the current assistant message's raw JSON if it has zero/missing usage.
     */
    private void backfillUsageToAssistantMessage(JsonObject usageJson) {
        if (currentAssistantMessage == null || currentAssistantMessage.raw == null) return;
        JsonObject message = currentAssistantMessage.raw.has("message") && currentAssistantMessage.raw.get("message").isJsonObject()
            ? currentAssistantMessage.raw.getAsJsonObject("message") : null;
        if (message == null) return;

        boolean needsUpdate;
        if (message.has("usage") && message.get("usage").isJsonObject()) {
            JsonObject usage = message.getAsJsonObject("usage");
            int existingInput = usage.has("input_tokens") ? usage.get("input_tokens").getAsInt() : 0;
            int existingOutput = usage.has("output_tokens") ? usage.get("output_tokens").getAsInt() : 0;
            needsUpdate = (existingInput == 0 && existingOutput == 0);
        } else {
            needsUpdate = true;
        }

        if (needsUpdate) {
            message.add("usage", usageJson);
            callbackHandler.notifyMessageUpdate(state.getMessages());
            LOG.debug("Updated assistant message usage from [USAGE] tag");
        }
    }

    private void applyThinkingDeltaToRaw(String delta) {
        if (delta == null || delta.isEmpty()) {
            return;
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
        target.addProperty("thinking", existing + delta);
    }
}
