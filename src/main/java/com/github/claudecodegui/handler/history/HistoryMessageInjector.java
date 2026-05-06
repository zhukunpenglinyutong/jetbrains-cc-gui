package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Service for loading session messages and injecting them into the frontend.
 * Handles both Claude and Codex session loading.
 */
public class HistoryMessageInjector {

    private static final Logger LOG = Logger.getInstance(HistoryMessageInjector.class);

    private final HandlerContext context;

    HistoryMessageInjector(HandlerContext context) {
        this.context = context;
    }

    /**
     * Load a history session.
     */
    void handleLoadSession(String sessionId, String currentProvider, HistoryHandler.SessionLoadCallback sessionLoadCallback) {
        String projectPath = context.getProject().getBasePath();
        if (projectPath == null) {
            LOG.warn("[HistoryHandler] Project base path is null");
            return;
        }
        LOG.info("[HistoryHandler] Loading history session: " + sessionId + " from project: " + projectPath + ", provider: " + currentProvider);

        if ("codex".equals(currentProvider)) {
            // Codex session: read session info and restore session state
            loadCodexSession(sessionId);
        } else {
            // Claude session: use existing callback mechanism
            if (sessionLoadCallback != null) {
                sessionLoadCallback.onLoadSession(sessionId, projectPath);
            } else {
                LOG.warn("[HistoryHandler] WARNING: No session load callback set");
            }
        }
    }

