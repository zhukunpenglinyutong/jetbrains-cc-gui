package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
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
public class CodexMessageHandler implements MessageCallback {
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
        } else if ("session_id".equals(type)) {
            // 处理 session_id/thread_id（用于 session 恢复）
            handleSessionId(content);
        } else if ("content_delta".equals(type) || "content".equals(type)) {
            // 处理流式内容增量（旧格式，保留兼容）
            // content_delta: 流式增量
            // content: 完整内容块
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
    public void onComplete(SDKResult result) {
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
            com.google.gson.Gson gson = new com.google.gson.Gson();
            com.google.gson.JsonObject msgJson = gson.fromJson(jsonContent, com.google.gson.JsonObject.class);

            // 应用 v0.1.3-codex 的过滤逻辑
            Message parsed = parseServerMessage(msgJson, Message.Type.ASSISTANT);
            if (parsed == null) {
                LOG.debug("Codex assistant message filtered out");
                return;
            }

            state.addMessage(parsed);
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

            // 应用 v0.1.3-codex 的过滤逻辑
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
     * 处理 session_id（Codex thread ID）
     * 英文：Handle session_id (Codex thread ID)
     * 解释：保存 Codex 的 thread ID 用于会话恢复
     */
    private void handleSessionId(String threadId) {
        if (threadId != null && !threadId.trim().isEmpty()) {
            state.setSessionId(threadId);
            callbackHandler.notifySessionIdReceived(threadId);
            LOG.info("Captured Codex thread ID: " + threadId);
        }
    }

    /**
     * 解析服务器消息（移植自 v0.1.3-codex）
     * 英文：Parse server message (ported from v0.1.3-codex)
     * 解释：完整的消息过滤和解析逻辑
     */
    private Message parseServerMessage(com.google.gson.JsonObject msg, Message.Type messageType) {
        // 过滤 isMeta 消息（如 "Caveat: The messages below were generated..."）
        if (msg.has("isMeta") && msg.get("isMeta").getAsBoolean()) {
            return null;
        }

        // 过滤命令消息（包含 <command-name> 或 <local-command-stdout> 标签）
        if (msg.has("message") && msg.get("message").isJsonObject()) {
            com.google.gson.JsonObject message = msg.getAsJsonObject("message");
            if (message.has("content")) {
                com.google.gson.JsonElement contentElement = message.get("content");
                String contentStr = null;

                if (contentElement.isJsonPrimitive()) {
                    contentStr = contentElement.getAsString();
                } else if (contentElement.isJsonArray()) {
                    // 检查数组中的文本内容
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

                // 如果内容包含命令标签，过滤掉
                if (contentStr != null && (
                    contentStr.contains("<command-name>") ||
                    contentStr.contains("<local-command-stdout>") ||
                    contentStr.contains("<local-command-stderr>") ||
                    contentStr.contains("<command-message>") ||
                    contentStr.contains("<command-args>")
                )) {
                    return null;
                }
            }
        }

        String content = extractMessageContent(msg);

        // User 消息的特殊处理：即使内容为空，也要保留 tool_result
        if (messageType == Message.Type.USER) {
            if (content == null || content.trim().isEmpty()) {
                // 检查是否包含 tool_result
                if (msg.has("message") && msg.get("message").isJsonObject()) {
                    com.google.gson.JsonObject message = msg.getAsJsonObject("message");
                    if (message.has("content") && message.get("content").isJsonArray()) {
                        com.google.gson.JsonArray contentArray = message.getAsJsonArray("content");
                        for (int i = 0; i < contentArray.size(); i++) {
                            com.google.gson.JsonElement element = contentArray.get(i);
                            if (element.isJsonObject()) {
                                com.google.gson.JsonObject block = element.getAsJsonObject();
                                if (block.has("type") && "tool_result".equals(block.get("type").getAsString())) {
                                    // 包含 tool_result，保留此消息（使用占位符内容）
                                    Message result = new Message(Message.Type.USER, "[tool_result]");
                                    result.raw = msg;
                                    return result;
                                }
                            }
                        }
                    }
                }
                return null;
            }
        }

        // 创建消息并保留原始 JSON
        Message result = new Message(messageType, content != null ? content : "");
        result.raw = msg;
        return result;
    }

    /**
     * 提取消息内容（移植自 v0.1.3-codex）
     * 英文：Extract message content (ported from v0.1.3-codex)
     */
    private String extractMessageContent(com.google.gson.JsonObject msg) {
        if (!msg.has("message")) {
            // 尝试直接从顶层获取 content（某些消息格式可能不同）
            if (msg.has("content")) {
                return extractContentFromElement(msg.get("content"));
            }
            return "";
        }

        com.google.gson.JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return "";
        }

        // 获取content元素
        com.google.gson.JsonElement contentElement = message.get("content");
        return extractContentFromElement(contentElement);
    }

    /**
     * 从 JsonElement 中提取内容（移植自 v0.1.3-codex）
     * 英文：Extract content from JsonElement (ported from v0.1.3-codex)
     */
    private String extractContentFromElement(com.google.gson.JsonElement contentElement) {
        // 字符串格式
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        // 数组格式
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

                    // 处理不同类型的内容块
                    if ("text".equals(blockType) && block.has("text") && !block.get("text").isJsonNull()) {
                        String text = block.get("text").getAsString();
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append(text);
                        hasContent = true;
                    } else if ("tool_use".equals(blockType)) {
                        // Skip tool_use, don't display tool usage text
                    } else if ("tool_result".equals(blockType)) {
                        // 工具结果 - 不展示，因为对用户没有实际意义
                        // 工具结果通常很长，且已经在 assistant 的响应中体现
                        // 这里跳过不处理
                    } else if ("thinking".equals(blockType)) {
                        // Skip thinking block, don't display fixed text
                    } else if ("image".equals(blockType)) {
                        // Skip image block, don't display fixed text
                    }
                } else if (element.isJsonPrimitive()) {
                    // 某些情况下，数组元素可能直接是字符串
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

        // 对象格式（某些特殊情况）
        if (contentElement.isJsonObject()) {
            com.google.gson.JsonObject contentObj = contentElement.getAsJsonObject();
            // 尝试提取 text 字段
            if (contentObj.has("text") && !contentObj.get("text").isJsonNull()) {
                return contentObj.get("text").getAsString();
            }
            LOG.warn("Content is an object but has no 'text' field: " + contentObj.toString());
        }

        return "";
    }

    /**
     * 处理内容增量（流式输出）
     * 英文：Handle content delta (streaming output)
     * 解释：Codex一字一字地说话
     */
    private void handleContentDelta(String content) {
        // 空内容检查（兼容 v0.1.3-codex）
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
