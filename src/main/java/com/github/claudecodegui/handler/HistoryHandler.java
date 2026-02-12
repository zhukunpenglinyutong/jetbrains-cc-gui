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
 * 历史数据处理器
 * 处理历史数据加载和会话加载
 */
public class HistoryHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(HistoryHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "load_history_data",
        "load_session",
        "delete_session",  // 新增:删除会话
        "export_session",  // 新增:导出会话
        "toggle_favorite", // 新增:切换收藏状态
        "update_title",    // 新增:更新会话标题
        "deep_search_history" // 新增:深度搜索(清空缓存后重新加载)
    };

    // 会话加载回调接口
    public interface SessionLoadCallback {
        void onLoadSession(String sessionId, String projectPath);
    }

    private SessionLoadCallback sessionLoadCallback;
    private String currentProvider = "claude"; // 默认为 claude

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
     * 加载并注入历史数据到前端（包含收藏信息）
     * @param provider 提供商标识 ("claude" 或 "codex")
     */
    private void handleLoadHistoryData(String provider) {
        // 保存当前 provider 状态
        this.currentProvider = provider != null && !provider.isEmpty() ? provider : "claude";

        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始加载历史数据 ========== provider=" + currentProvider);

            try {
                String historyJson;

                // 获取当前项目路径
                String projectPath = context.getProject().getBasePath();

                // 根据 provider 选择不同的 reader
                if ("codex".equals(provider)) {
                    // 使用 CodexHistoryReader 读取 Codex 会话（按项目过滤）
                    LOG.info("[HistoryHandler] 使用 CodexHistoryReader 读取 Codex 会话 (项目: " + projectPath + ")");
                    CodexHistoryReader codexReader = new CodexHistoryReader();
                    historyJson = codexReader.getSessionsForProjectAsJson(projectPath);
                    LOG.info("[HistoryHandler] CodexHistoryReader 返回的 JSON 长度: " + historyJson.length());
                } else {
                    // 默认使用 ClaudeHistoryReader 读取 Claude 会话
                    LOG.info("[HistoryHandler] 使用 ClaudeHistoryReader 读取 Claude 会话");
                    ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                    historyJson = historyReader.getProjectDataAsJson(projectPath);
                }

                // 加载收藏数据并合并到历史数据中
                String enhancedJson = enhanceHistoryWithFavorites(historyJson);
                LOG.info("[HistoryHandler] enhanceHistoryWithFavorites 完成，JSON 长度: " + enhancedJson.length());

                // 加载自定义标题并合并到历史数据中
                String finalJson = enhanceHistoryWithTitles(enhancedJson);
                LOG.info("[HistoryHandler] enhanceHistoryWithTitles 完成，JSON 长度: " + finalJson.length());

                // 使用 Base64 编码来避免 JavaScript 字符串转义问题
                String base64Json = java.util.Base64.getEncoder().encodeToString(finalJson.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                LOG.info("[HistoryHandler] Base64 编码完成，长度: " + base64Json.length());

                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject history data');" +
                        "if (window.setHistoryData) { " +
                        "  try { " +
                        "    var base64Str = '" + base64Json + "'; " +
                        "    console.log('[Backend->Frontend] Base64 length:', base64Str.length); " +
                        // 使用 TextDecoder 正确解码 UTF-8 的 Base64 字符串（避免中文乱码）
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
     * 深度搜索历史记录
     * 清空缓存后重新从文件系统加载完整的历史记录
     * @param provider 提供商标识 ("claude" 或 "codex")
     */
    private void handleDeepSearchHistory(String provider) {
        String projectPath = context.getProject().getBasePath();
        LOG.info("[HistoryHandler] ========== 开始深度搜索 ========== provider=" + provider);

        try {
            // 1. 清空内存缓存
            if ("codex".equals(provider)) {
                SessionIndexCache.getInstance().clearAllCodexCache();
                LOG.info("[HistoryHandler] 已清空 Codex 内存缓存");
            } else {
                SessionIndexCache.getInstance().clearProject(projectPath);
                LOG.info("[HistoryHandler] 已清空 Claude 项目内存缓存: " + projectPath);
            }

            // 2. 清空磁盘索引
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

        // 3. 重新加载历史数据（使用现有方法）
        handleLoadHistoryData(provider);
    }

    /**
     * 加载历史会话
     */
    private void handleLoadSession(String sessionId) {
        String projectPath = context.getProject().getBasePath();
        LOG.info("[HistoryHandler] Loading history session: " + sessionId + " from project: " + projectPath + ", provider: " + currentProvider);

        if ("codex".equals(currentProvider)) {
            // Codex 会话：读取会话信息并恢复会话状态
            loadCodexSession(sessionId);
        } else {
            // Claude 会话：使用现有的 callback 机制
            if (sessionLoadCallback != null) {
                sessionLoadCallback.onLoadSession(sessionId, projectPath);
            } else {
                LOG.warn("[HistoryHandler] WARNING: No session load callback set");
            }
        }
    }

    /**
     * 将 Codex 的 content 转换为 Claude 格式的 content blocks
     * Codex: [{type: "input_text", text: "..."}, {type: "text", text: "..."}]
     * Claude: [{type: "text", text: "..."}]
     */
    private com.google.gson.JsonArray convertToClaudeContentBlocks(com.google.gson.JsonElement contentElem) {
        com.google.gson.JsonArray claudeBlocks = new com.google.gson.JsonArray();

        if (contentElem == null) {
            return claudeBlocks;
        }

        // 处理字符串类型 - 转换为单个文本块
        if (contentElem.isJsonPrimitive()) {
            com.google.gson.JsonObject textBlock = new com.google.gson.JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", contentElem.getAsString());
            claudeBlocks.add(textBlock);
            return claudeBlocks;
        }

        // 处理数组类型
        if (contentElem.isJsonArray()) {
            com.google.gson.JsonArray contentArray = contentElem.getAsJsonArray();

            for (com.google.gson.JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    com.google.gson.JsonObject itemObj = item.getAsJsonObject();
                    String type = itemObj.has("type") ? itemObj.get("type").getAsString() : null;

                    if (type != null) {
                        com.google.gson.JsonObject claudeBlock = new com.google.gson.JsonObject();

                        // Codex 的 "input_text" 和 "output_text" 转换为 Claude 的 "text"
                        if ("input_text".equals(type) || "output_text".equals(type) || "text".equals(type)) {
                            claudeBlock.addProperty("type", "text");
                            if (itemObj.has("text")) {
                                claudeBlock.addProperty("text", itemObj.get("text").getAsString());
                            }
                            claudeBlocks.add(claudeBlock);
                        }
                        // 处理工具使用（如果 Codex 有的话）
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
                        // 处理工具结果
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
                        // 处理思考块
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
                        // 处理图片
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
                        // 其他未知类型，尝试保持原样
                        else {
                            claudeBlocks.add(itemObj);
                        }
                    }
                }
            }

            return claudeBlocks;
        }

        // 处理对象类型 - 作为单个块
        if (contentElem.isJsonObject()) {
            claudeBlocks.add(contentElem.getAsJsonObject());
            return claudeBlocks;
        }

        return claudeBlocks;
    }

    /**
     * 从 Codex content 字段提取文本内容
     * Codex 的 content 可能是字符串、对象或数组格式
     */
    private String extractContentAsString(com.google.gson.JsonElement contentElem) {
        if (contentElem == null) {
            return null;
        }

        // 处理字符串类型
        if (contentElem.isJsonPrimitive()) {
            return contentElem.getAsString();
        }

        // 处理数组类型
        if (contentElem.isJsonArray()) {
            com.google.gson.JsonArray contentArray = contentElem.getAsJsonArray();
            StringBuilder sb = new StringBuilder();

            for (com.google.gson.JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    com.google.gson.JsonObject itemObj = item.getAsJsonObject();

                    // 提取文本类型
                    if (itemObj.has("type") && "text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // 提取 input_text 类型 (Codex 用户消息)
                    else if (itemObj.has("type") && "input_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append("\n");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                    // 提取 output_text 类型 (Codex AI 助手消息)
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

        // 处理对象类型
        if (contentElem.isJsonObject()) {
            com.google.gson.JsonObject contentObj = contentElem.getAsJsonObject();
            if (contentObj.has("text")) {
                return contentObj.get("text").getAsString();
            }
        }

        return null;
    }

    /**
     * 加载 Codex 会话
     * 直接读取会话消息并注入到前端，同时恢复会话状态
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

                // 提取会话元数据并恢复会话状态
                String[] sessionMeta = extractSessionMeta(messages);
                String threadIdToUse = sessionMeta[0] != null ? sessionMeta[0] : sessionId;
                String cwd = sessionMeta[1];

                context.getSession().setSessionInfo(threadIdToUse, cwd);
                LOG.info("[HistoryHandler] 恢复 Codex 会话状态: threadId=" + threadIdToUse + " (from sessionId=" + sessionId + "), cwd=" + cwd);

                // 清空当前消息
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.executeJavaScriptOnEDT("if (window.clearMessages) { window.clearMessages(); }");
                });

                // 将 Codex 消息转换为前端格式并逐条注入
                for (int i = 0; i < messages.size(); i++) {
                    com.google.gson.JsonObject msg = messages.get(i).getAsJsonObject();
                    processAndInjectCodexMessage(msg);
                }

                // 通知前端历史消息加载完成，触发 Markdown 重新渲染
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
     * 提取 Codex 会话元数据（threadId 和 cwd）
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
     * 处理并注入单条 Codex 消息到前端
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
     * 转换 Codex 普通消息为前端格式
     */
    private com.google.gson.JsonObject convertCodexMessageToFrontend(com.google.gson.JsonObject payload, String timestamp) {
        String contentStr = extractContentAsString(payload.get("content"));

        // 过滤掉系统消息
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
     * 检查是否为系统消息（需要过滤）
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
     * 转换 Codex function_call 为 Claude tool_use 格式
     */
    private com.google.gson.JsonObject convertFunctionCallToToolUse(com.google.gson.JsonObject payload, String timestamp) {
        com.google.gson.JsonObject frontendMsg = new com.google.gson.JsonObject();
        frontendMsg.addProperty("type", "assistant");

        String toolName = payload.has("name") ? payload.get("name").getAsString() : "unknown";
        com.google.gson.JsonElement toolInput = parseToolArguments(payload);

        // 智能转换工具名
        toolName = convertToolName(toolName, toolInput);
        toolInput = convertToolInput(toolName, toolInput);

        // 构造 tool_use 格式
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
     * 解析工具调用参数
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
     * 智能转换工具名（shell_command -> read/glob, update_plan -> todowrite）
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
     * 转换工具输入（update_plan -> todowrite 格式转换）
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
     * 转换 Codex function_call_output 为 Claude tool_result 格式
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
     * 注入消息到前端
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
     * 删除会话历史文件
     * 删除指定 sessionId 的 .jsonl 文件以及相关的 agent-xxx.jsonl 文件
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

                // 根据 provider 确定会话目录
                if ("codex".equals(currentProvider)) {
                    // Codex 会话：存储在 ~/.codex/sessions/
                    sessionDir = java.nio.file.Paths.get(homeDir, ".codex", "sessions");
                    LOG.info("[HistoryHandler] 使用 Codex 会话目录: " + sessionDir);

                    if (!java.nio.file.Files.exists(sessionDir)) {
                        LOG.error("[HistoryHandler] Codex 会话目录不存在: " + sessionDir);
                        return;
                    }

                    // 查找并删除 Codex 会话文件（可能在子目录中）
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
                    // Claude 会话：存储在 ~/.claude/projects/{projectPath}/
                    String projectPath = context.getProject().getBasePath();
                    LOG.info("[HistoryHandler] ProjectPath: " + projectPath);

                    java.nio.file.Path claudeDir = java.nio.file.Paths.get(homeDir, ".claude");
                    java.nio.file.Path projectsDir = claudeDir.resolve("projects");

                    // 规范化项目路径(与 ClaudeHistoryReader 保持一致)
                    String sanitizedPath = com.github.claudecodegui.util.PathUtils.sanitizePath(projectPath);
                    sessionDir = projectsDir.resolve(sanitizedPath);

                    LOG.info("[HistoryHandler] 使用 Claude 会话目录: " + sessionDir);

                    if (!java.nio.file.Files.exists(sessionDir)) {
                        LOG.error("[HistoryHandler] Claude 项目目录不存在: " + sessionDir);
                        return;
                    }

                    // 删除主会话文件
                    java.nio.file.Path mainSessionFile = sessionDir.resolve(sessionId + ".jsonl");

                    if (java.nio.file.Files.exists(mainSessionFile)) {
                        java.nio.file.Files.delete(mainSessionFile);
                        LOG.info("[HistoryHandler] 已删除主会话文件: " + mainSessionFile.getFileName());
                        mainDeleted = true;
                    } else {
                        LOG.warn("[HistoryHandler] 主会话文件不存在: " + mainSessionFile.getFileName());
                    }

                    // 删除相关的 agent 文件
                    // 遍历项目目录,查找所有可能相关的 agent 文件
                    // agent 文件通常命名为 agent-<uuid>.jsonl
                    try (java.util.stream.Stream<java.nio.file.Path> stream = java.nio.file.Files.list(sessionDir)) {
                        java.util.List<java.nio.file.Path> agentFiles = stream
                            .filter(path -> {
                                String filename = path.getFileName().toString();
                                // 匹配 agent-*.jsonl 文件，并且需要属于当前会话
                                if (!filename.startsWith("agent-") || !filename.endsWith(".jsonl")) {
                                    return false;
                                }

                                // 检查agent文件是否属于当前会话
                                // 通过读取文件内容查找sessionId引用
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

                // 清理相关的收藏和标题数据
                if (mainDeleted) {
                    try {
                        LOG.info("[HistoryHandler] 开始清理会话关联数据...");

                        // 清理收藏数据
                        callNodeJsFavoritesService("removeFavorite", sessionId);
                        LOG.info("[HistoryHandler] 已清理收藏数据");

                        // 清理标题数据
                        String deleteResult = callNodeJsDeleteTitle(sessionId);
                        LOG.info("[HistoryHandler] 已清理标题数据");

                    } catch (Exception e) {
                        LOG.warn("[HistoryHandler] 清理关联数据失败（不影响会话删除）: " + e.getMessage());
                    }
                }

                // 清理缓存，确保下次加载时不会返回已删除的会话
                try {
                    String projectPath = context.getProject().getBasePath();
                    LOG.info("[HistoryHandler] 清理会话缓存...");

                    if ("codex".equals(currentProvider)) {
                        // Codex 使用 "__all__" 作为缓存键，需要清除所有 Codex 缓存
                        SessionIndexCache.getInstance().clearAllCodexCache();
                        SessionIndexManager.getInstance().clearAllCodexIndex();
                        LOG.info("[HistoryHandler] 已清理所有 Codex 缓存和索引");
                    } else {
                        // Claude 使用 projectPath 作为缓存键
                        SessionIndexCache.getInstance().clearProject(projectPath);
                        SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
                        LOG.info("[HistoryHandler] 已清理 Claude 项目缓存和索引");
                    }

                } catch (Exception e) {
                    LOG.warn("[HistoryHandler] 清理缓存失败（不影响会话删除）: " + e.getMessage());
                }

                // 删除完成后，重新加载历史数据并推送给前端
                LOG.info("[HistoryHandler] 重新加载历史数据...");
                handleLoadHistoryData(currentProvider);

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 删除会话失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 导出会话数据
     * 读取会话的所有消息并返回给前端
     */
    private void handleExportSession(String content) {
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始导出会话 ==========");

            try {
                // 解析前端传来的JSON，获取 sessionId 和 title
                com.google.gson.JsonObject exportRequest = new com.google.gson.Gson().fromJson(content, com.google.gson.JsonObject.class);
                String sessionId = exportRequest.get("sessionId").getAsString();
                String title = exportRequest.get("title").getAsString();

                String projectPath = context.getProject().getBasePath();
                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] Title: " + title);
                LOG.info("[HistoryHandler] ProjectPath: " + projectPath);
                LOG.info("[HistoryHandler] CurrentProvider: " + currentProvider);

                // 根据 provider 选择不同的 reader
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

                // 将消息包装到包含 sessionId 和 title 的对象中
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
     * 切换收藏状态
     */
    private void handleToggleFavorite(String sessionId) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 切换收藏状态 ==========");
                LOG.info("[HistoryHandler] SessionId: " + sessionId);

                // 调用 Node.js favorites-service 切换收藏状态
                String result = callNodeJsFavoritesService("toggleFavorite", sessionId);
                LOG.info("[HistoryHandler] 收藏状态切换结果: " + result);

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 切换收藏状态失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 更新会话标题
     */
    private void handleUpdateTitle(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 更新会话标题 ==========");

                // 解析前端传来的JSON，获取 sessionId 和 customTitle
                com.google.gson.JsonObject request = new com.google.gson.Gson().fromJson(content, com.google.gson.JsonObject.class);
                String sessionId = request.get("sessionId").getAsString();
                String customTitle = request.get("customTitle").getAsString();

                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] CustomTitle: " + customTitle);

                // 调用 Node.js session-titles-service 更新标题
                String result = callNodeJsTitlesServiceWithParams("updateTitle", sessionId, customTitle);
                LOG.info("[HistoryHandler] 标题更新结果: " + result);

                // 解析结果
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
     * 增强历史数据：添加收藏信息到每个会话
     */
    private String enhanceHistoryWithFavorites(String historyJson) {
        try {
            // 加载收藏数据
            String favoritesJson = callNodeJsFavoritesService("loadFavorites", "");

            // 解析历史数据和收藏数据
            com.google.gson.JsonObject history = new com.google.gson.Gson().fromJson(historyJson, com.google.gson.JsonObject.class);
            com.google.gson.JsonObject favorites = new com.google.gson.Gson().fromJson(favoritesJson, com.google.gson.JsonObject.class);

            // 为每个会话添加收藏信息和 provider 信息
            if (history.has("sessions") && history.get("sessions").isJsonArray()) {
                com.google.gson.JsonArray sessions = history.getAsJsonArray("sessions");
                for (int i = 0; i < sessions.size(); i++) {
                    com.google.gson.JsonObject session = sessions.get(i).getAsJsonObject();
                    String sessionId = session.get("sessionId").getAsString();

                    // 添加 provider 信息
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

            // 将收藏数据也添加到历史数据中
            history.add("favorites", favorites);

            return new com.google.gson.Gson().toJson(history);

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 增强历史数据失败，返回原始数据: " + e.getMessage());
            return historyJson;
        }
    }

    /**
     * 增强历史数据：添加自定义标题到每个会话
     */
    private String enhanceHistoryWithTitles(String historyJson) {
        try {
            // 加载标题数据
            String titlesJson = callNodeJsTitlesService("loadTitles", "", "");

            // 解析历史数据和标题数据
            com.google.gson.JsonObject history = new com.google.gson.Gson().fromJson(historyJson, com.google.gson.JsonObject.class);
            com.google.gson.JsonObject titles = new com.google.gson.Gson().fromJson(titlesJson, com.google.gson.JsonObject.class);

            // 为每个会话添加自定义标题
            if (history.has("sessions") && history.get("sessions").isJsonArray()) {
                com.google.gson.JsonArray sessions = history.getAsJsonArray("sessions");
                for (int i = 0; i < sessions.size(); i++) {
                    com.google.gson.JsonObject session = sessions.get(i).getAsJsonObject();
                    String sessionId = session.get("sessionId").getAsString();

                    if (titles.has(sessionId)) {
                        com.google.gson.JsonObject titleInfo = titles.getAsJsonObject(sessionId);
                        // 如果有自定义标题，则覆盖原始标题
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
     * 调用 Node.js favorites-service
     */
    private String callNodeJsFavoritesService(String functionName, String sessionId) throws Exception {
        // 获取 ai-bridge 路径
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // 构建 Node.js 命令
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

        // 读取输出
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

        // 返回最后一行（JSON 输出）
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * 调用 Node.js session-titles-service（无参数版本，用于 loadTitles）
     */
    private String callNodeJsTitlesService(String functionName, String dummy1, String dummy2) throws Exception {
        // 获取 ai-bridge 路径
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // 构建 Node.js 命令（loadTitles 不需要参数）
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

        // 读取输出
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

        // 返回最后一行（JSON 输出）
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * 调用 Node.js session-titles-service（带参数版本，用于 updateTitle）
     */
    private String callNodeJsTitlesServiceWithParams(String functionName, String sessionId, String customTitle) throws Exception {
        // 获取 ai-bridge 路径
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // 转义特殊字符
        String escapedTitle = customTitle.replace("\\", "\\\\").replace("'", "\\'");

        // 构建 Node.js 命令
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

        // 读取输出
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

        // 返回最后一行（JSON 输出）
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * 调用 Node.js session-titles-service 删除标题（单参数版本）
     */
    private String callNodeJsDeleteTitle(String sessionId) throws Exception {
        // 获取 ai-bridge 路径
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // 构建 Node.js 命令
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

        // 读取输出
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

        // 返回最后一行（JSON 输出）
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * 检查agent文件是否属于指定的会话
     * 通过读取文件内容查找sessionId引用
     */
    private boolean isAgentFileRelatedToSession(java.nio.file.Path agentFilePath, String sessionId) {
        try (java.io.BufferedReader reader = java.nio.file.Files.newBufferedReader(agentFilePath, java.nio.charset.StandardCharsets.UTF_8)) {
            String line;
            int lineCount = 0;
            // 只读取前20行以提高性能（通常sessionId会在文件开头）
            while ((line = reader.readLine()) != null && lineCount < 20) {
                // 检查这一行是否包含sessionId
                if (line.contains("\"sessionId\":\"" + sessionId + "\"") ||
                    line.contains("\"parentSessionId\":\"" + sessionId + "\"")) {
                    LOG.debug("[HistoryHandler] Agent文件 " + agentFilePath.getFileName() + " 属于会话 " + sessionId);
                    return true;
                }
                lineCount++;
            }
            // 如果前20行都没找到，说明这个agent文件不属于当前会话
            LOG.debug("[HistoryHandler] Agent文件 " + agentFilePath.getFileName() + " 不属于会话 " + sessionId);
            return false;
        } catch (Exception e) {
            // 如果读取失败，为了安全起见，不删除这个文件
            LOG.warn("[HistoryHandler] 无法读取agent文件 " + agentFilePath.getFileName() + ": " + e.getMessage());
            return false;
        }
    }
}
