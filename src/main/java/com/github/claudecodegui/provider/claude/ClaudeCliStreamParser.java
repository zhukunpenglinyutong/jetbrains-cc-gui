package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 解析 claude CLI stream-json 输出的每行 JSON，翻译为 MessageCallback 事件。
 * CLI 命令: claude -p --output-format stream-json --verbose --include-partial-messages
 *
 * 每行 JSON 格式示例:
 * - {"type":"system","subtype":"init","session_id":"..."}
 * - {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 * - {"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}
 * - {"type":"result","usage":{...},"result":"..."}
 */
public class ClaudeCliStreamParser {

    private static final Logger LOG = Logger.getInstance(ClaudeCliStreamParser.class);

    private final Gson gson;

    // 状态跟踪，确保 stream_start/message_start 只发送一次
    private boolean streamStarted;
    private boolean messageStarted;
    private boolean thinkingActive;
    private final StringBuilder pendingTextBlock = new StringBuilder();
    private boolean toolStructureSeenInTurn;
    private boolean textBlockAfterToolStructure;
    private boolean nextTextBlockIsAfterToolStructure;
    private TextBlockRoute currentTextBlockRoute = TextBlockRoute.NONE;

    /**
     * 每次新请求前重置状态。
     */
    public void resetState() {
        streamStarted = false;
        messageStarted = false;
        thinkingActive = false;
        toolStructureSeenInTurn = false;
        textBlockAfterToolStructure = false;
        nextTextBlockIsAfterToolStructure = false;
        currentTextBlockRoute = TextBlockRoute.NONE;
        pendingTextBlock.setLength(0);
    }

    public ClaudeCliStreamParser(Gson gson) {
        this.gson = gson;
    }

    private void handleStreamEvent(
            JsonObject obj,
            MessageCallback callback,
            StringBuilder assistantContent,
            boolean suppressThinking
    ) {
        if (!obj.has("event")) {
            return;
        }
        JsonObject event = obj.getAsJsonObject("event");
        String eventType = event.has("type") ? event.get("type").getAsString() : "";

        switch (eventType) {
            case "message_start":
                toolStructureSeenInTurn = false;
                textBlockAfterToolStructure = false;
                nextTextBlockIsAfterToolStructure = false;
                emitStreamStartIfNeeded(callback);
                emitMessageStartIfNeeded(callback);
                break;

            case "content_block_start":
                if (event.has("content_block")) {
                    JsonObject block = event.getAsJsonObject("content_block");
                    String blockType = block.has("type") ? block.get("type").getAsString() : "";
                    if ("thinking".equals(blockType)) {
                        callback.onMessage("thinking", "");
                        thinkingActive = true;
                        currentTextBlockRoute = TextBlockRoute.NONE;
                    } else if ("text".equals(blockType)) {
                        currentTextBlockRoute = TextBlockRoute.UNKNOWN;
                        textBlockAfterToolStructure = nextTextBlockIsAfterToolStructure;
                        nextTextBlockIsAfterToolStructure = false;
                        pendingTextBlock.setLength(0);
                    } else {
                        currentTextBlockRoute = TextBlockRoute.NONE;
                        if ("tool_use".equals(blockType) || "server_tool_use".equals(blockType)) {
                            toolStructureSeenInTurn = true;
                            nextTextBlockIsAfterToolStructure = true;
                        }
                    }
                }
                break;

            case "content_block_delta":
                if (event.has("delta")) {
                    JsonObject delta = event.getAsJsonObject("delta");
                    String deltaType = delta.has("type") ? delta.get("type").getAsString() : "";
                    switch (deltaType) {
                        case "text_delta":
                            String text = delta.has("text") ? delta.get("text").getAsString() : "";
                            if (!text.isEmpty()) {
                                handleTextDelta(text, callback, assistantContent);
                            }
                            break;
                        case "thinking_delta":
                            String thinking = delta.has("thinking") ? delta.get("thinking").getAsString() : "";
                            if (!thinking.isEmpty()) {
                                callback.onMessage("thinking_delta", thinking);
                            }
                            break;
                        case "input_json_delta":
                            // 工具调用的部分输入，暂时跳过
                            break;
                        default:
                            break;
                    }
                }
                break;

            case "content_block_stop":
                flushPendingTextBlock(callback, assistantContent, false);
                if (thinkingActive) {
                    thinkingActive = false;
                }
                currentTextBlockRoute = TextBlockRoute.NONE;
                textBlockAfterToolStructure = false;
                break;

            case "message_delta":
                // 包含 stop_reason 和 usage
                if (event.has("usage")) {
                    callback.onMessage("usage", event.get("usage").toString());
                }
                break;

            case "message_stop":
                flushPendingTextBlock(callback, assistantContent, false);
                // CLI agentic 模式下，Claude 会有多个 assistant turn（文字→工具调用→继续输出）。
                // message_stop 只是单个 turn 的结束，不是整个会话的结束。
                // 发送 message_end 清除 thinking 状态，重置 messageStarted 让下一个 turn
                // 的 message_start 能重新触发，从而在 handler 中创建新的 assistant 消息。
                callback.onMessage("message_end", "");
                messageStarted = false;
                LOG.debug("[CliStreamParser] message_stop received, emitted message_end for turn boundary");
                break;

            default:
                break;
        }
    }

    /**
     * 解析一行 stream-json 输出并分发到 callback。
     */
    public void parseLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            boolean suppressThinking
    ) {
        if (line == null || line.trim().isEmpty()) {
            return;
        }

        JsonObject obj;
        try {
            obj = gson.fromJson(line.trim(), JsonObject.class);
        } catch (Exception e) {
            LOG.debug("[CliStreamParser] 非JSON行，跳过: " + line);
            return;
        }

        if (obj == null || !obj.has("type")) {
            return;
        }

        String type = obj.get("type").getAsString();

        switch (type) {
            case "system":
                handleSystem(obj, callback);
                break;
            case "stream_event":
                handleStreamEvent(obj, callback, assistantContent, suppressThinking);
                break;
            case "assistant":
                handleAssistant(obj, callback);
                break;
            case "user":
                handleUser(obj, callback);
                break;
            case "result":
                handleResult(obj, callback, result, assistantContent);
                break;
            default:
                LOG.debug("[CliStreamParser] 未知类型: " + type);
                break;
        }
    }

    private void handleSystem(JsonObject obj, MessageCallback callback) {
        String subtype = obj.has("subtype") ? obj.get("subtype").getAsString() : "";

        if ("init".equals(subtype)) {
            // 提取 session_id
            if (obj.has("session_id")) {
                String sessionId = obj.get("session_id").getAsString();
                callback.onMessage("session_id", sessionId);
            }
            emitStreamStartIfNeeded(callback);
            emitMessageStartIfNeeded(callback);
        }
        // subtype="status" (如 "requesting") 跳过
    }

    private void handleAssistant(JsonObject obj, MessageCallback callback) {
        if (!obj.has("message")) {
            return;
        }
        JsonObject message = obj.getAsJsonObject("message");
        if (!message.has("content")) {
            return;
        }
        JsonArray content = message.getAsJsonArray("content");
        for (JsonElement elem : content) {
            JsonObject block = elem.getAsJsonObject();
            String blockType = block.has("type") ? block.get("type").getAsString() : "";
            if ("tool_use".equals(blockType)) {
                toolStructureSeenInTurn = true;
                nextTextBlockIsAfterToolStructure = true;
                callback.onMessage("tool_use", block.toString());
            } else if ("server_tool_use".equals(blockType)) {
                toolStructureSeenInTurn = true;
                nextTextBlockIsAfterToolStructure = true;
            }
            // text 类型的内容已通过 content_block_delta 接收，跳过
        }
    }

    private void handleUser(JsonObject obj, MessageCallback callback) {
        if (obj.has("message")) {
            JsonObject message = obj.getAsJsonObject("message");
            if (message.has("content")) {
                JsonArray content = message.getAsJsonArray("content");
                for (JsonElement elem : content) {
                    JsonObject block = elem.getAsJsonObject();
                    String blockType = block.has("type") ? block.get("type").getAsString() : "";
                    if ("tool_result".equals(blockType)) {
                        toolStructureSeenInTurn = true;
                        nextTextBlockIsAfterToolStructure = true;
                        callback.onMessage("tool_result", block.toString());
                    }
                }
            }
        }
    }

    private void handleResult(JsonObject obj, MessageCallback callback, SDKResult result, StringBuilder assistantContent) {
        flushPendingTextBlock(callback, assistantContent, false);

        // 提取 usage
        if (obj.has("usage")) {
            callback.onMessage("usage", obj.get("usage").toString());
        }

        // 提取 result 文本（最终完整回复）
        if (obj.has("result")) {
            String resultText = obj.get("result").getAsString();
            if (!resultText.isEmpty() && assistantContent.length() == 0) {
                // 没有通过 delta 收到内容时，使用 result
                assistantContent.append(resultText);
                callback.onMessage("content", resultText);
            }
        }

        // 提取 session_id（可能和 init 中的一致）
        if (obj.has("session_id")) {
            String sessionId = obj.get("session_id").getAsString();
            callback.onMessage("session_id", sessionId);
        }

        // result 是 CLI 会话的最终事件，在这里发送 stream_end 和 message_end。
        // 不能在 message_stop 时发送 stream_end，因为 agentic 模式下
        // 可能有多个 assistant turn（工具调用 → 结果 → 继续输出），
        // message_stop 只是单个 turn 的结束。
        callback.onMessage("stream_end", "");
        callback.onMessage("message_end", "");

        // 标记成功
        result.success = true;
        result.finalResult = assistantContent.toString();
    }

    private void handleTextDelta(String text, MessageCallback callback, StringBuilder assistantContent) {
        if (currentTextBlockRoute == TextBlockRoute.TOOL_TRACE) {
            callback.onMessage("thinking_delta", text);
            return;
        }
        if (currentTextBlockRoute == TextBlockRoute.CONTENT || currentTextBlockRoute == TextBlockRoute.NONE) {
            emitContentDelta(text, callback, assistantContent);
            return;
        }

        pendingTextBlock.append(text);
        String candidate = pendingTextBlock.toString();
        if (isToolTraceText(candidate)) {
            currentTextBlockRoute = TextBlockRoute.TOOL_TRACE;
            pendingTextBlock.setLength(0);
            callback.onMessage("thinking_delta", candidate);
            return;
        }
        if (!isPotentialToolTracePrefix(candidate)) {
            currentTextBlockRoute = TextBlockRoute.CONTENT;
            pendingTextBlock.setLength(0);
            emitContentDelta(candidate, callback, assistantContent);
        }
    }

    private void flushPendingTextBlock(MessageCallback callback, StringBuilder assistantContent, boolean forceToolTrace) {
        if (pendingTextBlock.length() == 0) {
            return;
        }
        String text = pendingTextBlock.toString();
        pendingTextBlock.setLength(0);
        if (forceToolTrace || currentTextBlockRoute == TextBlockRoute.TOOL_TRACE || isToolTraceText(text)) {
            callback.onMessage("thinking_delta", text);
            return;
        }
        emitContentDelta(text, callback, assistantContent);
    }

    private void emitContentDelta(String text, MessageCallback callback, StringBuilder assistantContent) {
        assistantContent.append(text);
        callback.onMessage("content_delta", text);
    }

    private boolean isToolTraceText(String text) {
        String normalized = normalizeToolTraceText(text);
        if (normalized.contains("built-in tool") || normalized.contains("executing on server")) {
            return true;
        }
        if (textBlockAfterToolStructure && startsWithToolTraceLabel(normalized)) {
            return true;
        }
        return false;
    }

    private boolean isPotentialToolTracePrefix(String text) {
        String normalized = normalizeToolTraceText(text);
        if (normalized.isEmpty()) {
            return true;
        }
        if (normalized.length() > 128) {
            return false;
        }
        if (prefixMatches("built-in tool", normalized) || prefixMatches("executing on server", normalized)) {
            return true;
        }
        if (containsOnlyDecorationPrefix(text)) {
            return true;
        }
        if (textBlockAfterToolStructure) {
            return prefixMatches("input:", normalized) || prefixMatches("output:", normalized) || prefixMatches("input", normalized) || prefixMatches("output", normalized);
        }
        return false;
    }

    private boolean startsWithToolTraceLabel(String normalized) {
        return normalized.startsWith("input:") || normalized.startsWith("output:") || normalized.startsWith("input\n") || normalized.startsWith("output\n");
    }

    private boolean prefixMatches(String full, String candidate) {
        return full.startsWith(candidate) || candidate.startsWith(full);
    }

    private boolean containsOnlyDecorationPrefix(String text) {
        if (text == null) {
            return false;
        }
        String stripped = text.stripLeading();
        if (stripped.isEmpty()) {
            return true;
        }
        for (int i = 0; i < stripped.length(); i++) {
            if (Character.isLetterOrDigit(stripped.charAt(i))) {
                return false;
            }
        }
        return stripped.length() <= 8;
    }

    private String normalizeToolTraceText(String text) {
        String normalized = text == null ? "" : text.toLowerCase(Locale.ROOT).stripLeading();
        while (!normalized.isEmpty()) {
            char ch = normalized.charAt(0);
            if (!Character.isLetterOrDigit(ch)) {
                normalized = normalized.substring(1).stripLeading();
                continue;
            }
            break;
        }
        return normalized;
    }

    private enum TextBlockRoute {
        NONE, UNKNOWN, CONTENT, TOOL_TRACE
    }

    private void emitStreamStartIfNeeded(MessageCallback callback) {
        if (!streamStarted) {
            streamStarted = true;
            callback.onMessage("stream_start", "");
        }
    }

    private void emitMessageStartIfNeeded(MessageCallback callback) {
        if (!messageStarted) {
            messageStarted = true;
            callback.onMessage("message_start", "");
        }
    }
}
