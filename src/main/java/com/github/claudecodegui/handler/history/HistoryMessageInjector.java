package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.util.AttachmentStorageService;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Service for loading session messages and injecting them into the frontend.
 * Handles both Claude and Codex session loading.
 */
public class HistoryMessageInjector {

    private static final Logger LOG = Logger.getInstance(HistoryMessageInjector.class);

    /**
     * Maximum gap between two adjacent Codex user records that are still treated
     * as the same SDK double-write. 500 ms comfortably covers the small jitter
     * between the rollout's response_item and event_msg entries while leaving
     * real back-to-back user messages alone.
     */
    private static final long DUPLICATE_USER_MESSAGE_WINDOW_MILLIS = 500L;

    private final HandlerContext context;

    HistoryMessageInjector(HandlerContext context) {
        this.context = context;
    }

    /**
     * Load a history session.
     */
    void handleLoadSession(String sessionId, String currentProvider, HistoryHandler.SessionLoadCallback sessionLoadCallback) {
        String provider = currentProvider;
        String resolvedSessionId = sessionId;

        try {
            JsonObject payload = new Gson().fromJson(sessionId, JsonObject.class);
            if (payload != null) {
                if (payload.has("sessionId") && !payload.get("sessionId").isJsonNull()) {
                    resolvedSessionId = payload.get("sessionId").getAsString();
                }
                if (payload.has("provider") && !payload.get("provider").isJsonNull()) {
                    provider = payload.get("provider").getAsString();
                }
            }
        } catch (Exception ignored) {
            // Backward compatible: legacy payload is the raw sessionId string.
        }

        String projectPath = context.getProject().getBasePath();
        if (projectPath == null) {
            LOG.warn("[HistoryHandler] Project base path is null");
            return;
        }
        LOG.info("[HistoryHandler] Loading history session: " + resolvedSessionId
                + " from project: " + projectPath + ", provider: " + provider);

        if ("codex".equals(provider)) {
            // Codex session: read session info and restore session state
            loadCodexSession(resolvedSessionId);
        } else {
            // Claude session: use existing callback mechanism
            if (sessionLoadCallback != null) {
                sessionLoadCallback.onLoadSession(resolvedSessionId, projectPath, provider);
            } else {
                LOG.warn("[HistoryHandler] WARNING: No session load callback set");
            }
        }
    }

    /**
     * Load a Codex session.
     * Reads session messages directly and injects them into the frontend, while restoring session state.
     */
    void loadCodexSession(String sessionId) {
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
        Set<String> emittedCliToolUseIds = new HashSet<>();
        for (int i = 0; i < messages.size(); i++) {
            JsonObject msg = messages.get(i).getAsJsonObject();
            List<JsonObject> convertedMessages = convertCodexMessageToFrontendMessages(msg, emittedCliToolUseIds);
            for (JsonObject frontendMsg : convertedMessages) {
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

        // tool_result entries are one-to-one with their originating tool_use via
        // `tool_use_id`; the SDK never double-writes a single tool_result, and two
        // batch-run outputs returning within the dedup time window have identical
        // placeholder content ("[tool_result]"). Treating them as duplicates would
        // drop the trailing tool_result and leave its tool_use stuck on the
        // pending spinner. Skip dedup whenever either side carries a tool_result.
        if (hasToolResultContentBlock(previous) || hasToolResultContentBlock(incoming)) {
            return false;
        }

        String previousContent = getStringProperty(previous, "content");
        String incomingContent = getStringProperty(incoming, "content");
        if (previousContent == null
            || !normalizeDuplicateUserContent(previousContent).equals(normalizeDuplicateUserContent(incomingContent))) {
            return false;
        }

        // Codex SDK writes the same user turn twice into rollout: a `response_item`
        // whose text is wrapped with `<image name=[Image #N]>...</image>`, and an
        // `event_msg` whose `local_images` carries the real image path. When either
        // record exposes an image signal (text marker or content block), they are
        // mirror writes of the same turn and should be deduplicated regardless of
        // whether their timestamps line up to the millisecond.
        if (hasInlineImageMarker(previousContent) || hasInlineImageMarker(incomingContent)
            || hasImageContentBlock(previous) || hasImageContentBlock(incoming)) {
            return true;
        }

        // Otherwise fall back to a tight timestamp window so we still catch SDK
        // double-writes for text-only turns without accidentally merging two
        // identical user messages typed seconds apart.
        return timestampsWithinWindow(previous, incoming, DUPLICATE_USER_MESSAGE_WINDOW_MILLIS);
    }

    private static JsonObject preferRicherUserMessage(JsonObject previous, JsonObject incoming) {
        // Prefer the variant that carries an actual image content block so the
        // history view shows the rendered image rather than the `<image>` wrapper.
        boolean previousHasImage = hasImageContentBlock(previous);
        boolean incomingHasImage = hasImageContentBlock(incoming);
        if (previousHasImage != incomingHasImage) {
            return previousHasImage ? previous : incoming;
        }
        return getRawContentBlockCount(incoming) > getRawContentBlockCount(previous) ? incoming : previous;
    }

    private static boolean hasInlineImageMarker(String content) {
        return content != null && content.contains("<image");
    }

    private static boolean hasImageContentBlock(JsonObject message) {
        JsonArray contentBlocks = extractRawContentBlocks(message);
        if (contentBlocks == null) {
            return false;
        }
        for (JsonElement element : contentBlocks) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject block = element.getAsJsonObject();
            if (block.has("type") && "image".equals(block.get("type").getAsString())) {
                return true;
            }
        }
        return false;
    }

    private static boolean hasToolResultContentBlock(JsonObject message) {
        JsonArray contentBlocks = extractRawContentBlocks(message);
        if (contentBlocks == null) {
            return false;
        }
        for (JsonElement element : contentBlocks) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject block = element.getAsJsonObject();
            if (block.has("type") && "tool_result".equals(block.get("type").getAsString())) {
                return true;
            }
        }
        return false;
    }

