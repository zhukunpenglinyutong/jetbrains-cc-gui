package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Codex message callback handler.
 * Processes messages returned by Codex AI.
 * Similar to ClaudeMessageHandler but handles Codex's simpler message format,
 * primarily dealing with streaming text output.
 *
 * @author melon
 * @email "mailto:melon@email.com"
 * @date 2026-04-30 16:26
 * @version 1.0.0
 * @since 1.0.0
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
    /**
     * callback handler.
     */
    private final CallbackHandler callbackHandler;

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

    /**
     * Constructor.
     *
     * @param state state
     * @param callbackHandler callback handler
     * @since 1.0.0
     */
    public CodexMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        this.state = state;
        this.callbackHandler = callbackHandler;
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
        } else {
            LOG.debug("CodexMessageHandler: Unhandled message type: " + type);
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
        boolean wasStreaming = isStreaming;
        isStreaming = false;
        streamEndedThisTurn = false;
        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);

        Message errorMessage = new Message(Message.Type.ERROR, error);
        state.addMessage(errorMessage);
        callbackHandler.notifyMessageUpdate(state.getMessages());
        if (wasStreaming) {
            callbackHandler.notifyStreamEnd();
        }
        resetStreamingAccumulator();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    /**
     * Handle completion of a response turn.
     *
     * @param result result
     * @since 1.0.0
     */
    @Override
    public void onComplete(SDKResult result) {
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

    // ===== Private methods =====

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

            if (currentAssistantMessage != null) {
                currentAssistantMessage.content = parsed.content;
                currentAssistantMessage.raw = parsed.raw;
                assistantContent.setLength(0);
                assistantContent.append(parsed.content != null ? parsed.content : "");
            } else {
                state.addMessage(parsed);
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

            state.addMessage(parsed);
            callbackHandler.notifyMessageUpdate(state.getMessages());

            LOG.debug("Codex user message (tool_result) added");
        } catch (Exception e) {
            LOG.warn("Failed to parse user message: " + e.getMessage());
        }
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
            boolean updated = attachUsageToLastAssistant(usage);
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
            if (!info.has("total_token_usage") || !info.get("total_token_usage").isJsonObject()) {
                return;
            }

            com.google.gson.JsonObject totalUsage = info.getAsJsonObject("total_token_usage");
            int inputTokens = totalUsage.has("input_tokens") ? totalUsage.get("input_tokens").getAsInt() : 0;
            int outputTokens = totalUsage.has("output_tokens") ? totalUsage.get("output_tokens").getAsInt() : 0;
            int cachedInputTokens = totalUsage.has("cached_input_tokens") ? totalUsage.get("cached_input_tokens").getAsInt() : 0;

            com.google.gson.JsonObject usage = new com.google.gson.JsonObject();
            usage.addProperty("input_tokens", inputTokens);
            usage.addProperty("output_tokens", outputTokens);
            usage.addProperty("cache_read_input_tokens", cachedInputTokens);
            usage.addProperty("cache_creation_input_tokens", 0);

            boolean updated = attachUsageToLastAssistant(usage);
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
     * Attach usage data to the last assistant message's raw field for frontend display.
     *
     * @param usage usage
     * @return boolean
     * @since 1.0.0
     */
    private boolean attachUsageToLastAssistant(com.google.gson.JsonObject usage) {
        java.util.List<Message> messages = state.getMessagesReference();
        for (int i = messages.size() - 1; i >= 0; i--) {
            Message msg = messages.get(i);
            if (msg.type == Message.Type.ASSISTANT && msg.raw != null) {
                msg.raw.add("usage", usage);
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
        // Filter out isMeta messages (e.g., "Caveat: The messages below were generated...")
        if (msg.has("isMeta") && msg.get("isMeta").getAsBoolean()) {
            return null;
        }

        // Filter out command messages (containing <command-name> or <local-command-stdout> tags)
        if (msg.has("message") && msg.get("message").isJsonObject()) {
            com.google.gson.JsonObject message = msg.getAsJsonObject("message");
            if (message.has("content")) {
                com.google.gson.JsonElement contentElement = message.get("content");
                String contentStr = null;

                if (contentElement.isJsonPrimitive()) {
                    contentStr = contentElement.getAsString();
                } else if (contentElement.isJsonArray()) {
                    // Check text content in the array
                    com.google.gson.JsonArray contentArray = contentElement.getAsJsonArray();
                    for (int i = 0; i < contentArray.size(); i++) {
                        com.google.gson.JsonElement element = contentArray.get(i);
                        if (element.isJsonObject()) {
                            com.google.gson.JsonObject block = element.getAsJsonObject();
                            if (block.has("type") && "text".equals(block.get("type").getAsString()) &&
                                block.has("text")) {
                                contentStr = block.get("text").getAsString();
                                break;
                            }
                        }
                    }
                }

                // Filter out content with command tags (allow user input containing <command-message>).
                // Codex prepends internal instruction blocks to user messages; strip them before
                // checking command tags so those hidden blocks do not hide the actual user input.
                if (contentStr != null) {
                    String filterContent = messageType == Message.Type.USER
                        ? CodexMessageConverter.stripSystemTags(contentStr)
                        : contentStr;
                    boolean hasCommandMessage = contentStr.contains("<command-message>") &&
                        contentStr.contains("</command-message>");
                    if (!hasCommandMessage && (
                        filterContent.contains("<command-name>") ||
                        filterContent.contains("<local-command-stdout>") ||
                        filterContent.contains("<local-command-stderr>") ||
                        filterContent.contains("<command-args>")
                    )) {
                        return null;
                    }
                }
            }
        }

        String content = extractMessageContent(msg);

        // Special handling for user messages: preserve tool_result even if content is empty,
        // and remove hidden Codex instruction tags from ordinary user input.
        if (messageType == Message.Type.USER) {
            boolean hasToolResult = containsToolResult(msg);
            if (!hasToolResult) {
                content = CodexMessageConverter.stripSystemTags(content);
                if (content != null && !content.trim().isEmpty()) {
                    rewriteUserRawContent(msg, content);
                }
            }
            if (content == null || content.trim().isEmpty()) {
                // Check if it contains a tool_result
                if (hasToolResult) {
                    Message result = new Message(Message.Type.USER, "[tool_result]");
                    result.raw = msg;
                    return result;
                }
                return null;
            }
        }

        // Create message and preserve the original JSON
        Message result = new Message(messageType, content != null ? content : "");
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
    private void rewriteUserRawContent(com.google.gson.JsonObject msg, String content) {
        com.google.gson.JsonArray contentBlocks = new com.google.gson.JsonArray();
        com.google.gson.JsonObject textBlock = new com.google.gson.JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", content);
        contentBlocks.add(textBlock);

        if (msg.has("message") && msg.get("message").isJsonObject()) {
            msg.getAsJsonObject("message").add("content", contentBlocks);
        } else {
            msg.add("content", contentBlocks);
        }
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
     * Handle Stream Start
     *
     * @since 1.0.0
     */
    private void handleStreamStart() {
        isStreaming = true;
        streamEndedThisTurn = false;
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
        LOG.debug("Codex message_end received, deferring stream cleanup to stream_end/onComplete");
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
