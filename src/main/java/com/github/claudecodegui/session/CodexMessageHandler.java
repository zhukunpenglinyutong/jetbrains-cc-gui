package com.github.claudecodegui.session;

import com.github.claudecodegui.CodexSDKBridge;
import com.github.claudecodegui.ClaudeSession.Message;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Codex消息回调处理器
 * 英文：Codex Message Callback Handler
 *
 * 解释：这个类专门负责处理Codex AI返回的消息
 * - 和ClaudeMessageHandler类似，但Codex的消息格式更简单
 * - 主要处理流式文本输出
 */
public class CodexMessageHandler implements CodexSDKBridge.MessageCallback {
    private static final Logger LOG = Logger.getInstance(CodexMessageHandler.class);

    private final SessionState state;
    private final CallbackHandler callbackHandler;

    // 当前助手消息的内容累积器
    // 英文：Current assistant message content accumulator
    // 解释：收集AI说的话
    private final StringBuilder assistantContent = new StringBuilder();

    // 当前助手消息对象
    // 英文：Current assistant message object
    // 解释：正在处理的消息
    private Message currentAssistantMessage = null;

    /**
     * 构造函数
     * 英文：Constructor
     * 解释：创建这个处理器
     */
    public CodexMessageHandler(SessionState state, CallbackHandler callbackHandler) {
        this.state = state;
        this.callbackHandler = callbackHandler;
    }

    /**
     * 处理收到的消息
     * 英文：Handle received message
     * 解释：Codex发来消息时的处理
     */
    @Override
    public void onMessage(String type, String content) {
        // 【FIX】添加对多种消息类型的处理
        // Codex message-service.js 会发送：
        // - type='assistant': 包含 thinking, tool_use, text
        // - type='user': 包含 tool_result
        LOG.debug("CodexMessageHandler.onMessage: type=" + type + ", content length=" + (content != null ? content.length() : 0));

        if ("assistant".equals(type)) {
            // 处理 assistant 消息（thinking, tool_use, text）
            handleAssistantMessage(content);
        } else if ("user".equals(type)) {
            // 处理 user 消息（tool_result）
            handleUserMessage(content);
        } else if ("content_delta".equals(type)) {
            // 处理流式内容增量（旧格式，保留兼容）
            handleContentDelta(content);
        } else if ("message_end".equals(type)) {
            handleMessageEnd();
        } else {
            LOG.debug("CodexMessageHandler: Unhandled message type: " + type);
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
    }

    /**
     * 处理完成
     * 英文：Handle completion
     * 解释：Codex说完了
     */
    @Override
    public void onComplete(CodexSDKBridge.SDKResult result) {
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    // ===== 私有方法 =====
    // Private Methods
    // 解释：具体处理消息的小帮手

    /**
     * 处理完整的 assistant 消息
     * 英文：Handle complete assistant message
     * 解释：处理 Codex 返回的完整消息（JSON 格式）
     * 包含 thinking, tool_use, text 等多种内容类型
     */
    private void handleAssistantMessage(String jsonContent) {
        try {
            // 解析 JSON 消息
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);

            // 创建 raw 消息用于前端渲染（保留完整 JSON 以支持 thinking, tool_use 等）
            Message message = new Message(Message.Type.ASSISTANT, "");
            message.raw = msgJson;

            // 提取并设置显示文本（用于消息列表预览）
            String displayText = extractDisplayText(msgJson);
            message.content = displayText != null ? displayText : "(processing...)";

            state.addMessage(message);
            callbackHandler.notifyMessageUpdate(state.getMessages());

            LOG.debug("Codex assistant message added with raw JSON");
        } catch (Exception e) {
            LOG.warn("Failed to parse assistant message: " + e.getMessage());
        }
    }

    /**
     * 处理 user 消息（主要是 tool_result）
     * 英文：Handle user message (mainly tool_result)
     * 解释：处理工具执行结果
     */
    private void handleUserMessage(String jsonContent) {
        try {
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);

            // 创建 user 消息
            Message message = new Message(Message.Type.USER, "");
            message.raw = msgJson;

            // tool_result 消息通常不需要显示文本，由前端根据 raw 渲染
            message.content = "[tool_result]";

            state.addMessage(message);
            callbackHandler.notifyMessageUpdate(state.getMessages());

            LOG.debug("Codex user message (tool_result) added");
        } catch (Exception e) {
            LOG.warn("Failed to parse user message: " + e.getMessage());
        }
    }

    /**
     * 提取用于显示的文本
     * 英文：Extract text for display
     * 解释：从消息 JSON 中提取合适的显示文本
     */
    private String extractDisplayText(com.google.gson.JsonObject msgJson) {
        if (msgJson == null) return null;

        if (msgJson.has("message") && msgJson.get("message").isJsonObject()) {
            com.google.gson.JsonObject message = msgJson.getAsJsonObject("message");
            if (message.has("content") && message.get("content").isJsonArray()) {
                com.google.gson.JsonArray contentArray = message.getAsJsonArray("content");
                for (com.google.gson.JsonElement elem : contentArray) {
                    if (elem.isJsonObject()) {
                        com.google.gson.JsonObject contentBlock = elem.getAsJsonObject();
                        String contentType = contentBlock.has("type") ? contentBlock.get("type").getAsString() : "";

                        // 优先显示文本内容
                        if ("text".equals(contentType) && contentBlock.has("text")) {
                            return contentBlock.get("text").getAsString();
                        }
                        // 思考过程显示为 "(thinking...)"
                        if ("thinking".equals(contentType)) {
                            return "(thinking...)";
                        }
                        // 工具调用显示工具名
                        if ("tool_use".equals(contentType) && contentBlock.has("name")) {
                            return "[Using tool: " + contentBlock.get("name").getAsString() + "]";
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * 处理内容增量（流式输出）
     * 英文：Handle content delta (streaming output)
     * 解释：Codex一字一字地说话
     */
    private void handleContentDelta(String content) {
        assistantContent.append(content);

        if (currentAssistantMessage == null) {
            currentAssistantMessage = new Message(Message.Type.ASSISTANT, assistantContent.toString());
            state.addMessage(currentAssistantMessage);
        } else {
            currentAssistantMessage.content = assistantContent.toString();
        }

        callbackHandler.notifyMessageUpdate(state.getMessages());
    }

    /**
     * 处理消息结束
     * 英文：Handle message end
     * 解释：Codex说完这条消息了
     */
    private void handleMessageEnd() {
        state.setBusy(false);
        state.setLoading(false);
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
        LOG.debug("Codex message end received");
    }
}