    private static JsonArray extractRawContentBlocks(JsonObject message) {
        if (message == null || !message.has("raw") || !message.get("raw").isJsonObject()) {
            return null;
        }
        JsonObject raw = message.getAsJsonObject("raw");
        if (raw.has("content") && raw.get("content").isJsonArray()) {
            return raw.getAsJsonArray("content");
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject rawMessage = raw.getAsJsonObject("message");
            if (rawMessage.has("content") && rawMessage.get("content").isJsonArray()) {
                return rawMessage.getAsJsonArray("content");
            }
        }
        return null;
    }

    private static boolean timestampsWithinWindow(JsonObject previous, JsonObject incoming, long windowMillis) {
        String prev = getStringProperty(previous, "timestamp");
        String curr = getStringProperty(incoming, "timestamp");
        if (prev == null || curr == null) {
            return false;
        }
        try {
            long prevMillis = java.time.Instant.parse(prev).toEpochMilli();
            long currMillis = java.time.Instant.parse(curr).toEpochMilli();
            return Math.abs(currMillis - prevMillis) <= windowMillis;
        } catch (Exception ignored) {
            return prev.equals(curr);
        }
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
        List<JsonObject> messages = convertCodexMessageToFrontendMessages(msg, new HashSet<>());
        return messages.isEmpty() ? null : messages.get(0);
    }

    private static List<JsonObject> convertCodexMessageToFrontendMessages(JsonObject msg, Set<String> emittedCliToolUseIds) {
        if (!msg.has("type")) {
            return List.of();
        }

        String type = msg.get("type").getAsString();
        JsonObject payload = msg.has("payload") && msg.get("payload").isJsonObject()
                ? msg.getAsJsonObject("payload") : null;
        String timestamp = msg.has("timestamp") ? msg.get("timestamp").getAsString() : null;

        if (type.startsWith("item.")) {
            JsonObject item = msg.has("item") && msg.get("item").isJsonObject()
                    ? msg.getAsJsonObject("item") : null;
            return convertCliItemToFrontendMessages(type, item, timestamp, emittedCliToolUseIds);
        }

        if (payload == null) {
            return List.of();
        }

        if ("provider_error".equals(type)) {
            JsonObject converted = convertProviderErrorToFrontend(payload, timestamp);
            return converted == null ? List.of() : List.of(converted);
        }

        // Handle event_msg containing user_message
        if ("event_msg".equals(type)) {
            JsonObject converted = convertEventMsgToFrontend(payload, timestamp);
            return converted == null ? List.of() : List.of(converted);
        }

        // Handle response_item (assistant messages, function calls, etc.)
        if ("response_item".equals(type)) {
            if (!payload.has("type")) {
                return List.of();
            }
            String payloadType = payload.get("type").getAsString();

            JsonObject converted = null;
            if ("message".equals(payloadType)) {
                converted = CodexMessageConverter.convertCodexMessageToFrontend(payload, timestamp);
            } else if ("function_call".equals(payloadType)) {
                converted = CodexMessageConverter.convertFunctionCallToToolUse(payload, timestamp);
            } else if ("function_call_output".equals(payloadType)) {
                converted = CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, timestamp);
            } else if ("custom_tool_call".equals(payloadType)) {
                converted = CodexMessageConverter.convertCustomToolCallToToolUse(payload, timestamp);
            }
            return converted == null ? List.of() : List.of(converted);
        }

