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

/**
 * Claude消息回调处理器
 * 英文：Claude Message Callback Handler
 *
 * 解释：这个类专门负责处理Claude AI返回的各种消息
 * - 就像一个翻译官，把Claude说的话翻译成我们能理解的格式
 * - 处理思考过程、文本内容、工具调用结果等等
 */
public class ClaudeMessageHandler implements MessageCallback {
    private static final Logger LOG = Logger.getInstance(ClaudeMessageHandler.class);

    private final Project project;
    private final SessionState state;
    private final CallbackHandler callbackHandler;
    private final MessageParser messageParser;
    private final MessageMerger messageMerger;
    private final Gson gson;

    // 当前助手消息的内容累积器
    // 英文：Current assistant message content accumulator
    // 解释：就像一个大碗，把AI说的话一点点收集起来
    private final StringBuilder assistantContent = new StringBuilder();

    // 当前助手消息对象
    // 英文：Current assistant message object
    // 解释：正在处理的消息本身
    private Message currentAssistantMessage = null;

    // 是否正在思考
    // 英文：Whether AI is thinking
    // 解释：AI是不是在想问题（还没开始说话）
    private boolean isThinking = false;

    // 🔧 流式传输状态追踪
    // 英文：Whether streaming is active
    // 解释：是否正在接收流式内容
    private boolean isStreaming = false;

    // 🔧 流式分段状态（用于在工具调用前/后切分 text/thinking）
    private boolean textSegmentActive = false;
    private boolean thinkingSegmentActive = false;

