package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

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

    public ClaudeCliStreamParser(Gson gson) {
        this.gson = gson;
    }

    /**
     * 每次新请求前重置状态。
     */
    public void resetState() {
        streamStarted = false;
        messageStarted = false;
        thinkingActive = false;
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
                emitStreamStartIfNeeded(callback);
                emitMessageStartIfNeeded(callback);
                break;

            case "content_block_start":
                if (event.has("content_block")) {
                    JsonObject block = event.getAsJsonObject("content_block");
                    String blockType = block.has("type") ? block.get("type").getAsString() : "";
                    if ("thinking".equals(blockType)) {
                        if (!suppressThinking) {
                            callback.onMessage("thinking", "");
                        }
                        thinkingActive = true;
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
                                assistantContent.append(text);
                                callback.onMessage("content_delta", text);
                            }
                            break;
                        case "thinking_delta":
                            String thinking = delta.has("thinking") ? delta.get("thinking").getAsString() : "";
                            if (!thinking.isEmpty() && !suppressThinking) {
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
                if (thinkingActive) {
                    thinkingActive = false;
                }
                break;

            case "message_delta":
                // 包含 stop_reason 和 usage
                if (event.has("usage")) {
                    callback.onMessage("usage", event.get("usage").toString());
                }
                break;

            case "message_stop":
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
                callback.onMessage("tool_use", block.toString());
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
                        callback.onMessage("tool_result", block.toString());
                    }
                }
            }
        }
    }

    private void handleResult(JsonObject obj, MessageCallback callback, SDKResult result, StringBuilder assistantContent) {
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