    /**
     * Load a Codex session.
     * Reads session messages directly and injects them into the frontend, while restoring session state.
     */
    private void loadCodexSession(String sessionId) {
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始加载 Codex 会话 ==========");
            LOG.info("[HistoryHandler] SessionId: " + sessionId);

            try {
                CodexHistoryReader codexReader = new CodexHistoryReader();
                String messagesJson = codexReader.getSessionMessagesAsJson(sessionId);
                JsonArray messages = JsonParser.parseString(messagesJson).getAsJsonArray();

                LOG.info("[HistoryHandler] 读取到 " + messages.size() + " 条 Codex 消息");

                // Extract session metadata and restore session state
                String[] sessionMeta = extractSessionMeta(messages);
                String threadIdToUse = sessionMeta[0] != null ? sessionMeta[0] : sessionId;
                String cwd = sessionMeta[1];

                context.getSession().setSessionInfo(threadIdToUse, cwd);
                restoreCodexMessagesToSessionState(context.getSession().getState(), messages);
                LOG.info("[HistoryHandler] 恢复 Codex 会话状态: threadId=" + threadIdToUse + " (from sessionId=" + sessionId + "), cwd=" + cwd);

                List<JsonObject> frontendMessages = convertCodexMessagesToFrontendBatch(messages);
                injectBatchToFrontend(frontendMessages);

                // Notify frontend that history messages have finished loading, trigger Markdown re-rendering
                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "if (window.historyLoadComplete) { " +
                                            "  try { " +
                                            "    window.historyLoadComplete(); " +
                                            "  } catch(e) { " +
                                            "    console.error('[HistoryHandler] historyLoadComplete callback failed:', e); " +
                                            "  } " +
                                            "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });

                LOG.info("[HistoryHandler] ========== Codex 会话加载完成 ==========");

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 加载 Codex 会话失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> {
                    String errorMsg = context.escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "if (window.addErrorMessage) { " +
                                            "  window.addErrorMessage('加载 Codex 会话失败: " + errorMsg + "'); " +
                                            "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }

    /**
     * Extract Codex session metadata (threadId and cwd).
     *
     * @return String[2]: [0]=actualThreadId, [1]=cwd
     */
    private String[] extractSessionMeta(JsonArray messages) {
        String cwd = null;
        String actualThreadId = null;

        for (int i = 0; i < messages.size(); i++) {
            JsonObject msg = messages.get(i).getAsJsonObject();
            if (msg.has("type") && "session_meta".equals(msg.get("type").getAsString())) {
                if (msg.has("payload")) {
                    JsonObject payload = msg.getAsJsonObject("payload");
                    if (payload.has("cwd")) {
                        cwd = payload.get("cwd").getAsString();
                    }
                    if (payload.has("id")) {
                        actualThreadId = payload.get("id").getAsString();
                    }
                    break;
                }
            }
        }

        return new String[]{actualThreadId, cwd};
    }

    /**
     * 将 Codex 历史消息批量转换为前端消息列表。
     * 只统一前端注入协议，不改变 Codex 历史文件格式与标题数据来源。
     */
    public static List<JsonObject> convertCodexMessagesToFrontendBatch(JsonArray messages) {
        List<JsonObject> frontendMessages = new ArrayList<>();
        for (int i = 0; i < messages.size(); i++) {
            JsonObject msg = messages.get(i).getAsJsonObject();
            JsonObject frontendMsg = convertCodexMessageToFrontend(msg);
            if (frontendMsg != null) {
                addCodexFrontendMessage(frontendMessages, frontendMsg);
            }
        }
        return frontendMessages;
    }

    private static void addCodexFrontendMessage(List<JsonObject> frontendMessages, JsonObject incoming) {
        if (frontendMessages.isEmpty()) {
            frontendMessages.add(incoming);
            return;
        }

        int lastIndex = frontendMessages.size() - 1;
        JsonObject previous = frontendMessages.get(lastIndex);
        if (isDuplicateAdjacentCodexUserMessage(previous, incoming)) {
            frontendMessages.set(lastIndex, preferRicherUserMessage(previous, incoming));
            return;
        }

        frontendMessages.add(incoming);
    }

    private static boolean isDuplicateAdjacentCodexUserMessage(JsonObject previous, JsonObject incoming) {
        if (!isUserMessage(previous) || !isUserMessage(incoming)) {
            return false;
        }

        String previousTimestamp = getStringProperty(previous, "timestamp");
        String incomingTimestamp = getStringProperty(incoming, "timestamp");
        if (previousTimestamp == null || !previousTimestamp.equals(incomingTimestamp)) {
            return false;
        }

        String previousContent = getStringProperty(previous, "content");
        String incomingContent = getStringProperty(incoming, "content");
        return previousContent != null
            && normalizeDuplicateUserContent(previousContent).equals(normalizeDuplicateUserContent(incomingContent));
    }

    private static JsonObject preferRicherUserMessage(JsonObject previous, JsonObject incoming) {
        return getRawContentBlockCount(incoming) > getRawContentBlockCount(previous) ? incoming : previous;
    }

    private static String normalizeDuplicateUserContent(String content) {
        if (content == null) {
            return "";
        }
        return content
            .replaceAll("(?m)^<image[^\\r\\n]*>\\R?", "")
            .replaceAll("(?m)^</image>\\R?", "")
            .trim();
    }

    private static boolean isUserMessage(JsonObject message) {
        return "user".equals(getStringProperty(message, "type"));
    }

    private static String getStringProperty(JsonObject object, String propertyName) {
        if (object == null || !object.has(propertyName) || object.get(propertyName).isJsonNull()) {
            return null;
        }
        return object.get(propertyName).getAsString();
    }

    private static int getRawContentBlockCount(JsonObject message) {
        if (message == null || !message.has("raw") || !message.get("raw").isJsonObject()) {
            return 0;
        }

        JsonObject raw = message.getAsJsonObject("raw");
        if (raw.has("content") && raw.get("content").isJsonArray()) {
            return raw.getAsJsonArray("content").size();
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject rawMessage = raw.getAsJsonObject("message");
            if (rawMessage.has("content") && rawMessage.get("content").isJsonArray()) {
                return rawMessage.getAsJsonArray("content").size();
            }
        }
        return 0;
    }

    /**
     * 将 Codex 历史消息恢复到后端 SessionState，保证历史加载后继续发送时，
     * 后端内存态与前端显示态使用同一份消息基线。
     */
    static void restoreCodexMessagesToSessionState(SessionState state, JsonArray messages) {
        state.clearMessages();
        List<JsonObject> frontendMessages = convertCodexMessagesToFrontendBatch(messages);
        for (JsonObject frontendMsg : frontendMessages) {
            ClaudeSession.Message restoredMessage = toSessionMessage(frontendMsg);
            if (restoredMessage != null) {
                state.addMessage(restoredMessage);
            }
        }
    }

    /**
     * 将前端统一消息结构恢复为会话内存消息结构。
     */
    private static ClaudeSession.Message toSessionMessage(JsonObject frontendMsg) {
        if (frontendMsg == null || !frontendMsg.has("type")) {
            return null;
        }

        String type = frontendMsg.get("type").getAsString();
        ClaudeSession.Message.Type messageType;
        switch (type) {
            case "user":
                messageType = ClaudeSession.Message.Type.USER;
                break;
            case "assistant":
                messageType = ClaudeSession.Message.Type.ASSISTANT;
                break;
            case "system":
                messageType = ClaudeSession.Message.Type.SYSTEM;
                break;
            case "error":
                messageType = ClaudeSession.Message.Type.ERROR;
                break;
            default:
                return null;
        }

        String content = frontendMsg.has("content") ? frontendMsg.get("content").getAsString() : "";
        JsonObject raw = frontendMsg.has("raw") && frontendMsg.get("raw").isJsonObject()
            ? frontendMsg.getAsJsonObject("raw")
            : null;
        return raw != null
            ? new ClaudeSession.Message(messageType, content, raw.deepCopy())
            : new ClaudeSession.Message(messageType, content);
    }

    /**
     * 将单条 Codex 历史消息转换为前端消息。
     * Handles both event_msg (user messages) and response_item (assistant/tool messages).
     */
    public static JsonObject convertCodexMessageToFrontend(JsonObject msg) {
        if (!msg.has("type")) {
            return null;
        }

        String type = msg.get("type").getAsString();
        JsonObject payload = msg.has("payload") && msg.get("payload").isJsonObject()
                ? msg.getAsJsonObject("payload") : null;
        if (payload == null) {
            return null;
        }

        String timestamp = msg.has("timestamp") ? msg.get("timestamp").getAsString() : null;

        // Handle event_msg containing user_message
        if ("event_msg".equals(type)) {
            return convertEventMsgToFrontend(payload, timestamp);
        }

        // Handle response_item (assistant messages, function calls, etc.)
        if ("response_item".equals(type)) {
            if (!payload.has("type")) {
                return null;
            }
            String payloadType = payload.get("type").getAsString();

            if ("message".equals(payloadType)) {
                return CodexMessageConverter.convertCodexMessageToFrontend(payload, timestamp);
            }
            if ("function_call".equals(payloadType)) {
                return CodexMessageConverter.convertFunctionCallToToolUse(payload, timestamp);
            }
            if ("function_call_output".equals(payloadType)) {
                return CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, timestamp);
            }
            if ("custom_tool_call".equals(payloadType)) {
                return CodexMessageConverter.convertCustomToolCallToToolUse(payload, timestamp);
            }
        }

        return null;
    }

    /**
     * Convert event_msg with user_message payload to frontend format.
     */
    private static JsonObject convertEventMsgToFrontend(JsonObject payload, String timestamp) {
        if (!payload.has("type") || !"user_message".equals(payload.get("type").getAsString())) {
            return null;
        }
        if (!payload.has("message") || payload.get("message").isJsonNull()) {
            return null;
        }

        String content = CodexMessageConverter.stripSystemTags(payload.get("message").getAsString());
        if (content == null || content.isBlank()) {
            return null;
        }

        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "user");
        frontendMsg.addProperty("content", content);

        // Build raw structure compatible with MessageParser
        JsonObject rawObj = new JsonObject();
        JsonArray contentBlocks = new JsonArray();
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", content);
        contentBlocks.add(textBlock);
        rawObj.add("content", contentBlocks);
        rawObj.addProperty("role", "user");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * 批量注入前端消息，复用 updateMessages 链路，避免长历史逐条追加导致最新消息显示滞后。
     */
    private void injectBatchToFrontend(List<JsonObject> frontendMessages) {
        String messagesJson = new Gson().toJson(frontendMessages);
        String escapedMessagesJson = JsUtils.escapeJs(messagesJson);

        ApplicationManager.getApplication().invokeLater(() -> {
            String jsCode = "if (window.clearMessages) { window.clearMessages(); } " +
                                    "window.__sessionTransitioning = false; " +
                                    "window.__sessionTransitionToken = null; " +
                                    "if (window.updateMessages) { window.updateMessages('" + escapedMessagesJson + "'); }";
            context.executeJavaScriptOnEDT(jsCode);
        });
    }
}