        return List.of();
    }

    private static JsonObject convertProviderErrorToFrontend(JsonObject payload, String timestamp) {
        String details = firstNonBlank(getString(payload, "details"), getString(payload, "message"), getString(payload, "error"));
        String summary = firstNonBlank(getString(payload, "summary"), summarizeProviderError(details));
        if (details == null || details.isBlank()) {
            details = summary;
        }
        if (summary == null || summary.isBlank()) {
            summary = "Codex 响应失败";
        }

        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "assistant");
        frontendMsg.addProperty("content", summary);

        JsonObject errorBlock = new JsonObject();
        errorBlock.addProperty("type", "provider_error");
        errorBlock.addProperty("provider", firstNonBlank(getString(payload, "provider"), "codex"));
        errorBlock.addProperty("summary", summary);
        errorBlock.addProperty("details", details);
        if (payload.has("exitCode") && !payload.get("exitCode").isJsonNull()) {
            errorBlock.add("exitCode", payload.get("exitCode").deepCopy());
        }
        if (payload.has("requestId") && !payload.get("requestId").isJsonNull()) {
            errorBlock.add("requestId", payload.get("requestId").deepCopy());
        }
        if (payload.has("url") && !payload.get("url").isJsonNull()) {
            errorBlock.add("url", payload.get("url").deepCopy());
        }

        JsonArray content = new JsonArray();
        content.add(errorBlock);

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "assistant");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }
        return frontendMsg;
    }

    private static String summarizeProviderError(String details) {
        if (details == null || details.isBlank()) {
            return null;
        }
        String trimmed = details.trim();
        int reasonIndex = trimmed.indexOf("原因：");
        if (reasonIndex >= 0 && reasonIndex + 3 < trimmed.length()) {
            return trimmed.substring(reasonIndex + 3).trim();
        }
        return trimmed.length() <= 80 ? trimmed : trimmed.substring(0, 80) + "...";
    }

    private static List<JsonObject> convertCliItemToFrontendMessages(
            String eventType,
            JsonObject item,
            String timestamp,
            Set<String> emittedToolUseIds
    ) {
        if (item == null || !item.has("type")) {
            return List.of();
        }

        String itemType = item.get("type").getAsString();
        if ("agent_message".equals(itemType)) {
            String text = getString(item, "text");
            if (text == null || text.isBlank()) {
                return List.of();
            }
            return List.of(createTextAssistantMessage(text, timestamp));
        }

        if ("command_execution".equals(itemType)) {
            return convertCliCommandExecutionItem(eventType, item, timestamp, emittedToolUseIds);
        }

        if ("mcp_tool_call".equals(itemType)) {
            return convertCliMcpToolCallItem(eventType, item, timestamp, emittedToolUseIds);
        }

        return List.of();
    }

    private static List<JsonObject> convertCliCommandExecutionItem(
            String eventType,
            JsonObject item,
            String timestamp,
            Set<String> emittedToolUseIds
    ) {
        String id = firstNonBlank(getString(item, "id"), getString(item, "call_id"), "command_execution");
        String command = firstNonBlank(getString(item, "command"), getString(item, "cmd"), getString(item, "program"), "(unknown command)");
        JsonObject input = new JsonObject();
        input.addProperty("command", command);
        input.addProperty("description", commandDescription(command));

        List<JsonObject> messages = new ArrayList<>();
        addToolUseIfNeeded(messages, emittedToolUseIds, id, "Bash", input, timestamp);

        if ("item.completed".equals(eventType)) {
            messages.add(createToolResultMessage(id, isCliItemError(item), extractCliCommandOutput(item), timestamp));
        }

        return messages;
    }

    private static List<JsonObject> convertCliMcpToolCallItem(
            String eventType,
            JsonObject item,
            String timestamp,
            Set<String> emittedToolUseIds
    ) {
        String id = firstNonBlank(getString(item, "id"), getString(item, "call_id"), "mcp_tool_call");
        String toolName = normalizeMcpToolName(getString(item, "server"), getString(item, "tool"));
        JsonObject input = item.has("arguments") && item.get("arguments").isJsonObject()
                ? item.getAsJsonObject("arguments")
                : new JsonObject();

        List<JsonObject> messages = new ArrayList<>();
        addToolUseIfNeeded(messages, emittedToolUseIds, id, toolName, input, timestamp);

        if ("item.completed".equals(eventType)) {
            messages.add(createToolResultMessage(id, isCliItemError(item) || item.has("error"), extractCliMcpResult(item), timestamp));
        }

        return messages;
    }

    private static void addToolUseIfNeeded(
            List<JsonObject> messages,
            Set<String> emittedToolUseIds,
            String id,
            String name,
            JsonObject input,
            String timestamp
    ) {
        if (!emittedToolUseIds.add(id)) {
            return;
        }
        messages.add(createToolUseMessage(id, name, input, timestamp));
    }

    private static JsonObject createTextAssistantMessage(String text, String timestamp) {
        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "assistant");
        frontendMsg.addProperty("content", text);

        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);
        JsonArray content = new JsonArray();
        content.add(textBlock);

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "assistant");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }
        return frontendMsg;
    }

    private static JsonObject createToolUseMessage(String id, String name, JsonObject input, String timestamp) {
        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "assistant");
        frontendMsg.addProperty("content", "");

        JsonObject toolUse = new JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", id);
        toolUse.addProperty("name", name);
        toolUse.add("input", input != null ? input : new JsonObject());

        JsonArray content = new JsonArray();
        content.add(toolUse);

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "assistant");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }
        return frontendMsg;
    }

    private static JsonObject createToolResultMessage(String toolUseId, boolean isError, String contentText, String timestamp) {
        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "user");
        frontendMsg.addProperty("content", "[tool_result]");

        JsonObject toolResult = new JsonObject();
        toolResult.addProperty("type", "tool_result");
        toolResult.addProperty("tool_use_id", toolUseId);
        toolResult.addProperty("is_error", isError);
        toolResult.addProperty("content", contentText == null || contentText.isBlank() ? "(no output)" : contentText);

        JsonArray content = new JsonArray();
        content.add(toolResult);

        JsonObject rawObj = new JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "user");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }
        return frontendMsg;
    }

    private static boolean isCliItemError(JsonObject item) {
        String status = getString(item, "status");
        if (status != null && ("failed".equalsIgnoreCase(status) || "error".equalsIgnoreCase(status))) {
            return true;
        }
        if (item.has("is_error") && item.get("is_error").isJsonPrimitive() && item.get("is_error").getAsBoolean()) {
            return true;
        }
        if (item.has("error") && !item.get("error").isJsonNull()) {
            return true;
        }
        if (item.has("exit_code") && item.get("exit_code").isJsonPrimitive()) {
            try {
                return item.get("exit_code").getAsInt() != 0;
            } catch (Exception ignored) {
                return false;
            }
        }
        return false;
    }

    private static String extractCliCommandOutput(JsonObject item) {
        return firstNonBlank(
                getString(item, "aggregated_output"),
                getString(item, "output"),
                getString(item, "stdout"),
                getString(item, "stderr"),
                getString(item, "result"),
                "(no output)"
        );
    }

    private static String extractCliMcpResult(JsonObject item) {
        if (item.has("error") && item.get("error").isJsonObject()) {
            String message = getString(item.getAsJsonObject("error"), "message");
            if (message != null) {
                return message;
            }
        }
        if (!item.has("result") || item.get("result").isJsonNull()) {
            return "(no output)";
        }

        JsonElement result = item.get("result");
        if (result.isJsonPrimitive()) {
            return result.getAsString();
        }
        if (result.isJsonObject()) {
            JsonObject resultObj = result.getAsJsonObject();
            if (resultObj.has("content") && resultObj.get("content").isJsonArray()) {
                List<String> parts = new ArrayList<>();
                for (JsonElement element : resultObj.getAsJsonArray("content")) {
                    if (!element.isJsonObject()) {
                        continue;
                    }
                    JsonObject block = element.getAsJsonObject();
                    if ("text".equals(getString(block, "type"))) {
                        String text = getString(block, "text");
                        if (text != null && !text.isBlank()) {
                            parts.add(text);
                        }
                    }
                }
                if (!parts.isEmpty()) {
                    return String.join("\n", parts);
                }
            }
            if (resultObj.has("structured_content")) {
                return resultObj.get("structured_content").toString();
            }
        }
        return result.toString();
    }

    private static String normalizeMcpToolName(String server, String tool) {
        String normalizedServer = server == null || server.isBlank() ? "mcp" : sanitizeToolNamePart(server);
        String normalizedTool = tool == null || tool.isBlank() ? "tool" : sanitizeToolNamePart(tool);
        return "mcp__" + normalizedServer + "__" + normalizedTool;
    }

    private static String sanitizeToolNamePart(String value) {
        return value.trim().replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private static String commandDescription(String command) {
        if (command == null || command.isBlank()) {
            return "Run command";
        }
        String trimmed = command.trim();
        if (trimmed.startsWith("git status")) {
            return "Check git status";
        }
        if (trimmed.startsWith("git diff")) {
            return "Inspect git diff";
        }
        if (trimmed.startsWith("ls") || trimmed.contains(" Get-ChildItem")) {
            return "List files";
        }
        return "Run command";
    }

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private static String getString(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        JsonElement element = obj.get(key);
        return element.isJsonPrimitive() ? element.getAsString() : element.toString();
    }

    /**
     * Convert event_msg with user_message payload to frontend format.
     */
    private static JsonObject convertEventMsgToFrontend(JsonObject payload, String timestamp) {
        if (!payload.has("type") || !"user_message".equals(payload.get("type").getAsString())) {
            return null;
        }
        boolean hasLocalImages = hasLocalImages(payload);
        if (!payload.has("message") || payload.get("message").isJsonNull()) {
            if (!hasLocalImages) {
                return null;
            }
        }

        String content = "";
        if (payload.has("message") && !payload.get("message").isJsonNull()) {
            content = CodexMessageConverter.stripSystemTags(payload.get("message").getAsString());
        }
        if ((content == null || content.isBlank()) && !hasLocalImages) {
            return null;
        }
        if (content == null) {
            content = "";
        }

        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "user");
        frontendMsg.addProperty("content", content);

        // Build raw structure compatible with MessageParser
        JsonObject rawObj = new JsonObject();
        JsonArray contentBlocks = buildUserMessageContentBlocks(payload, content);
        rawObj.add("content", contentBlocks);
        rawObj.addProperty("role", "user");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    private static JsonArray buildUserMessageContentBlocks(JsonObject payload, String content) {
        JsonArray contentBlocks = new JsonArray();
        appendLocalImageBlocks(payload, contentBlocks);

        if (content != null && !content.isBlank()) {
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", content);
            contentBlocks.add(textBlock);
        }
        return contentBlocks;
    }

    private static boolean hasLocalImages(JsonObject payload) {
        return payload.has("local_images")
            && payload.get("local_images").isJsonArray()
            && payload.getAsJsonArray("local_images").size() > 0;
    }

    private static void appendLocalImageBlocks(JsonObject payload, JsonArray contentBlocks) {
        if (!payload.has("local_images") || !payload.get("local_images").isJsonArray()) {
            return;
        }

        JsonArray localImages = payload.getAsJsonArray("local_images");
        for (JsonElement imageElement : localImages) {
            if (!imageElement.isJsonPrimitive()) {
                continue;
            }
            String imagePath = imageElement.getAsString();
            JsonObject imageBlock = createLocalImageBlock(imagePath);
            if (imageBlock != null) {
                contentBlocks.add(imageBlock);
            }
        }
    }

    private static JsonObject createLocalImageBlock(String imagePath) {
        JsonObject imageBlock = AttachmentStorageService.getInstance().createImageBlockFromPath(imagePath);
        if (imageBlock == null && imagePath != null && !imagePath.isBlank()) {
            LOG.debug("[HistoryMessageInjector] Skip missing local image: " + imagePath);
        }
        return imageBlock;
    }

    /**
     * 批量注入前端消息，复用 updateMessages 链路，避免长历史逐条追加导致最新消息显示滞后。
     */
    private void injectBatchToFrontend(List<JsonObject> frontendMessages) {
        String messagesJson = new Gson().toJson(frontendMessages);
        String escapedMessagesJson = JsUtils.escapeJs(messagesJson);

        ApplicationManager.getApplication().invokeLater(() -> {
            String jsCode = "if (window.clearMessages) { window.clearMessages(); } " +
                                    "if (window.updateMessages) { window.updateMessages('" + escapedMessagesJson + "'); }";
            context.executeJavaScriptOnEDT(jsCode);
        });
    }
}
