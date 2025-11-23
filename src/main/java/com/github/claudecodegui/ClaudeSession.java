package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.github.claudecodegui.permission.PermissionManager;
import com.github.claudecodegui.permission.PermissionRequest;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/**
 * Claude 会话管理类
 * 负责维护单个对话会话的状态和消息历史
 */
public class ClaudeSession {

    private final Gson gson = new Gson();

    // 会话标识
    private String sessionId;
    private String channelId;

    // 会话状态
    private boolean busy = false;
    private boolean loading = false;
    private String error = null;

    // 消息历史
    private final List<Message> messages = new ArrayList<>();

    // 会话元数据
    private String summary = null;
    private long lastModifiedTime = System.currentTimeMillis();
    private String cwd = null;
    // SDK 桥接
    private final ClaudeSDKBridge sdkBridge;

    // 权限管理
    private final PermissionManager permissionManager = new PermissionManager();

    // 权限模式（传递给SDK）
    private String permissionMode = "default";

    /**
     * 消息类
     */
    public static class Message {
        public enum Type {
            USER, ASSISTANT, SYSTEM, ERROR
        }

        public Type type;
        public String content;
        public long timestamp;
        public JsonObject raw; // 原始消息数据

        public Message(Type type, String content) {
            this.type = type;
            this.content = content;
            this.timestamp = System.currentTimeMillis();
        }

        public Message(Type type, String content, JsonObject raw) {
            this(type, content);
            this.raw = raw;
        }
    }

    /**
     * 会话回调接口
     */
    public interface SessionCallback {
        void onMessageUpdate(List<Message> messages);
        void onStateChange(boolean busy, boolean loading, String error);
        void onSessionIdReceived(String sessionId);
        void onPermissionRequested(PermissionRequest request);
    }

    private SessionCallback callback;

    public ClaudeSession(ClaudeSDKBridge sdkBridge) {
        this.sdkBridge = sdkBridge;

        // 设置权限管理器回调
        permissionManager.setOnPermissionRequestedCallback(request -> {
            if (callback != null) {
                callback.onPermissionRequested(request);
            }
        });
    }

    public void setCallback(SessionCallback callback) {
        this.callback = callback;
    }

    // Getters
    public String getSessionId() {
        return sessionId;
    }

    public String getChannelId() {
        return channelId;
    }

    public boolean isBusy() {
        return busy;
    }

    public boolean isLoading() {
        return loading;
    }

    public String getError() {
        return error;
    }

    public List<Message> getMessages() {
        return new ArrayList<>(messages);
    }

    public String getSummary() {
        return summary;
    }

    public long getLastModifiedTime() {
        return lastModifiedTime;
    }

    /**
     * 设置会话ID和工作目录（用于恢复会话）
     */
    public void setSessionInfo(String sessionId, String cwd) {
        this.sessionId = sessionId;
        if (cwd != null) {
            setCwd(cwd);
        } else {
            this.cwd = null;
        }
    }

    /**
     * 获取当前工作目录
     */
    public String getCwd() {
        return cwd;
    }

    /**
     * 设置工作目录
     */
    public void setCwd(String cwd) {
        this.cwd = cwd;
        System.out.println("[ClaudeSession] Working directory updated to: " + cwd);
    }

