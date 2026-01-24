package com.github.claudecodegui.session;

import com.github.claudecodegui.ClaudeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * 消息解析器
 * 负责解析服务器返回的消息并转换为 Message 对象
 */
public class MessageParser {
    private static final Logger LOG = Logger.getInstance(MessageParser.class);

    /**
     * 解析服务器返回的消息
     */
    public ClaudeSession.Message parseServerMessage(JsonObject msg) {
        String type = msg.has("type") ? msg.get("type").getAsString() : null;

        // 过滤 isMeta 消息
        if (msg.has("isMeta") && msg.get("isMeta").getAsBoolean()) {
            return null;
        }

        // 过滤命令消息
        if (shouldFilterCommandMessage(msg)) {
            return null;
        }

        if ("user".equals(type)) {
            String content = extractMessageContent(msg);
            // 检查是否包含 tool_result
            if (content == null || content.trim().isEmpty()) {
                if (hasToolResult(msg)) {
                    return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "[tool_result]", msg);
                }
                return null;
            }
            return new ClaudeSession.Message(ClaudeSession.Message.Type.USER, content, msg);
        } else if ("assistant".equals(type)) {
            String content = extractMessageContent(msg);
            return new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, content, msg);
        }

        return null;
    }

    /**
     * 检查是否应该过滤命令消息
     */
    private boolean shouldFilterCommandMessage(JsonObject msg) {
        if (!msg.has("message") || !msg.get("message").isJsonObject()) {
            return false;
        }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content")) {
            return false;
        }

        JsonElement contentElement = message.get("content");
        String contentStr = null;

        if (contentElement.isJsonPrimitive()) {
            contentStr = contentElement.getAsString();
        } else if (contentElement.isJsonArray()) {
            JsonArray contentArray = contentElement.getAsJsonArray();
            for (int i = 0; i < contentArray.size(); i++) {
                JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    JsonObject block = element.getAsJsonObject();
                    if (block.has("type") && "text".equals(block.get("type").getAsString()) &&
                        block.has("text")) {
                        contentStr = block.get("text").getAsString();
                        break;
                    }
                }
            }
        }

        // 过滤包含命令标签的内容（允许包含 <command-message> 的用户输入）
        if (contentStr != null) {
            boolean hasCommandMessage = contentStr.contains("<command-message>") &&
                contentStr.contains("</command-message>");
            if (!hasCommandMessage && (
                contentStr.contains("<command-name>") ||
                contentStr.contains("<local-command-stdout>") ||
                contentStr.contains("<local-command-stderr>") ||
                contentStr.contains("<command-args>")
            )) {
                return true;
            }
        }

        return false;
    }

    /**
     * 检查消息是否包含 tool_result
     */
    public boolean hasToolResult(JsonObject msg) {
        if (!msg.has("message") || !msg.get("message").isJsonObject()) {
            return false;
        }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || !message.get("content").isJsonArray()) {
            return false;
        }

        JsonArray contentArray = message.getAsJsonArray("content");
        for (int i = 0; i < contentArray.size(); i++) {
            JsonElement element = contentArray.get(i);
            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                if (block.has("type") && "tool_result".equals(block.get("type").getAsString())) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * 提取消息内容
     */
    public String extractMessageContent(JsonObject msg) {
        if (!msg.has("message")) {
            if (msg.has("content")) {
                return extractContentFromElement(msg.get("content"));
            }
            return "";
        }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return "";
        }

        return extractContentFromElement(message.get("content"));
    }

    /**
     * 从 JsonElement 中提取内容
     */
    private String extractContentFromElement(JsonElement contentElement) {
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        if (contentElement.isJsonArray()) {
            return extractFromArrayContent(contentElement.getAsJsonArray());
        }

        if (contentElement.isJsonObject()) {
            JsonObject contentObj = contentElement.getAsJsonObject();
            if (contentObj.has("text") && !contentObj.get("text").isJsonNull()) {
                return contentObj.get("text").getAsString();
            }
            LOG.warn("Content is an object but has no 'text' field: " + contentObj.toString());
        }

        return "";
    }

    /**
     * 从数组格式的内容中提取文本
     */
    private String extractFromArrayContent(JsonArray contentArray) {
        StringBuilder sb = new StringBuilder();
        boolean hasContent = false;

        for (int i = 0; i < contentArray.size(); i++) {
            JsonElement element = contentArray.get(i);
            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                String blockType = (block.has("type") && !block.get("type").isJsonNull())
                    ? block.get("type").getAsString()
                    : null;

                if ("text".equals(blockType) && block.has("text") && !block.get("text").isJsonNull()) {
                    if (sb.length() > 0) {
                        sb.append("\n");
                    }
                    sb.append(block.get("text").getAsString());
                    hasContent = true;
                } else if ("tool_use".equals(blockType)) {
                    // Skip tool_use block, don't display tool usage text
                } else if ("thinking".equals(blockType)) {
                    // Skip thinking block, don't display fixed text
                } else if ("image".equals(blockType)) {
                    // Skip image block, don't display fixed text
                }
            } else if (element.isJsonPrimitive()) {
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
}
