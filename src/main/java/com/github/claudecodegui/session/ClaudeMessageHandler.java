package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.ClaudeSession.Message;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.ArrayList;
import java.util.List;

public class ClaudeMessageHandler implements MessageCallback {
    private static final Logger LOG = Logger.getInstance(ClaudeMessageHandler.class);

    private final Project project;
    private final SessionState state;
    private final CallbackHandler callbackHandler;
    private final MessageParser messageParser;
    private final MessageMerger messageMerger;
    private final Gson gson;

    private final StringBuilder assistantContent = new StringBuilder();
    private Message currentAssistantMessage = null;
    private boolean isThinking = false;
    private boolean isStreaming = false;
    private boolean textSegmentActive = false;
    private boolean thinkingSegmentActive = false;

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

    @Override
    public void onMessage(String type, String content) {
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
                handleContent(content);
                break;
            case "content_delta":
                handleContentDelta(content);
                break;
            case "thinking_delta":
                handleThinkingDelta(content);
                break;
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
            case "slash_commands":
                handleSlashCommands(content);
                break;
            case "system":
                handleSystemMessage(content);
                break;
            case "node_log":
                callbackHandler.notifyNodeLog(content);
                break;
        }
    }

    @Override
    public void onError(String error) {
        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);

        Message errorMessage = new Message(Message.Type.ERROR, error);
        state.addMessage(errorMessage);
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());

        ClaudeNotifier.showError(project, error);
    }

    @Override
    public void onComplete(SDKResult result) {
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    private void handleAssistantMessage(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            JsonObject messageJson = gson.fromJson(content, JsonObject.class);
            JsonObject previousRaw = currentAssistantMessage != null ? currentAssistantMessage.raw : null;
            JsonObject mergedRaw = messageMerger.mergeAssistantMessage(previousRaw, messageJson);

            if (currentAssistantMessage == null) {
                currentAssistantMessage = new Message(Message.Type.ASSISTANT, "", mergedRaw);
                state.addMessage(currentAssistantMessage);
            } else {
                currentAssistantMessage.raw = mergedRaw;
            }

            String aggregatedText = messageParser.extractMessageContent(mergedRaw);
            if (!isStreaming) {
                assistantContent.setLength(0);
                if (aggregatedText != null) {
                    assistantContent.append(aggregatedText);
                }
                currentAssistantMessage.content = assistantContent.toString();
            } else if (aggregatedText != null && aggregatedText.length() > assistantContent.length()) {
                assistantContent.setLength(0);
                assistantContent.append(aggregatedText);
                currentAssistantMessage.content = assistantContent.toString();
            }
            currentAssistantMessage.raw = mergedRaw;

            boolean hasToolUse = false;
            if (mergedRaw.has("message") && mergedRaw.getAsJsonObject("message").has("content")) {
                var contentArray = mergedRaw.getAsJsonObject("message").get("content");
                if (contentArray.isJsonArray()) {
                    for (var element : contentArray.getAsJsonArray()) {
                        if (element.isJsonObject() && element.getAsJsonObject().has("type")) {
                            String msgType = element.getAsJsonObject().get("type").getAsString();
                            if ("tool_use".equals(msgType)) {
                                hasToolUse = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (hasToolUse) {
                textSegmentActive = false;
                thinkingSegmentActive = false;
            }

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

    private void handleThinkingMessage() {
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
            ClaudeNotifier.setThinking(project);
            LOG.debug("Thinking started");
        }
    }

    private void handleContent(String content) {
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

        if (!isStreaming) {
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } else {
            LOG.debug("Streaming active, skipping full message update in handleContent");
        }
    }

    private void handleContentDelta(String content) {
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
            ClaudeNotifier.setGenerating(project);
            LOG.debug("Thinking completed, generating response");
        }

        thinkingSegmentActive = false;

        assistantContent.append(content);

        ensureCurrentAssistantMessageExists();
        currentAssistantMessage.content = assistantContent.toString();
        applyTextDeltaToRaw(content);
        textSegmentActive = true;

        callbackHandler.notifyContentDelta(content);
    }

    private void handleSessionId(String content) {
        state.setSessionId(content);
        callbackHandler.notifySessionIdReceived(content);
        LOG.info("Captured session ID: " + content);
    }

    private void handleUserMessage(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            JsonObject userMsg = gson.fromJson(content, JsonObject.class);

            String uuid = userMsg.has("uuid") ? userMsg.get("uuid").getAsString() : null;
            if (uuid == null) {
                LOG.debug("User message from SDK has no uuid, skipping update");
                return;
            }

            List<Message> messages = state.getMessages();
            for (int i = messages.size() - 1; i >= 0; i--) {
                Message msg = messages.get(i);
                if (msg.type == Message.Type.USER && msg.raw != null) {
                    if (!msg.raw.has("uuid")) {
                        msg.raw.addProperty("uuid", uuid);
                        LOG.info("Updated user message with uuid: " + uuid);
                        callbackHandler.notifyMessageUpdate(messages);
                        break;
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to parse user message from SDK: " + e.getMessage());
        }
    }

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
                JsonArray contentArray = new JsonArray();
                contentArray.add(toolResultBlock);

                JsonObject messageObj = new JsonObject();
                messageObj.add("content", contentArray);

                JsonObject rawUser = new JsonObject();
                rawUser.addProperty("type", "user");
                rawUser.add("message", messageObj);

                Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", rawUser);
                state.addMessage(toolResultMessage);

                LOG.debug("Tool result received for tool_use_id: " + toolUseId);
                callbackHandler.notifyMessageUpdate(state.getMessages());
            }
        } catch (Exception e) {
            LOG.warn("Failed to parse tool_result JSON: " + e.getMessage());
        }
    }

    private void handleMessageEnd() {
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
        }
        ClaudeNotifier.clearStatus(project);
        state.setBusy(false);
        state.setLoading(false);
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    private void handleResult(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            JsonObject resultJson = gson.fromJson(content, JsonObject.class);
            LOG.debug("Result message received");

            if (resultJson.has("usage")) {
                JsonObject resultUsage = resultJson.getAsJsonObject("usage");

                int inputTokens = resultUsage.has("input_tokens") ? resultUsage.get("input_tokens").getAsInt() : 0;
                int cacheWriteTokens = resultUsage.has("cache_creation_input_tokens") ? resultUsage.get("cache_creation_input_tokens").getAsInt() : 0;
                int cacheReadTokens = resultUsage.has("cache_read_input_tokens") ? resultUsage.get("cache_read_input_tokens").getAsInt() : 0;
                int outputTokens = resultUsage.has("output_tokens") ? resultUsage.get("output_tokens").getAsInt() : 0;

                int usedTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
                int maxTokens = com.github.claudecodegui.handler.SettingsHandler.getModelContextLimit(state.getModel());

                ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
            }

            if (currentAssistantMessage != null && currentAssistantMessage.raw != null) {
                JsonObject message = currentAssistantMessage.raw.has("message") && currentAssistantMessage.raw.get("message").isJsonObject()
                    ? currentAssistantMessage.raw.getAsJsonObject("message")
                    : null;

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

    private void handleSystemMessage(String content) {
        LOG.debug("System message: " + content);

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

    private void handleStreamStart() {
        LOG.debug("Stream started");
        isStreaming = true;
        textSegmentActive = false;
        thinkingSegmentActive = false;
        callbackHandler.notifyStreamStart();
    }

    private void handleStreamEnd() {
        LOG.debug("Stream ended");
        isStreaming = false;
        textSegmentActive = false;
        thinkingSegmentActive = false;
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStreamEnd();
    }

    private void handleThinkingDelta(String content) {
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
        }
        ensureCurrentAssistantMessageExists();
        applyThinkingDeltaToRaw(content);
        thinkingSegmentActive = true;
        callbackHandler.notifyThinkingDelta(content);
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
