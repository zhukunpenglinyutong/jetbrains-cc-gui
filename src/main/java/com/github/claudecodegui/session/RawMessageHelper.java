package com.github.claudecodegui.session;

import com.github.claudecodegui.common.CommonConstants;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Raw JSON 消息操作的工具类。
 * 抽取自 ClaudeMessageHandler 和 CodexMessageHandler 中的共享逻辑，
 * 用于操作 Message.raw JsonObject 中的 message.content 数组。
 */
public final class RawMessageHelper {

    private RawMessageHelper() {}

    /**
     * 确保当前存在一个有效的 assistant raw 消息结构。
     * 如果 raw 为 null 或缺少 message/content 结构，则创建并设置。
     *
     * @param raw 当前的 raw JsonObject，可能为 null
     * @return 保证不为 null 且包含 message.content 数组的 raw JsonObject
     */
    public static JsonObject ensureAssistantRaw(JsonObject raw) {
        if (raw == null) {
            raw = new JsonObject();
        }
        raw.addProperty(CommonConstants.JSON_KEY_TYPE, CommonConstants.MSG_TYPE_ASSISTANT);
        JsonObject message = raw.has(CommonConstants.JSON_KEY_MESSAGE)
                && raw.get(CommonConstants.JSON_KEY_MESSAGE).isJsonObject()
                ? raw.getAsJsonObject(CommonConstants.JSON_KEY_MESSAGE)
                : new JsonObject();
        if (!message.has(CommonConstants.JSON_KEY_CONTENT) || !message.get(CommonConstants.JSON_KEY_CONTENT).isJsonArray()) {
            message.add(CommonConstants.JSON_KEY_CONTENT, new JsonArray());
        }
        raw.add(CommonConstants.JSON_KEY_MESSAGE, message);
        return raw;
    }

    /**
     * 获取或创建 raw 中的 message.content 数组。
     *
     * @param raw 当前的 raw JsonObject
     * @return message.content JsonArray
     */
    public static JsonArray ensureContentArray(JsonObject raw) {
        if (raw == null) {
            return new JsonArray();
        }
        JsonObject message = raw.has(CommonConstants.JSON_KEY_MESSAGE)
                && raw.get(CommonConstants.JSON_KEY_MESSAGE).isJsonObject()
                ? raw.getAsJsonObject(CommonConstants.JSON_KEY_MESSAGE)
                : new JsonObject();
        JsonArray content = message.has(CommonConstants.JSON_KEY_CONTENT)
                && message.get(CommonConstants.JSON_KEY_CONTENT).isJsonArray()
                ? message.getAsJsonArray(CommonConstants.JSON_KEY_CONTENT)
                : new JsonArray();
        message.add(CommonConstants.JSON_KEY_CONTENT, content);
        raw.add(CommonConstants.JSON_KEY_MESSAGE, message);
        return content;
    }

    /**
     * 将文本增量追加到 raw 中的 text 块。
     * 如果最后一个块是 text 类型，则追加；否则创建新 text 块。
     *
     * @param raw   当前的 raw JsonObject
     * @param delta 要追加的文本增量
     */
    public static void applyTextDelta(JsonObject raw, String delta) {
        if (delta == null || delta.isEmpty() || raw == null) {
            return;
        }
        JsonArray contentArray = ensureContentArray(raw);
        JsonObject target = findLastBlockByType(contentArray, CommonConstants.BLOCK_TYPE_TEXT);

        if (target == null) {
            target = new JsonObject();
            target.addProperty(CommonConstants.JSON_KEY_TYPE, CommonConstants.BLOCK_TYPE_TEXT);
            target.addProperty(CommonConstants.JSON_KEY_TEXT, "");
            contentArray.add(target);
        }

        String existing = target.has(CommonConstants.JSON_KEY_TEXT)
                && !target.get(CommonConstants.JSON_KEY_TEXT).isJsonNull()
                ? target.get(CommonConstants.JSON_KEY_TEXT).getAsString()
                : "";
        target.addProperty(CommonConstants.JSON_KEY_TEXT, existing + delta);
    }