    /**
     * 启动 Claude Agent
     * 如果已有 channelId 则复用，否则创建新的
     */
    public CompletableFuture<String> launchClaude() {
        if (channelId != null) {
            return CompletableFuture.completedFuture(channelId);
        }

        this.error = null;
        this.channelId = UUID.randomUUID().toString();

        return CompletableFuture.supplyAsync(() -> {
            try {
                // 检查并清理错误的 sessionId（如果是路径而不是 UUID）
                if (sessionId != null && (sessionId.contains("/") || sessionId.contains("\\"))) {
                    System.err.println("[ClaudeSession] Warning: sessionId looks like a path, resetting: " + sessionId);
                    sessionId = null;
                }

                // 调用 SDK 启动 channel
                JsonObject result = sdkBridge.launchChannel(channelId, sessionId, cwd);

                // 检查 sessionId 是否存在且不为 null
                if (result.has("sessionId") && !result.get("sessionId").isJsonNull()) {
                    String newSessionId = result.get("sessionId").getAsString();
                    // 验证 sessionId 格式（应该是 UUID 格式）
                    if (!newSessionId.contains("/") && !newSessionId.contains("\\")) {
                        this.sessionId = newSessionId;
                        if (callback != null) {
                            callback.onSessionIdReceived(sessionId);
                        }
                    } else {
                        System.err.println("[ClaudeSession] Ignoring invalid sessionId: " + newSessionId);
                    }
                }

                return channelId;
            } catch (Exception e) {
                this.error = e.getMessage();
                this.channelId = null;
                updateState();
                throw new RuntimeException("Failed to launch Claude: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 发送消息
     */
    public CompletableFuture<Void> send(String input) {
        return send(input, null);
    }

    /**
     * 发送消息（支持附件）
     */
    public CompletableFuture<Void> send(String input, List<Attachment> attachments) {
        // 添加用户消息到历史
        Message userMessage = new Message(Message.Type.USER, input);
        messages.add(userMessage);
        notifyMessageUpdate();

        // 更新摘要（第一条消息）
        if (summary == null) {
            summary = input.length() > 45 ? input.substring(0, 45) + "..." : input;
        }

        this.lastModifiedTime = System.currentTimeMillis();
        this.busy = true;
        updateState();

        return launchClaude().thenCompose(chId -> {
            CompletableFuture<Void> sendFuture = sdkBridge.sendMessage(
                chId,
                input,
                sessionId,  // 传递当前 sessionId
                cwd,        // 传递工作目录
                attachments,
                permissionMode, // 传递权限模式
                new ClaudeSDKBridge.MessageCallback() {
                private final StringBuilder assistantContent = new StringBuilder();
                private Message currentAssistantMessage = null;

                @Override
                public void onMessage(String type, String content) {
                    // 处理完整的原始消息（从 [MESSAGE] 输出）
                    if ("assistant".equals(type) && content.startsWith("{")) {
                        try {
                            // 解析完整的 JSON 消息
                            JsonObject messageJson = gson.fromJson(content, JsonObject.class);
                            JsonObject previousRaw = currentAssistantMessage != null ? currentAssistantMessage.raw : null;
                            JsonObject mergedRaw = mergeAssistantMessage(previousRaw, messageJson);

                            if (currentAssistantMessage == null) {
                                currentAssistantMessage = new Message(Message.Type.ASSISTANT, "", mergedRaw);
                                messages.add(currentAssistantMessage);
                            } else {
                                currentAssistantMessage.raw = mergedRaw;
                            }
                            
                            String aggregatedText = extractMessageContent(mergedRaw);
                            assistantContent.setLength(0);
                            if (aggregatedText != null) {
                                assistantContent.append(aggregatedText);
                            }
                            currentAssistantMessage.content = assistantContent.toString();
                            currentAssistantMessage.raw = mergedRaw;
                            notifyMessageUpdate();
                        } catch (Exception e) {
                            System.err.println("Failed to parse assistant message JSON: " + e.getMessage());
                        }
                    } else if ("content".equals(type)) {
                        // 处理流式内容片段（向后兼容）
                        assistantContent.append(content);

                        if (currentAssistantMessage == null) {
                            currentAssistantMessage = new Message(Message.Type.ASSISTANT, assistantContent.toString());
                            messages.add(currentAssistantMessage);
                        } else {
                            currentAssistantMessage.content = assistantContent.toString();
                        }

                        notifyMessageUpdate();
                    } else if ("session_id".equals(type)) {
                        // 捕获并保存 session_id
                        ClaudeSession.this.sessionId = content;
                        if (callback != null) {
                            callback.onSessionIdReceived(content);
                        }
                        System.out.println("Captured session ID: " + content);
                    } else if ("system".equals(type)) {
                        // 处理系统消息
                        System.out.println("System message: " + content);
                    }
                }

                @Override
                public void onError(String error) {
                    ClaudeSession.this.error = error;
                    Message errorMessage = new Message(Message.Type.ERROR, error);
                    messages.add(errorMessage);
                    notifyMessageUpdate();
                    updateState();
                }

                @Override
                public void onComplete(ClaudeSDKBridge.SDKResult result) {
                    busy = false;
                    lastModifiedTime = System.currentTimeMillis();
                    updateState();
                }
            }).thenApply(result -> (Void) null);

            return sendFuture;
        }).exceptionally(ex -> {
            this.error = ex.getMessage();
            this.busy = false;
            updateState();
            return null;
        });
    }

    /**
     * 中断当前执行
     */
    public CompletableFuture<Void> interrupt() {
        if (channelId == null) {
            return CompletableFuture.completedFuture(null);
        }

        return CompletableFuture.runAsync(() -> {
            try {
                sdkBridge.interruptChannel(channelId);
                this.busy = false;
                updateState();
            } catch (Exception e) {
                this.error = e.getMessage();
                updateState();
            }
        });
    }

    /**
     * 重启 Claude Agent
     */
    public CompletableFuture<Void> restart() {
        return interrupt().thenCompose(v -> {
            this.channelId = null;
            this.busy = false;
            updateState();
            return launchClaude().thenApply(chId -> null);
        });
    }

    /**
     * 加载服务器端的历史消息
     */
    public CompletableFuture<Void> loadFromServer() {
        if (sessionId == null) {
            return CompletableFuture.completedFuture(null);
        }

        this.loading = true;
        updateState();

        return CompletableFuture.runAsync(() -> {
            try {
                System.out.println("[ClaudeSession] Loading session from server: sessionId=" + sessionId + ", cwd=" + cwd);
                List<JsonObject> serverMessages = sdkBridge.getSessionMessages(sessionId, cwd);
                System.out.println("[ClaudeSession] Received " + serverMessages.size() + " messages from server");

                messages.clear();
                for (JsonObject msg : serverMessages) {
                    Message message = parseServerMessage(msg);
                    if (message != null) {
                        messages.add(message);
                        System.out.println("[ClaudeSession] Parsed message: type=" + message.type + ", content length=" + message.content.length());
                    } else {
                        System.out.println("[ClaudeSession] Failed to parse message: " + msg);
                    }
                }

                System.out.println("[ClaudeSession] Total messages in session: " + messages.size());
                notifyMessageUpdate();
            } catch (Exception e) {
                System.err.println("[ClaudeSession] Error loading session: " + e.getMessage());
                e.printStackTrace();
                this.error = e.getMessage();
            } finally {
                this.loading = false;
                updateState();
            }
        });
    }

    /**
     * 解析服务器返回的消息
     */
    private Message parseServerMessage(JsonObject msg) {
        String type = msg.has("type") ? msg.get("type").getAsString() : null;

        if ("user".equals(type)) {
            String content = extractMessageContent(msg);
            return new Message(Message.Type.USER, content, msg);
        } else if ("assistant".equals(type)) {
            String content = extractMessageContent(msg);
            return new Message(Message.Type.ASSISTANT, content, msg);
        }

        return null;
    }

    /**
     * 提取消息内容
     */
    private String extractMessageContent(JsonObject msg) {
        if (!msg.has("message")) {
            return "";
        }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return "";
        }

        // 获取content元素
        com.google.gson.JsonElement contentElement = message.get("content");

        // 字符串格式
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        // 数组格式
        if (contentElement.isJsonArray()) {
            JsonArray contentArray = contentElement.getAsJsonArray();
            StringBuilder sb = new StringBuilder();

            for (int i = 0; i < contentArray.size(); i++) {
                com.google.gson.JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    JsonObject block = element.getAsJsonObject();
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
                    } else if ("tool_use".equals(blockType) && block.has("name") && !block.get("name").isJsonNull()) {
                        // 工具使用消息
                        String toolName = block.get("name").getAsString();
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append("[使用工具: ").append(toolName).append("]");
                    } else if ("thinking".equals(blockType) && block.has("thinking") && !block.get("thinking").isJsonNull()) {
                        // 思考过程 - 添加一个简短提示
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append("[思考过程]");
                    }
                }
            }

            return sb.toString();
        }

        return "";
    }

    /**
     * 通知消息更新
     */
    private void notifyMessageUpdate() {
        if (callback != null) {
            callback.onMessageUpdate(getMessages());
        }
    }

    /**
     * 通知状态更新
     */
    private void updateState() {
        if (callback != null) {
            callback.onStateChange(busy, loading, error);
        }
    }

    /**
     * 附件类
     */
    public static class Attachment {
        public String fileName;
        public String mediaType;
        public String data; // Base64 编码

        public Attachment(String fileName, String mediaType, String data) {
            this.fileName = fileName;
            this.mediaType = mediaType;
            this.data = data;
        }
    }

    /**
     * 获取权限管理器
     */
    public PermissionManager getPermissionManager() {
        return permissionManager;
    }

    /**
     * 设置权限模式
     */
    public void setPermissionMode(String mode) {
        this.permissionMode = mode;
    }

    /**
     * 获取权限模式
     */
    public String getPermissionMode() {
        return permissionMode;
    }

    /**
     * 合并流式助手消息，确保之前展示的工具步骤不会被覆盖
     */
    private JsonObject mergeAssistantMessage(JsonObject existingRaw, JsonObject newRaw) {
        if (newRaw == null) {
            return existingRaw != null ? existingRaw.deepCopy() : null;
        }

        if (existingRaw == null) {
            return newRaw.deepCopy();
        }

        JsonObject merged = existingRaw.deepCopy();

        // 合并顶层字段（除 message 外）
        for (Map.Entry<String, JsonElement> entry : newRaw.entrySet()) {
            if ("message".equals(entry.getKey())) {
                continue;
            }
            merged.add(entry.getKey(), entry.getValue());
        }

        JsonObject incomingMessage = newRaw.has("message") && newRaw.get("message").isJsonObject()
            ? newRaw.getAsJsonObject("message")
            : null;

        if (incomingMessage == null) {
            return merged;
        }

        JsonObject mergedMessage = merged.has("message") && merged.get("message").isJsonObject()
            ? merged.getAsJsonObject("message")
            : new JsonObject();

        // 复制新元数据（保留最新 stop_reason、usage 等）
        for (Map.Entry<String, JsonElement> entry : incomingMessage.entrySet()) {
            if ("content".equals(entry.getKey())) {
                continue;
            }
            mergedMessage.add(entry.getKey(), entry.getValue());
        }

        mergeAssistantContentArray(mergedMessage, incomingMessage);
        merged.add("message", mergedMessage);
        return merged;
    }

    private void mergeAssistantContentArray(JsonObject targetMessage, JsonObject incomingMessage) {
        JsonArray baseContent = targetMessage.has("content") && targetMessage.get("content").isJsonArray()
            ? targetMessage.getAsJsonArray("content")
            : new JsonArray();

        Map<String, Integer> indexByKey = buildContentIndex(baseContent);

        JsonArray incomingContent = incomingMessage.has("content") && incomingMessage.get("content").isJsonArray()
            ? incomingMessage.getAsJsonArray("content")
            : null;

        if (incomingContent == null) {
            targetMessage.add("content", baseContent);
            return;
        }

        for (int i = 0; i < incomingContent.size(); i++) {
            JsonElement element = incomingContent.get(i);
            JsonElement elementCopy = element.deepCopy();

            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                String key = getContentBlockKey(block);
                if (key != null && indexByKey.containsKey(key)) {
                    int idx = indexByKey.get(key);
                    baseContent.set(idx, elementCopy);
                    continue;
                } else if (key != null) {
                    baseContent.add(elementCopy);
                    indexByKey.put(key, baseContent.size() - 1);
                    continue;
                }
            }

            baseContent.add(elementCopy);
        }

        targetMessage.add("content", baseContent);
    }

    private Map<String, Integer> buildContentIndex(JsonArray contentArray) {
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < contentArray.size(); i++) {
            JsonElement element = contentArray.get(i);
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject block = element.getAsJsonObject();
            String key = getContentBlockKey(block);
            if (key != null && !index.containsKey(key)) {
                index.put(key, i);
            }
        }
        return index;
    }

    private String getContentBlockKey(JsonObject block) {
        if (block.has("id") && !block.get("id").isJsonNull()) {
            return block.get("id").getAsString();
        }

        if (block.has("tool_use_id") && !block.get("tool_use_id").isJsonNull()) {
            return "tool_result:" + block.get("tool_use_id").getAsString();
        }

        return null;
    }

    /**
     * 创建权限请求（供SDK调用）
     */
    public PermissionRequest createPermissionRequest(String toolName, Map<String, Object> inputs, JsonObject suggestions) {
        return permissionManager.createRequest(channelId, toolName, inputs, suggestions);
    }

    /**
     * 处理权限决策
     */
    public void handlePermissionDecision(String channelId, boolean allow, boolean remember, String rejectMessage) {
        permissionManager.handlePermissionDecision(channelId, allow, remember, rejectMessage);
    }
}
