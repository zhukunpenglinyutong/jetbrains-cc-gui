package com.github.claudecodegui.handler;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.util.JsUtils;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.util.concurrent.CompletableFuture;

/**
 * History data handler.
 * Handles loading history data and session loading.
 */
public class HistoryHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(HistoryHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "load_history_data",
        "load_session",
        "delete_session",  // Delete session
        "export_session",  // Export session
        "toggle_favorite", // Toggle favorite status
        "update_title",    // Update session title
        "deep_search_history" // Deep search (clear cache and reload)
    };

    // Session load callback interface
    public interface SessionLoadCallback {
        void onLoadSession(String sessionId, String projectPath);
    }

    private SessionLoadCallback sessionLoadCallback;
    private String currentProvider = "claude"; // Default to claude

    public HistoryHandler(HandlerContext context) {
        super(context);
    }

    public void setSessionLoadCallback(SessionLoadCallback callback) {
        this.sessionLoadCallback = callback;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "load_history_data":
                LOG.debug("[HistoryHandler] 处理: load_history_data, provider=" + content);
                handleLoadHistoryData(content);
                return true;
            case "load_session":
                LOG.debug("[HistoryHandler] 处理: load_session");
                handleLoadSession(content);
                return true;
            case "delete_session":
                LOG.info("[HistoryHandler] 处理: delete_session, sessionId=" + content);
                handleDeleteSession(content);
                return true;
            case "export_session":
                LOG.info("[HistoryHandler] 处理: export_session, sessionId=" + content);
                handleExportSession(content);
                return true;
            case "toggle_favorite":
                LOG.info("[HistoryHandler] 处理: toggle_favorite, sessionId=" + content);
                handleToggleFavorite(content);
                return true;
            case "update_title":
                LOG.info("[HistoryHandler] 处理: update_title");
                handleUpdateTitle(content);
                return true;
            case "deep_search_history":
                LOG.info("[HistoryHandler] 处理: deep_search_history, provider=" + content);
                handleDeepSearchHistory(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Load and inject history data into the frontend (including favorite info).
     * @param provider the provider identifier ("claude" or "codex")
     */
    private void handleLoadHistoryData(String provider) {
        // Save the current provider state
        this.currentProvider = provider != null && !provider.isEmpty() ? provider : "claude";

        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始加载历史数据 ========== provider=" + currentProvider);

            try {
                String historyJson;

                // Get current project path
                String projectPath = context.getProject().getBasePath();

                // Choose a different reader based on the provider
                if ("codex".equals(provider)) {
                    // Use CodexHistoryReader to read Codex sessions (filtered by project)
                    LOG.info("[HistoryHandler] 使用 CodexHistoryReader 读取 Codex 会话 (项目: " + projectPath + ")");
                    CodexHistoryReader codexReader = new CodexHistoryReader();
                    historyJson = codexReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] CodexHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else {
                    // Default: use ClaudeHistoryReader to read Claude sessions
                    LOG.info("[HistoryHandler] 使用 ClaudeHistoryReader 读取 Claude 会话");
                    ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                    historyJson = historyReader.getProjectDataAsJson(projectPath);
                }

                // Load favorite data and merge into history data
                String enhancedJson = enhanceHistoryWithFavorites(historyJson);
                LOG.info("[HistoryHandler] enhanceHistoryWithFavorites 完成，JSON 长度: " + enhancedJson.length());

                // Load custom titles and merge into history data
                String finalJson = enhanceHistoryWithTitles(enhancedJson);
                LOG.info("[HistoryHandler] enhanceHistoryWithTitles 完成，JSON 长度: " + finalJson.length());

                // Use Base64 encoding to avoid JavaScript string escaping issues
                String base64Json = java.util.Base64.getEncoder().encodeToString(finalJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                LOG.info("[HistoryHandler] Base64 编码完成，长度: " + base64Json.length());

                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject history data');" +
                        "if (window.setHistoryData) { " +
                        "  try { " +
                        "    var base64Str = '" + base64Json + "'; " +
                        "    console.log('[Backend->Frontend] Base64 length:', base64Str.length); " +
                        // Use TextDecoder to properly decode UTF-8 Base64 strings (avoid garbled non-ASCII characters)
                        "    var binaryStr = atob(base64Str); " +
                        "    var bytes = new Uint8Array(binaryStr.length); " +
                        "    for (var i = 0; i < binaryStr.length; i++) { bytes[i] = binaryStr.charCodeAt(i); } " +
                        "    var jsonStr = new TextDecoder('utf-8').decode(bytes); " +
                        "    console.log('[Backend->Frontend] Decoded JSON length:', jsonStr.length); " +
                        "    var data = JSON.parse(jsonStr); " +
                        "    console.log('[Backend->Frontend] Parsed data, sessions:', data.sessions ? data.sessions.length : 0); " +
                        "    window.setHistoryData(data); " +
                        "    console.log('[Backend->Frontend] setHistoryData called successfully'); " +
                        "  } catch(e) { " +
                        "    console.error('[Backend->Frontend] Failed to parse/set history data:', e); " +
                        "    window.setHistoryData({ success: false, error: '解析历史数据失败: ' + e.message }); " +
                        "  } " +
                        "} else { " +
                        "  console.error('[Backend->Frontend] setHistoryData not available!'); " +
                        "}";

                    context.executeJavaScriptOnEDT(jsCode);
                    LOG.info("[HistoryHandler] JavaScript 代码已注入");
                });

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 加载历史数据失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> {
                    String errorMsg = escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "if (window.setHistoryData) { " +
                        "  window.setHistoryData({ success: false, error: '" + errorMsg + "' }); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }

    /**
     * Deep search history records.
     * Clears cache and reloads complete history from the file system.
     * @param provider the provider identifier ("claude" or "codex")
     */
    private void handleDeepSearchHistory(String provider) {
        String projectPath = context.getProject().getBasePath();
        LOG.info("[HistoryHandler] ========== 开始深度搜索 ========== provider=" + provider);

        try {
            // 1. Clear in-memory cache
            if ("codex".equals(provider)) {
                SessionIndexCache.getInstance().clearAllCodexCache();
                LOG.info("[HistoryHandler] 已清空 Codex 内存缓存");
            } else {
                SessionIndexCache.getInstance().clearProject(projectPath);
                LOG.info("[HistoryHandler] 已清空 Claude 项目内存缓存: " + projectPath);
            }

            // 2. Clear disk index
            if ("codex".equals(provider)) {
                SessionIndexManager.getInstance().clearAllCodexIndex();
                LOG.info("[HistoryHandler] 已清空 Codex 磁盘索引");
            } else {
                SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
                LOG.info("[HistoryHandler] 已清空 Claude 项目磁盘索引: " + projectPath);
            }

            LOG.info("[HistoryHandler] 缓存清理完成，开始重新加载历史数据...");

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 清理缓存时出错（继续加载）: " + e.getMessage());
        }

        // 3. Reload history data (using existing method)
        handleLoadHistoryData(provider);
    }

    /**
     * Load a history session.
     */
    private void handleLoadSession(String sessionId) {
        String projectPath = context.getProject().getBasePath();
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
     * Convert Codex content to Claude-format content blocks.
     * Codex: [{type: "input_text", text: "..."}, {type: "text", text: "..."}]
     * Claude: [{type: "text", text: "..."}]
     */
    private com.google.gson.JsonArray convertToClaudeContentBlocks(com.google.gson.JsonElement contentElem) {
        com.google.gson.JsonArray claudeBlocks = new com.google.gson.JsonArray();

        if (contentElem == null) {
            return claudeBlocks;
        }

        // Handle string type - convert to a single text block
        if (contentElem.isJsonPrimitive()) {
            com.google.gson.JsonObject textBlock = new com.google.gson.JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", contentElem.getAsString());
            claudeBlocks.add(textBlock);
            return claudeBlocks;
        }

        // Handle array type
        if (contentElem.isJsonArray()) {
            com.google.gson.JsonArray contentArray = contentElem.getAsJsonArray();

            for (com.google.gson.JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    com.google.gson.JsonObject itemObj = item.getAsJsonObject();
                    String type = itemObj.has("type") ? itemObj.get("type").getAsString() : null;

                    if (type != null) {
                        com.google.gson.JsonObject claudeBlock = new com.google.gson.JsonObject();

                        // Convert Codex "input_text" and "output_text" to Claude "text"
                        if ("input_text".equals(type) || "output_text".equals(type) || "text".equals(type)) {
                            claudeBlock.addProperty("type", "text");
                            if (itemObj.has("text")) {
                                claudeBlock.addProperty("text", itemObj.get("text").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle tool use (if present in Codex)
                        else if ("tool_use".equals(type)) {
                            claudeBlock.addProperty("type", "tool_use");
                            if (itemObj.has("id")) {
                                claudeBlock.addProperty("id", itemObj.get("id").getAsString());
                            }
                            if (itemObj.has("name")) {
                                claudeBlock.addProperty("name", itemObj.get("name").getAsString());
                            }
                            if (itemObj.has("input")) {
                                claudeBlock.add("input", itemObj.get("input"));
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle tool result
                        else if ("tool_result".equals(type)) {
                            claudeBlock.addProperty("type", "tool_result");
                            if (itemObj.has("tool_use_id")) {
                                claudeBlock.addProperty("tool_use_id", itemObj.get("tool_use_id").getAsString());
                            }
                            if (itemObj.has("content")) {
                                claudeBlock.add("content", itemObj.get("content"));
                            }
                            if (itemObj.has("is_error")) {
                                claudeBlock.addProperty("is_error", itemObj.get("is_error").getAsBoolean());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle thinking block
                        else if ("thinking".equals(type)) {
                            claudeBlock.addProperty("type", "thinking");
                            if (itemObj.has("thinking")) {
                                claudeBlock.addProperty("thinking", itemObj.get("thinking").getAsString());
                            }
                            if (itemObj.has("text")) {
                                claudeBlock.addProperty("text", itemObj.get("text").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Handle image
                        else if ("image".equals(type)) {
                            claudeBlock.addProperty("type", "image");
                            if (itemObj.has("src")) {
                                claudeBlock.addProperty("src", itemObj.get("src").getAsString());
                            }
                            if (itemObj.has("mediaType")) {
                                claudeBlock.addProperty("mediaType", itemObj.get("mediaType").getAsString());
                            }
                            if (itemObj.has("alt")) {
                                claudeBlock.addProperty("alt", itemObj.get("alt").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // Other unknown types, try to keep as-is
                        else {
                            claudeBlocks.add(itemObj);
                        }
                    }
                }
            }

            return claudeBlocks;
        }

        // Handle object type - treat as a single block
        if (contentElem.isJsonObject()) {
            claudeBlocks.add(contentElem.getAsJsonObject());
            return claudeBlocks;
        }

        return claudeBlocks;
    }

    /**
     * Extract text content from a Codex content field.
     * Codex content can be in string, object, or array format.
     */
    private String extractContentAsString(com.google.gson.JsonElement contentElem) {
        if (contentElem == null) {
            return null;
        }

        // Handle string type
        if (contentElem.isJsonPrimitive()) {
            return contentElem.getAsString();
        }

        // Handle array type
        if (contentElem.isJsonArray()) {
            com.google.gson.JsonArray contentArray = contentElem.getAsJsonArray();
            StringBuilder sb = new StringBuilder();

            for (com.google.gson.JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    com.google.gson.JsonObject itemObj = item.getAsJsonObject();

                    // Extract text type
                    if (itemObj.has("type") && "text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // Extract input_text type (Codex user messages)
                    else if (itemObj.has("type") && "input_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // Extract output_text type (Codex AI assistant messages)
                    else if (itemObj.has("type") && "output_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                }
            }

            return sb.toString();
        }

        // Handle object type
        if (contentElem.isJsonObject()) {
            com.google.gson.JsonObject contentObj = contentElem.getAsJsonObject();
            if (contentObj.has("text")) {
                return contentObj.get("text").getAsString();
            }
        }

        return null;
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
                com.google.gson.JsonArray messages = com.google.gson.JsonParser.parseString(messagesJson).getAsJsonArray();

                LOG.info("[HistoryHandler] 读取到 " + messages.size() + " 条 Codex 消息");

                // Extract session metadata and restore session state
                String[] sessionMeta = extractSessionMeta(messages);
                String threadIdToUse = sessionMeta[0] != null ? sessionMeta[0] : sessionId;
                String cwd = sessionMeta[1];

                context.getSession().setSessionInfo(threadIdToUse, cwd);
                LOG.info("[HistoryHandler] 恢复 Codex 会话状态: threadId=" + threadIdToUse + " (from sessionId=" + sessionId + "), cwd=" + cwd);

                // Clear current messages
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.executeJavaScriptOnEDT("if (window.clearMessages) { window.clearMessages(); }");
                });

                // Convert Codex messages to frontend format and inject one by one
                for (int i = 0; i < messages.size(); i++) {
                    com.google.gson.JsonObject msg = messages.get(i).getAsJsonObject();
                    processAndInjectCodexMessage(msg);
                }

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
                    String errorMsg = escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
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
     * @return String[2]: [0]=actualThreadId, [1]=cwd
     */
    private String[] extractSessionMeta(com.google.gson.JsonArray messages) {
        String cwd = null;
        String actualThreadId = null;

        for (int i = 0; i < messages.size(); i++) {
            com.google.gson.JsonObject msg = messages.get(i).getAsJsonObject();
            if (msg.has("type") && "session_meta".equals(msg.get("type").getAsString())) {
                if (msg.has("payload")) {
                    com.google.gson.JsonObject payload = msg.getAsJsonObject("payload");
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
     * Process and inject a single Codex message into the frontend.
     */
    private void processAndInjectCodexMessage(com.google.gson.JsonObject msg) {
        if (!msg.has("type") || !"response_item".equals(msg.get("type").getAsString())) {
            return;
        }

        com.google.gson.JsonObject payload = msg.has("payload") ? msg.getAsJsonObject("payload") : null;
        if (payload == null || !payload.has("type")) {
            return;
        }

        String payloadType = payload.get("type").getAsString();
        com.google.gson.JsonObject frontendMsg = null;
        String timestamp = msg.has("timestamp") ? msg.get("timestamp").getAsString() : null;

        if ("message".equals(payloadType)) {
            frontendMsg = convertCodexMessageToFrontend(payload, timestamp);
        } else if ("function_call".equals(payloadType)) {
            frontendMsg = convertFunctionCallToToolUse(payload, timestamp);
        } else if ("function_call_output".equals(payloadType)) {
            frontendMsg = convertFunctionCallOutputToToolResult(payload, timestamp);
        }

        if (frontendMsg != null) {
            injectMessageToFrontend(frontendMsg);
        }
    }

    /**
     * Convert Codex regular message to frontend format.
     */
    private com.google.gson.JsonObject convertCodexMessageToFrontend(com.google.gson.JsonObject payload, String timestamp) {
        String contentStr = extractContentAsString(payload.get("content"));

        // Filter out system messages
        if (contentStr != null && isSystemMessage(contentStr)) {
            return null;
        }

        com.google.gson.JsonObject frontendMsg = new com.google.gson.JsonObject();
        String role = payload.has("role") ? payload.get("role").getAsString() : "user";
        frontendMsg.addProperty("type", role);

        if (payload.has("content")) {
            if (contentStr != null && !contentStr.isEmpty()) {
                frontendMsg.addProperty("content", contentStr);
            }

            com.google.gson.JsonArray claudeContentBlocks = convertToClaudeContentBlocks(payload.get("content"));
            com.google.gson.JsonObject rawObj = new com.google.gson.JsonObject();
            rawObj.add("content", claudeContentBlocks);
            rawObj.addProperty("role", role);
            frontendMsg.add("raw", rawObj);
        }

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * Check if this is a system message (should be filtered).
     */
    private boolean isSystemMessage(String contentStr) {
        return contentStr.startsWith("Warning:") ||
               contentStr.startsWith("Tool result:") ||
               contentStr.startsWith("Exit code:") ||
               contentStr.startsWith("# AGENTS.md instructions") ||
               contentStr.startsWith("<INSTRUCTIONS>") ||
               contentStr.startsWith("<environment_context>");
    }

    /**
     * Convert Codex function_call to Claude tool_use format.
     */
    private com.google.gson.JsonObject convertFunctionCallToToolUse(com.google.gson.JsonObject payload, String timestamp) {
        com.google.gson.JsonObject frontendMsg = new com.google.gson.JsonObject();
        frontendMsg.addProperty("type", "assistant");

        String toolName = payload.has("name") ? payload.get("name").getAsString() : "unknown";
        com.google.gson.JsonElement toolInput = parseToolArguments(payload);

        // Smart tool name conversion
        toolName = convertToolName(toolName, toolInput);
        toolInput = convertToolInput(toolName, toolInput);

        // Build tool_use format
        com.google.gson.JsonObject toolUse = new com.google.gson.JsonObject();
        toolUse.addProperty("type", "tool_use");
        toolUse.addProperty("id", payload.has("call_id") ? payload.get("call_id").getAsString() : "unknown");
        toolUse.addProperty("name", toolName);

        if (toolInput != null) {
            toolUse.add("input", toolInput);
        }

        com.google.gson.JsonArray content = new com.google.gson.JsonArray();
        content.add(toolUse);

        frontendMsg.addProperty("content", "Tool: " + toolName);

        com.google.gson.JsonObject rawObj = new com.google.gson.JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "assistant");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * Parse tool call arguments.
     */
    private com.google.gson.JsonElement parseToolArguments(com.google.gson.JsonObject payload) {
        if (!payload.has("arguments")) {
            return null;
        }
        try {
            return com.google.gson.JsonParser.parseString(payload.get("arguments").getAsString());
        } catch (Exception e) {
            return new com.google.gson.JsonObject();
        }
    }

    /**
     * Smart tool name conversion (shell_command -> read/glob, update_plan -> todowrite).
     */
    private String convertToolName(String toolName, com.google.gson.JsonElement toolInput) {
        if ("shell_command".equals(toolName) && toolInput != null && toolInput.isJsonObject()) {
            com.google.gson.JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("command")) {
                String command = inputObj.get("command").getAsString().trim();
                if (command.matches("^(ls|pwd|find|cat|head|tail|file|stat|tree)\\b.*")) {
                    return "read";
                } else if (command.matches("^(grep|rg|ack|ag)\\b.*")) {
                    return "glob";
                }
            }
        }
        if ("update_plan".equals(toolName) && toolInput != null && toolInput.isJsonObject()) {
            com.google.gson.JsonObject inputObj = toolInput.getAsJsonObject();
            if (inputObj.has("plan") && inputObj.get("plan").isJsonArray()) {
                return "todowrite";
            }
        }
        return toolName;
    }

    /**
     * Convert tool input (update_plan -> todowrite format conversion).
     */
    private com.google.gson.JsonElement convertToolInput(String toolName, com.google.gson.JsonElement toolInput) {
        if (!"todowrite".equals(toolName) || toolInput == null || !toolInput.isJsonObject()) {
            return toolInput;
        }

        com.google.gson.JsonObject inputObj = toolInput.getAsJsonObject();
        if (!inputObj.has("plan") || !inputObj.get("plan").isJsonArray()) {
            return toolInput;
        }

        com.google.gson.JsonArray planArray = inputObj.getAsJsonArray("plan");
        com.google.gson.JsonArray todosArray = new com.google.gson.JsonArray();

        for (int j = 0; j < planArray.size(); j++) {
            if (planArray.get(j).isJsonObject()) {
                com.google.gson.JsonObject planItem = planArray.get(j).getAsJsonObject();
                com.google.gson.JsonObject todoItem = new com.google.gson.JsonObject();

                if (planItem.has("step")) {
                    todoItem.addProperty("content", planItem.get("step").getAsString());
                    todoItem.addProperty("activeForm", planItem.get("step").getAsString());
                }
                todoItem.addProperty("status", planItem.has("status") ? planItem.get("status").getAsString() : "pending");
                todoItem.addProperty("id", String.valueOf(j));

                todosArray.add(todoItem);
            }
        }

        com.google.gson.JsonObject newInput = new com.google.gson.JsonObject();
        newInput.add("todos", todosArray);
        return newInput;
    }

    /**
     * Convert Codex function_call_output to Claude tool_result format.
     */
    private com.google.gson.JsonObject convertFunctionCallOutputToToolResult(com.google.gson.JsonObject payload, String timestamp) {
        com.google.gson.JsonObject frontendMsg = new com.google.gson.JsonObject();
        frontendMsg.addProperty("type", "user");

        com.google.gson.JsonObject toolResult = new com.google.gson.JsonObject();
        toolResult.addProperty("type", "tool_result");
        toolResult.addProperty("tool_use_id", payload.has("call_id") ? payload.get("call_id").getAsString() : "unknown");

        String output = payload.has("output") ? payload.get("output").getAsString() : "";
        toolResult.addProperty("content", output);

        com.google.gson.JsonArray content = new com.google.gson.JsonArray();
        content.add(toolResult);

        frontendMsg.addProperty("content", "[tool_result]");

        com.google.gson.JsonObject rawObj = new com.google.gson.JsonObject();
        rawObj.add("content", content);
        rawObj.addProperty("role", "user");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    /**
     * Inject a message into the frontend.
     */
    private void injectMessageToFrontend(com.google.gson.JsonObject frontendMsg) {
        String msgJson = new com.google.gson.Gson().toJson(frontendMsg);
        String escapedJson = escapeJs(msgJson);

        ApplicationManager.getApplication().invokeLater(() -> {
            String jsCode = "if (window.addHistoryMessage) { " +
                "  try { " +
                "    var msgStr = '" + escapedJson + "'; " +
                "    var msg = JSON.parse(msgStr); " +
                "    window.addHistoryMessage(msg); " +
                "  } catch(e) { " +
                "    console.error('[HistoryHandler] Failed to parse/add message:', e); " +
                "  } " +
                "} else { " +
                "  console.warn('[HistoryHandler] addHistoryMessage not available'); " +
                "}";
            context.executeJavaScriptOnEDT(jsCode);
        });
    }

    /**
     * Delete session history files.
     * Deletes the .jsonl file for the specified sessionId and related agent-xxx.jsonl files.
     */
    private void handleDeleteSession(String sessionId) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 开始删除会话 ==========");
                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] CurrentProvider: " + currentProvider);

                String homeDir = System.getProperty("user.home");
                java.nio.file.Path sessionDir;
                boolean mainDeleted = false;
                int agentFilesDeleted = 0;

                // Determine session directory based on provider
                if ("codex".equals(currentProvider)) {
                    // Codex sessions: stored in ~/.codex/sessions/
                    sessionDir = java.nio.file.Paths.get(homeDir, ".codex", "sessions");
                    LOG.info("[HistoryHandler] 使用 Codex 会话目录: " + sessionDir);

                    if (!java.nio.file.Files.exists(sessionDir)) {
                        LOG.error("[HistoryHandler] Codex 会话目录不存在: " + sessionDir);
                        return;
                    }

                    // Find and delete Codex session files (may be in subdirectories)
                    try (java.util.stream.Stream<java.nio.file.Path> paths = java.nio.file.Files.walk(sessionDir)) {
                        java.util.List<java.nio.file.Path> sessionFiles = paths
                            .filter(java.nio.file.Files::isRegularFile)
                            .filter(path -> path.getFileName().toString().startsWith(sessionId))
                            .filter(path -> path.toString().endsWith(".jsonl"))
                            .collect(java.util.stream.Collectors.toList());

                        for (java.nio.file.Path sessionFile : sessionFiles) {
                            try {
                                java.nio.file.Files.delete(sessionFile);
                                LOG.info("[HistoryHandler] 已删除 Codex 会话文件: " + sessionFile);
                                mainDeleted = true;
                            } catch (Exception e) {
                                LOG.error("[HistoryHandler] 删除 Codex 会话文件失败: " + sessionFile + " - " + e.getMessage(), e);
                            }
                        }
                    }

                } else {
                    // Claude sessions: stored in ~/.claude/projects/{projectPath}/
                    String projectPath = context.getProject().getBasePath();
                    LOG.info("[HistoryHandler] ProjectPath: " + projectPath);

                    java.nio.file.Path claudeDir = java.nio.file.Paths.get(homeDir, ".claude");
                    java.nio.file.Path projectsDir = claudeDir.resolve("projects");

                    // Sanitize project path (consistent with ClaudeHistoryReader)
                    String sanitizedPath = com.github.claudecodegui.util.PathUtils.sanitizePath(projectPath);
                    sessionDir = projectsDir.resolve(sanitizedPath);

                    LOG.info("[HistoryHandler] 使用 Claude 会话目录: " + sessionDir);

                    if (!java.nio.file.Files.exists(sessionDir)) {
                        LOG.error("[HistoryHandler] Claude 项目目录不存在: " + sessionDir);
                        return;
                    }

                    // Delete the main session file
                    java.nio.file.Path mainSessionFile = sessionDir.resolve(sessionId + ".jsonl");

                    if (java.nio.file.Files.exists(mainSessionFile)) {
                        java.nio.file.Files.delete(mainSessionFile);
                        LOG.info("[HistoryHandler] 已删除主会话文件: " + mainSessionFile.getFileName());
                        mainDeleted = true;
                    } else {
                        LOG.warn("[HistoryHandler] 主会话文件不存在: " + mainSessionFile.getFileName());
                    }

                    // Delete related agent files
                    // Iterate through the project directory to find all potentially related agent files
                    // Agent files are typically named agent-<uuid>.jsonl
                    try (java.util.stream.Stream<java.nio.file.Path> stream = java.nio.file.Files.list(sessionDir)) {
                        java.util.List<java.nio.file.Path> agentFiles = stream
                            .filter(path -> {
                                String filename = path.getFileName().toString();
                                // Match agent-*.jsonl files that belong to the current session
                                if (!filename.startsWith("agent-") || !filename.endsWith(".jsonl")) {
                                    return false;
                                }

                                // Check if the agent file belongs to the current session
                                // by reading file content to find sessionId references
                                return isAgentFileRelatedToSession(path, sessionId);
                            })
                            .collect(java.util.stream.Collectors.toList());

                        for (java.nio.file.Path agentFile : agentFiles) {
                            try {
                                java.nio.file.Files.delete(agentFile);
                                LOG.info("[HistoryHandler] 已删除关联 agent 文件: " + agentFile.getFileName());
                                agentFilesDeleted++;
                            } catch (Exception e) {
                                LOG.error("[HistoryHandler] 删除 agent 文件失败: " + agentFile.getFileName() + " - " + e.getMessage(), e);
                            }
                        }
                    }
                }

                LOG.info("[HistoryHandler] ========== 删除会话完成 ==========");
                LOG.info("[HistoryHandler] 主会话文件: " + (mainDeleted ? "已删除" : "未找到"));
                LOG.info("[HistoryHandler] Agent 文件: 删除了 " + agentFilesDeleted + " 个");

                // Clean up related favorite and title data
                if (mainDeleted) {
                    try {
                        LOG.info("[HistoryHandler] 开始清理会话关联数据...");

                        // Clean up favorite data
                        callNodeJsFavoritesService("removeFavorite", sessionId);
                        LOG.info("[HistoryHandler] 已清理收藏数据");

                        // Clean up title data
                        String deleteResult = callNodeJsDeleteTitle(sessionId);
                        LOG.info("[HistoryHandler] 已清理标题数据");

                    } catch (Exception e) {
                        LOG.warn("[HistoryHandler] 清理关联数据失败（不影响会话删除）: " + e.getMessage());
                    }
                }

                // Clear cache to ensure deleted sessions are not returned on next load
                try {
                    String projectPath = context.getProject().getBasePath();
                    LOG.info("[HistoryHandler] 清理会话缓存...");

                    if ("codex".equals(currentProvider)) {
                        // Codex uses "__all__" as cache key, need to clear all Codex cache
                        SessionIndexCache.getInstance().clearAllCodexCache();
                        SessionIndexManager.getInstance().clearAllCodexIndex();
                        LOG.info("[HistoryHandler] 已清理所有 Codex 缓存和索引");
                    } else {
                        // Claude uses projectPath as cache key
                        SessionIndexCache.getInstance().clearProject(projectPath);
                        SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
                        LOG.info("[HistoryHandler] 已清理 Claude 项目缓存和索引");
                    }

                } catch (Exception e) {
                    LOG.warn("[HistoryHandler] 清理缓存失败（不影响会话删除）: " + e.getMessage());
                }

                // After deletion, reload history data and push to frontend
                LOG.info("[HistoryHandler] 重新加载历史数据...");
                handleLoadHistoryData(currentProvider);

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 删除会话失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Export session data.
     * Reads all messages of the session and returns them to the frontend.
     */
    private void handleExportSession(String content) {
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始导出会话 ==========");

            try {
                // Parse JSON from frontend to extract sessionId and title
                com.google.gson.JsonObject exportRequest = new com.google.gson.Gson().fromJson(content, com.google.gson.JsonObject.class);
                String sessionId = exportRequest.get("sessionId").getAsString();
                String title = exportRequest.get("title").getAsString();

                String projectPath = context.getProject().getBasePath();
                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] Title: " + title);
                LOG.info("[HistoryHandler] ProjectPath: " + projectPath);
                LOG.info("[HistoryHandler] CurrentProvider: " + currentProvider);

                // Choose a different reader based on the provider
                String messagesJson;
                if ("codex".equals(currentProvider)) {
                    LOG.info("[HistoryHandler] 使用 CodexHistoryReader 读取 Codex 会话消息");
                    CodexHistoryReader codexReader = new CodexHistoryReader();
                    messagesJson = codexReader.getSessionMessagesAsJson(sessionId);
                } else {
                    LOG.info("[HistoryHandler] 使用 ClaudeHistoryReader 读取 Claude 会话消息");
                    ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                    messagesJson = historyReader.getSessionMessagesAsJson(projectPath, sessionId);
                }

                // Wrap messages into an object containing sessionId and title
                com.google.gson.JsonObject exportData = new com.google.gson.JsonObject();
                exportData.addProperty("sessionId", sessionId);
                exportData.addProperty("title", title);
                exportData.add("messages", com.google.gson.JsonParser.parseString(messagesJson));

                String wrappedJson = new com.google.gson.Gson().toJson(exportData);

                LOG.info("[HistoryHandler] 读取到会话消息，准备注入到前端");

                String escapedJson = escapeJs(wrappedJson);

                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject export data');" +
                        "if (window.onExportSessionData) { " +
                        "  try { " +
                        "    var jsonStr = '" + escapedJson + "'; " +
                        "    window.onExportSessionData(jsonStr); " +
                        "    console.log('[Backend->Frontend] Export data injected successfully'); " +
                        "  } catch(e) { " +
                        "    console.error('[Backend->Frontend] Failed to inject export data:', e); " +
                        "  } " +
                        "} else { " +
                        "  console.error('[Backend->Frontend] onExportSessionData not available!'); " +
                        "}";

                    context.executeJavaScriptOnEDT(jsCode);
                });

                LOG.info("[HistoryHandler] ========== 导出会话完成 ==========");

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 导出会话失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "if (window.addToast) { " +
                        "  window.addToast('导出失败: " + escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误") + "', 'error'); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }

    /**
     * Toggle favorite status.
     */
    private void handleToggleFavorite(String sessionId) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 切换收藏状态 ==========");
                LOG.info("[HistoryHandler] SessionId: " + sessionId);

                // Call Node.js favorites-service to toggle favorite status
                String result = callNodeJsFavoritesService("toggleFavorite", sessionId);
                LOG.info("[HistoryHandler] 收藏状态切换结果: " + result);

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 切换收藏状态失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Update session title.
     */
    private void handleUpdateTitle(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 更新会话标题 ==========");

                // Parse JSON from frontend to extract sessionId and customTitle
                com.google.gson.JsonObject request = new com.google.gson.Gson().fromJson(content, com.google.gson.JsonObject.class);
                String sessionId = request.get("sessionId").getAsString();
                String customTitle = request.get("customTitle").getAsString();

                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] CustomTitle: " + customTitle);

                // Call Node.js session-titles-service to update the title
                String result = callNodeJsTitlesServiceWithParams("updateTitle", sessionId, customTitle);
                LOG.info("[HistoryHandler] 标题更新结果: " + result);

                // Parse the result
                com.google.gson.JsonObject resultObj = new com.google.gson.Gson().fromJson(result, com.google.gson.JsonObject.class);
                boolean success = resultObj.get("success").getAsBoolean();

                if (!success && resultObj.has("error")) {
                    String error = resultObj.get("error").getAsString();
                    ApplicationManager.getApplication().invokeLater(() -> {
                        String jsCode = "if (window.addToast) { " +
                            "  window.addToast('更新标题失败: " + escapeJs(error) + "', 'error'); " +
                            "}";
                        context.executeJavaScriptOnEDT(jsCode);
                    });
                }

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 更新标题失败: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "if (window.addToast) { " +
                        "  window.addToast('更新标题失败: " + escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误") + "', 'error'); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }

    /**
     * Enhance history data: add favorite info to each session.
     */
    private String enhanceHistoryWithFavorites(String historyJson) {
        try {
            // Load favorite data
            String favoritesJson = callNodeJsFavoritesService("loadFavorites", "");

            // Parse history data and favorite data
            com.google.gson.JsonObject history = new com.google.gson.Gson().fromJson(historyJson, com.google.gson.JsonObject.class);
            com.google.gson.JsonObject favorites = new com.google.gson.Gson().fromJson(favoritesJson, com.google.gson.JsonObject.class);

            // Add favorite info and provider info to each session
            if (history.has("sessions") && history.get("sessions").isJsonArray()) {
                com.google.gson.JsonArray sessions = history.getAsJsonArray("sessions");
                for (int i = 0; i < sessions.size(); i++) {
                    com.google.gson.JsonObject session = sessions.get(i).getAsJsonObject();
                    String sessionId = session.get("sessionId").getAsString();

                    // Add provider info
                    session.addProperty("provider", currentProvider);

                    if (favorites.has(sessionId)) {
                        com.google.gson.JsonObject favoriteInfo = favorites.getAsJsonObject(sessionId);
                        session.addProperty("isFavorited", true);
                        session.addProperty("favoritedAt", favoriteInfo.get("favoritedAt").getAsLong());
                    } else {
                        session.addProperty("isFavorited", false);
                    }
                }
            }

            // Also add favorite data to the history data
            history.add("favorites", favorites);

            return new com.google.gson.Gson().toJson(history);

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 增强历史数据失败，返回原始数据: " + e.getMessage());
            return historyJson;
        }
    }

    /**
     * Enhance history data: add custom titles to each session.
     */
    private String enhanceHistoryWithTitles(String historyJson) {
        try {
            // Load title data
            String titlesJson = callNodeJsTitlesService("loadTitles", "", "");

            // Parse history data and title data
            com.google.gson.JsonObject history = new com.google.gson.Gson().fromJson(historyJson, com.google.gson.JsonObject.class);
            com.google.gson.JsonObject titles = new com.google.gson.Gson().fromJson(titlesJson, com.google.gson.JsonObject.class);

            // Add custom title to each session
            if (history.has("sessions") && history.get("sessions").isJsonArray()) {
                com.google.gson.JsonArray sessions = history.getAsJsonArray("sessions");
                for (int i = 0; i < sessions.size(); i++) {
                    com.google.gson.JsonObject session = sessions.get(i).getAsJsonObject();
                    String sessionId = session.get("sessionId").getAsString();

                    if (titles.has(sessionId)) {
                        com.google.gson.JsonObject titleInfo = titles.getAsJsonObject(sessionId);
                        // If a custom title exists, override the original title
                        if (titleInfo.has("customTitle")) {
                            String customTitle = titleInfo.get("customTitle").getAsString();
                            session.addProperty("title", customTitle);
                            session.addProperty("hasCustomTitle", true);
                        }
                    }
                }
            }

            return new com.google.gson.Gson().toJson(history);

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 增强标题数据失败，返回原始数据: " + e.getMessage());
            return historyJson;
        }
    }

    /**
     * Call Node.js favorites-service.
     */
    private String callNodeJsFavoritesService(String functionName, String sessionId) throws Exception {
        // Get ai-bridge path
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Build Node.js command
        String nodeScript = String.format(
            "const { %s } = require('%s/services/favorites-service.cjs'); " +
            "const result = %s('%s'); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName,
            sessionId
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Read output
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // Return the last line (JSON output)
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * Call Node.js session-titles-service (no-argument version, for loadTitles).
     */
    private String callNodeJsTitlesService(String functionName, String dummy1, String dummy2) throws Exception {
        // Get ai-bridge path
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Build Node.js command (loadTitles requires no arguments)
        String nodeScript = String.format(
            "const { %s } = require('%s/services/session-titles-service.cjs'); " +
            "const result = %s(); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Read output
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // Return the last line (JSON output)
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * Call Node.js session-titles-service (with parameters, for updateTitle).
     */
    private String callNodeJsTitlesServiceWithParams(String functionName, String sessionId, String customTitle) throws Exception {
        // Get ai-bridge path
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Escape special characters
        String escapedTitle = customTitle.replace("\\", "\\\\").replace("'", "\\'");

        // Build Node.js command
        String nodeScript = String.format(
            "const { %s } = require('%s/services/session-titles-service.cjs'); " +
            "const result = %s('%s', '%s'); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName,
            sessionId,
            escapedTitle
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Read output
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // Return the last line (JSON output)
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * Call Node.js session-titles-service to delete a title (single parameter version).
     */
    private String callNodeJsDeleteTitle(String sessionId) throws Exception {
        // Get ai-bridge path
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // Build Node.js command
        String nodeScript = String.format(
            "const { deleteTitle } = require('%s/services/session-titles-service.cjs'); " +
            "const result = deleteTitle('%s'); " +
            "console.log(JSON.stringify({ success: result }));",
            bridgePath.replace("\\", "\\\\"),
            sessionId
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // Read output
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // Return the last line (JSON output)
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * Check if an agent file belongs to the specified session.
     * Reads file content to find sessionId references.
     */
    private boolean isAgentFileRelatedToSession(java.nio.file.Path agentFilePath, String sessionId) {
        try (java.io.BufferedReader reader = java.nio.file.Files.newBufferedReader(agentFilePath, java.nio.charset.StandardCharsets.UTF_8)) {
            String line;
            int lineCount = 0;
            // Only read the first 20 lines for performance (sessionId is typically near the beginning)
            while ((line = reader.readLine()) != null && lineCount < 20) {
                // Check if this line contains the sessionId
                if (line.contains("\"sessionId\":\"" + sessionId + "\"") ||
                    line.contains("\"parentSessionId\":\"" + sessionId + "\"")) {
                    LOG.debug("[HistoryHandler] Agent文件 " + agentFilePath.getFileName() + " 属于会话 " + sessionId);
                    return true;
                }
                lineCount++;
            }
            // If not found in the first 20 lines, the agent file does not belong to this session
            LOG.debug("[HistoryHandler] Agent文件 " + agentFilePath.getFileName() + " 不属于会话 " + sessionId);
            return false;
        } catch (Exception e) {
            // If reading fails, do not delete the file to be safe
            LOG.warn("[HistoryHandler] 无法读取agent文件 " + agentFilePath.getFileName() + ": " + e.getMessage());
            return false;
        }
    }
}