    /**
     * 将思考增量追加到 raw 中的 thinking 块。
     * 如果最后一个块是 thinking 类型，则追加；否则创建新 thinking 块。
     *
     * @param raw   当前的 raw JsonObject
     * @param delta 要追加的思考增量
     */
    public static void applyThinkingDelta(JsonObject raw, String delta) {
        if (delta == null || delta.isEmpty() || raw == null) {
            return;
        }
        JsonArray contentArray = ensureContentArray(raw);
        JsonObject target = findLastBlockByType(contentArray, CommonConstants.BLOCK_TYPE_THINKING);

        if (target == null) {
            target = new JsonObject();
            target.addProperty(CommonConstants.JSON_KEY_TYPE, CommonConstants.BLOCK_TYPE_THINKING);
            target.addProperty(CommonConstants.JSON_KEY_THINKING, "");
            target.addProperty(CommonConstants.JSON_KEY_TEXT, "");
            contentArray.add(target);
        }

        String existing = target.has(CommonConstants.JSON_KEY_THINKING)
                && !target.get(CommonConstants.JSON_KEY_THINKING).isJsonNull()
                ? target.get(CommonConstants.JSON_KEY_THINKING).getAsString()
                : "";
        String next = existing + delta;
        target.addProperty(CommonConstants.JSON_KEY_THINKING, next);
        target.addProperty(CommonConstants.JSON_KEY_TEXT, next);
    }

    /**
     * 检查 raw 消息中是否包含 tool_use 类型的块。
     *
     * @param raw 要检查的 raw JsonObject
     * @return 如果包含 tool_use 块返回 true
     */
    public static boolean hasToolUse(JsonObject raw) {
        if (raw == null || !raw.has(CommonConstants.JSON_KEY_MESSAGE)
                || !raw.get(CommonConstants.JSON_KEY_MESSAGE).isJsonObject()) {
            return false;
        }
        JsonObject messageObj = raw.getAsJsonObject(CommonConstants.JSON_KEY_MESSAGE);
        if (!messageObj.has(CommonConstants.JSON_KEY_CONTENT)
                || !messageObj.get(CommonConstants.JSON_KEY_CONTENT).isJsonArray()) {
            return false;
        }
        for (var element : messageObj.getAsJsonArray(CommonConstants.JSON_KEY_CONTENT)) {
            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                if (block.has(CommonConstants.JSON_KEY_TYPE)
                        && CommonConstants.MSG_TYPE_TOOL_USE.equals(block.get(CommonConstants.JSON_KEY_TYPE).getAsString())) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * 将一个 tool_use 块包装为 assistant 类型的 raw 消息。
     *
     * @param toolUseBlock tool_use JsonObject
     * @return 包装后的 assistant raw JsonObject
     */
    public static JsonObject wrapAsAssistantRaw(JsonObject toolUseBlock) {
        JsonArray contentArray = new JsonArray();
        contentArray.add(toolUseBlock);
        JsonObject messageObj = new JsonObject();
        messageObj.add(CommonConstants.JSON_KEY_CONTENT, contentArray);
        JsonObject rawAssistant = new JsonObject();
        rawAssistant.addProperty(CommonConstants.JSON_KEY_TYPE, CommonConstants.MSG_TYPE_ASSISTANT);
        rawAssistant.add(CommonConstants.JSON_KEY_MESSAGE, messageObj);
        return rawAssistant;
    }

    /**
     * 将一个 tool_result 块包装为 user 类型的 raw 消息。
     *
     * @param toolResultBlock tool_result JsonObject
     * @return 包装后的 user raw JsonObject
     */
    public static JsonObject wrapAsUserRaw(JsonObject toolResultBlock) {
        JsonArray contentArray = new JsonArray();
        contentArray.add(toolResultBlock);
        JsonObject messageObj = new JsonObject();
        messageObj.add(CommonConstants.JSON_KEY_CONTENT, contentArray);
        JsonObject rawUser = new JsonObject();
        rawUser.addProperty(CommonConstants.JSON_KEY_TYPE, CommonConstants.MSG_TYPE_USER);
        rawUser.add(CommonConstants.JSON_KEY_MESSAGE, messageObj);
        return rawUser;
    }

    /**
     * 在内容数组中从后向前查找指定类型的最后一个块。
     * <p>
     * 用于流式更新时定位已有的 text 或 thinking 块进行增量追加，
     * 而不是每次都创建新块。
     *
     * @param contentArray 消息内容数组
     * @param blockType    要查找的块类型（如 "text"、"thinking"）
     * @return 匹配的最后一个块，未找到返回 null
     */
    private static JsonObject findLastBlockByType(JsonArray contentArray, String blockType) {
        if (contentArray == null || contentArray.isEmpty()) {
            return null;
        }
        for (int i = contentArray.size() - 1; i >= 0; i--) {
            if (!contentArray.get(i).isJsonObject()) {
                continue;
            }
            JsonObject block = contentArray.get(i).getAsJsonObject();
            if (block.has(CommonConstants.JSON_KEY_TYPE)
                    && blockType.equals(block.get(CommonConstants.JSON_KEY_TYPE).getAsString())) {
                return block;
            }
        }
        return null;
    }
}