    /**
     * 构造函数
     * 英文：Constructor
     * 解释：创建这个处理器时需要的材料
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
     * 处理收到的消息
     * 英文：Handle received message
     * 解释：AI发来消息时，这个方法负责处理
     */
    @Override
    public void onMessage(String type, String content) {
        // 根据消息类型选择不同的处理方式
        // 英文：Choose different handling based on message type
        // 解释：就像分拣邮件，不同类型的信放到不同的格子里
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
                // 非流式模式：完整内容，更新消息
                handleContent(content);
                break;
            case "content_delta":
                // 🔧 流式传输：增量内容，转发给前端
                handleContentDelta(content);
                break;
            // 🔧 流式传输：思考增量
            case "thinking_delta":
                handleThinkingDelta(content);
                break;
            // 🔧 流式传输：开始和结束标记
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
                // Forward Node.js logs to frontend console
                callbackHandler.notifyNodeLog(content);
                break;
        }
    }

    /**
     * 处理错误
     * 英文：Handle error
     * 解释：出错了怎么办
     */
    @Override
    public void onError(String error) {
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
     * 处理完成
     * 英文：Handle completion
     * 解释：AI说完话了，收工
     */
    @Override
    public void onComplete(SDKResult result) {
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    // ===== 私有方法：处理各种消息类型 =====
    // Private Methods: Handle different message types
    // 解释：下面这些方法是具体处理每种消息的小帮手

    /**
     * 处理助手消息（完整JSON格式）
     * 英文：Handle assistant message (full JSON format)
     * 解释：处理AI发来的完整回复
     */
    private void handleAssistantMessage(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            // 解析完整的 JSON 消息
            JsonObject messageJson = gson.fromJson(content, JsonObject.class);
            JsonObject previousRaw = currentAssistantMessage != null ? currentAssistantMessage.raw : null;
            JsonObject mergedRaw = messageMerger.mergeAssistantMessage(previousRaw, messageJson);

            if (currentAssistantMessage == null) {
                currentAssistantMessage = new Message(Message.Type.ASSISTANT, "", mergedRaw);
                state.addMessage(currentAssistantMessage);
            } else {
                currentAssistantMessage.raw = mergedRaw;
            }

            // 🔧 流式模式：不要用完整消息覆盖已累积的流式内容（工具调用消息通常不含 text）
            // 非流式模式：使用完整消息的 text 重建内容
            String aggregatedText = messageParser.extractMessageContent(mergedRaw);
            if (!isStreaming) {
                assistantContent.setLength(0);
                if (aggregatedText != null) {
                    assistantContent.append(aggregatedText);
                }
                currentAssistantMessage.content = assistantContent.toString();
            } else if (aggregatedText != null && aggregatedText.length() > assistantContent.length()) {
                // 保守同步：如果完整文本更长，更新累积器（避免极端情况下 delta 丢失）
                assistantContent.setLength(0);
                assistantContent.append(aggregatedText);
                currentAssistantMessage.content = assistantContent.toString();
            }
            currentAssistantMessage.raw = mergedRaw;

            // 🔧 流式传输：检查是否包含工具调用
            // 如果包含 tool_use，即使在流式模式下也需要更新消息以显示工具块
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

            // 🔧 工具调用是一个“分段边界”：后续的 text/thinking 应该进入新的块
            if (hasToolUse) {
                textSegmentActive = false;
                thinkingSegmentActive = false;
            }

            // 🔧 流式传输：流式模式下跳过全量更新，除非有工具调用
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
     * 处理思考消息
     * 英文：Handle thinking message
     * 解释：AI在思考问题，还没开始说话
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
     * 处理完整内容（非流式模式）
     * 英文：Handle complete content (non-streaming mode)
     * 解释：AI发来完整的内容块，直接更新消息
     */
    private void handleContent(String content) {
        // 如果之前在思考，现在开始输出内容，说明思考完成
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

        // 🔧 流式传输：流式模式下跳过全量更新
        if (!isStreaming) {
            callbackHandler.notifyMessageUpdate(state.getMessages());
        } else {
            LOG.debug("Streaming active, skipping full message update in handleContent");
        }
    }

    /**
     * 处理内容增量（流式输出）
     * 英文：Handle content delta (streaming output)
     * 解释：AI正在一字一字地说话
     */
    private void handleContentDelta(String content) {
        // 如果之前在思考，现在开始输出内容，说明思考完成
        if (isThinking) {
            isThinking = false;
            callbackHandler.notifyThinkingStatusChanged(false);
            // Update StatusBar to show generating status
            ClaudeNotifier.setGenerating(project);
            LOG.debug("Thinking completed, generating response");
        }

        // 开始输出内容时，认为当前 thinking 段结束
        thinkingSegmentActive = false;

        // 累积内容用于最终消息
        assistantContent.append(content);

        ensureCurrentAssistantMessageExists();
        currentAssistantMessage.content = assistantContent.toString();
        applyTextDeltaToRaw(content);
        textSegmentActive = true;

        // 🔧 流式渲染：通过 updateMessages 实时刷新（与 stream 分支一致）
        callbackHandler.notifyMessageUpdate(state.getMessages());
    }

    /**
     * 处理会话ID
     * 英文：Handle session ID
     * 解释：保存这次对话的编号
     */
    private void handleSessionId(String content) {
        state.setSessionId(content);
        callbackHandler.notifySessionIdReceived(content);
        LOG.info("Captured session ID: " + content);
    }

    /**
     * 处理用户消息（来自SDK）
     * 英文：Handle user message from SDK
     * 解释：SDK返回的用户消息包含uuid，需要更新已有的用户消息；
     *       如果是包含 tool_result 的消息，需要添加到消息列表中
     */
    private void handleUserMessage(String content) {
        if (!content.startsWith("{")) {
            return;
        }

        try {
            JsonObject userMsg = gson.fromJson(content, JsonObject.class);

            // 检查是否包含 tool_result（工具调用结果）
            if (messageParser.hasToolResult(userMsg)) {
                // 这是一个包含 tool_result 的 user 消息，需要添加到消息列表
                Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", userMsg);
                state.addMessage(toolResultMessage);
                LOG.debug("Added tool_result user message to state");
                callbackHandler.notifyMessageUpdate(state.getMessages());
                return;
            }

            // 提取 uuid（用于 rewind 功能）
            String uuid = userMsg.has("uuid") ? userMsg.get("uuid").getAsString() : null;
            if (uuid == null) {
                LOG.debug("User message from SDK has no uuid, skipping update");
                return;
            }

            // 查找最后一个用户消息并更新其 raw 字段
            List<Message> messages = state.getMessages();
            for (int i = messages.size() - 1; i >= 0; i--) {
                Message msg = messages.get(i);
                if (msg.type == Message.Type.USER && msg.raw != null) {
                    // 检查这个消息是否已经有 uuid
                    if (!msg.raw.has("uuid")) {
                        // 更新 raw 字段，添加 uuid
                        msg.raw.addProperty("uuid", uuid);
                        LOG.info("Updated user message with uuid: " + uuid);
                        // 通知前端更新
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
     * 处理工具调用结果
     * 英文：Handle tool result
     * 解释：AI用了某个工具（比如搜索、计算），这是工具的结果
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
                // 构造包含 tool_result 的 user 消息
                JsonArray contentArray = new JsonArray();
                contentArray.add(toolResultBlock);

                JsonObject messageObj = new JsonObject();
                messageObj.add("content", contentArray);

                JsonObject rawUser = new JsonObject();
                rawUser.addProperty("type", "user");
                rawUser.add("message", messageObj);

                // 创建 user 消息并添加到消息列表
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
     * 处理消息结束
     * 英文：Handle message end
     * 解释：AI说完这条消息了
     */
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

    /**
     * 处理结果消息（包含使用统计）
     * 英文：Handle result message (contains usage stats)
     * 解释：最终的统计信息，比如用了多少字符
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
                int outputTokens = resultUsage.has("output_tokens") ? resultUsage.get("output_tokens").getAsInt() : 0;
                
                int usedTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
                int maxTokens = com.github.claudecodegui.handler.SettingsHandler.getModelContextLimit(state.getModel());
                
                ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
            }

            // 如果当前消息的raw中usage为0，则用result中的usage进行更新
            if (currentAssistantMessage != null && currentAssistantMessage.raw != null) {
                JsonObject message = currentAssistantMessage.raw.has("message") && currentAssistantMessage.raw.get("message").isJsonObject()
                    ? currentAssistantMessage.raw.getAsJsonObject("message")
                    : null;

                // 检查当前消息的usage是否全为0
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
     * 处理斜杠命令列表
     * 英文：Handle slash commands list
     * 解释：可用的快捷命令列表（比如 /help, /clear）
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
     * 处理系统消息
     * 英文：Handle system message
     * 解释：系统级别的消息（不是AI说的话，是系统通知）
     */
    private void handleSystemMessage(String content) {
        LOG.debug("System message: " + content);

        // 解析 system 消息中的 slash_commands 字段
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

    // ===== 🔧 流式传输处理方法 =====
    // Streaming message handlers
    // 解释：处理实时流式传输的消息

    /**
     * 处理流式开始
     * 英文：Handle stream start
     * 解释：流式传输开始，通知前端准备接收增量内容
     */
    private void handleStreamStart() {
        LOG.debug("Stream started");
        isStreaming = true;  // 🔧 标记流式传输开始
        textSegmentActive = false;
        thinkingSegmentActive = false;
        callbackHandler.notifyStreamStart();
    }

    /**
     * 处理流式结束
     * 英文：Handle stream end
     * 解释：流式传输结束，通知前端完成消息
     */
    private void handleStreamEnd() {
        LOG.debug("Stream ended");
        isStreaming = false;  // 🔧 标记流式传输结束
        textSegmentActive = false;
        thinkingSegmentActive = false;
        // 流式结束后，发送最终的消息更新，确保消息列表同步
        callbackHandler.notifyMessageUpdate(state.getMessages());
        callbackHandler.notifyStreamEnd();
    }

    /**
     * 处理思考增量
     * 英文：Handle thinking delta
     * 解释：收到思考内容的增量，转发给前端实时显示
     */
    private void handleThinkingDelta(String content) {
        // 确保思考状态已开启
        if (!isThinking) {
            isThinking = true;
            callbackHandler.notifyThinkingStatusChanged(true);
        }
        // 🔧 流式思考：将 thinking delta 写入 raw，确保结束后不会丢失
        ensureCurrentAssistantMessageExists();
        applyThinkingDeltaToRaw(content);
        thinkingSegmentActive = true;
        callbackHandler.notifyMessageUpdate(state.getMessages());
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
