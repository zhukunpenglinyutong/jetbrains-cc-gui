package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.github.claudecodegui.permission.PermissionManager;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.util.EditorFileUtils;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;

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

    private static final Logger LOG = Logger.getInstance(ClaudeSession.class);
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

    // IDEA 项目引用（用于获取打开的文件）
    private final Project project;

    // SDK 桥接
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;

    // 权限管理
    private final PermissionManager permissionManager = new PermissionManager();

    // 权限模式（传递给SDK）
    private String permissionMode = "default";

    // 模型名称（传递给SDK）
    private String model = "claude-sonnet-4-5";

    // AI 提供商（claude 或 codex）
    private String provider = "claude";

    // 斜杠命令列表（从 SDK 获取）
    private List<String> slashCommands = new ArrayList<>();

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
        void onThinkingStatusChanged(boolean isThinking);
        void onSlashCommandsReceived(List<String> slashCommands);
    }

    private SessionCallback callback;

    public ClaudeSession(Project project, ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.project = project;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;

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
        LOG.info("Working directory updated to: " + cwd);
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
                    LOG.warn("sessionId looks like a path, resetting: " + sessionId);
                    sessionId = null;
                }

                // 根据 provider 选择 SDK
                JsonObject result;
                if ("codex".equals(provider)) {
                    result = codexSDKBridge.launchChannel(channelId, sessionId, cwd);
                } else {
                    result = claudeSDKBridge.launchChannel(channelId, sessionId, cwd);
                }

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
                        LOG.warn("Ignoring invalid sessionId: " + newSessionId);
                    }
                }

                return channelId;
            } catch (Exception e) {
                this.error = e.getMessage();
                this.channelId = null;
                updateState();
                throw new RuntimeException("Failed to launch: " + e.getMessage(), e);
            }
        }).orTimeout(com.github.claudecodegui.config.TimeoutConfig.QUICK_OPERATION_TIMEOUT,
                     com.github.claudecodegui.config.TimeoutConfig.QUICK_OPERATION_UNIT)
          .exceptionally(ex -> {
              if (ex instanceof java.util.concurrent.TimeoutException) {
                  String timeoutMsg = "启动 Channel 超时（" +
                      com.github.claudecodegui.config.TimeoutConfig.QUICK_OPERATION_TIMEOUT + "秒），请重试";
                  LOG.warn(timeoutMsg);
                  this.error = timeoutMsg;
                  this.channelId = null;
                  updateState();
                  throw new RuntimeException(timeoutMsg);
              }
              throw new RuntimeException(ex.getCause());
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
        // long sendStartTime = System.currentTimeMillis();
        // LOG.info("[PERF][" + sendStartTime + "] ClaudeSession.send() 开始执行");

        // 规范化用户文本
        String normalizedInput = (input != null) ? input.trim() : "";
        // 添加用户消息到历史
        Message userMessage = new Message(Message.Type.USER, normalizedInput);
        try {
            if (attachments != null && !attachments.isEmpty()) {
                com.google.gson.JsonArray contentArr = new com.google.gson.JsonArray();

                // 添加图片块（使用与 claude-code 相同的格式，包含完整 base64 数据）
                for (Attachment att : attachments) {
                    if (att == null) continue;
                    String mt = (att.mediaType != null) ? att.mediaType : "";
                    if (mt.startsWith("image/") && att.data != null) {
                        // 图片块格式：{ type: "image", source: { type: "base64", media_type: "...", data: "..." } }
                        com.google.gson.JsonObject imageBlock = new com.google.gson.JsonObject();
                        imageBlock.addProperty("type", "image");
                        com.google.gson.JsonObject source = new com.google.gson.JsonObject();
                        source.addProperty("type", "base64");
                        source.addProperty("media_type", mt);
                        source.addProperty("data", att.data);
                        imageBlock.add("source", source);
                        contentArr.add(imageBlock);
                    }
                }

                // 当用户未输入文本时，提供一个占位说明
                String userDisplayText = normalizedInput;
                if (userDisplayText.isEmpty()) {
                    int imageCount = 0;
                    java.util.List<String> names = new java.util.ArrayList<>();
                    for (Attachment att : attachments) {
                        if (att != null && att.fileName != null && !att.fileName.isEmpty()) {
                            names.add(att.fileName);
                        }
                        String mt = (att != null && att.mediaType != null) ? att.mediaType : "";
                        if (mt.startsWith("image/")) {
                            imageCount++;
                        }
                    }
                    String nameSummary;
                    if (names.isEmpty()) {
                        nameSummary = imageCount > 0 ? (imageCount + " 张图片") : (attachments.size() + " 个附件");
                    } else {
                        if (names.size() > 3) {
                            nameSummary = String.join(", ", names.subList(0, 3)) + " 等";
                        } else {
                            nameSummary = String.join(", ", names);
                        }
                    }
                    userDisplayText = "已上传附件: " + nameSummary;
                }

                // 添加文本块
                com.google.gson.JsonObject textBlock = new com.google.gson.JsonObject();
                textBlock.addProperty("type", "text");
                textBlock.addProperty("text", userDisplayText);
                contentArr.add(textBlock);

                com.google.gson.JsonObject messageObj = new com.google.gson.JsonObject();
                messageObj.add("content", contentArr);
                com.google.gson.JsonObject rawUser = new com.google.gson.JsonObject();
                rawUser.add("message", messageObj);
                userMessage.raw = rawUser;
                userMessage.content = userDisplayText;
            }
        } catch (Exception e) {
            LOG.warn("Failed to attach raw image blocks: " + e.getMessage());
        }
        messages.add(userMessage);
        notifyMessageUpdate();

        // 更新摘要（第一条消息）
        if (summary == null) {
            String baseSummary = (userMessage.content != null && !userMessage.content.isEmpty())
                ? userMessage.content
                : normalizedInput;
            summary = baseSummary.length() > 45 ? baseSummary.substring(0, 45) + "..." : baseSummary;
        }

        this.lastModifiedTime = System.currentTimeMillis();
        this.error = null;  // 清除之前的错误状态，避免重复显示
        this.busy = true;
        this.loading = true;  // 设置 loading 状态，前端显示"Claude 正在思考"
        updateState();

        // long beforeLaunchTime = System.currentTimeMillis();
        // LOG.info("[PERF][" + beforeLaunchTime + "] 用户消息处理完成，准备 launchClaude()，耗时: " + (beforeLaunchTime - sendStartTime) + "ms");

        return launchClaude().thenCompose(chId -> {
            // long afterLaunchTime = System.currentTimeMillis();
            // LOG.info("[PERF][" + afterLaunchTime + "] launchClaude() 完成，耗时: " + (afterLaunchTime - beforeLaunchTime) + "ms");

            // 使用 ReadAction.nonBlocking() 在后台线程中安全地获取文件信息
            CompletableFuture<JsonObject> fileInfoFuture = new CompletableFuture<>();

            // long beforeFileInfoTime = System.currentTimeMillis();
            // LOG.info("[PERF][" + beforeFileInfoTime + "] 开始获取文件信息");

            ReadAction
                .nonBlocking(() -> {
                    try {
                        /*
                         * ========== 编辑器上下文信息采集 ==========
                         *
                         * 此处采集用户在 IDEA 编辑器中的工作环境信息，用于帮助 AI 理解用户当前的代码上下文。
                         * 这些信息会被构建成 JSON 格式，最终附加到发送给 AI 的系统提示词中。
                         *
                         * 采集的信息按优先级分为三层：
                         * 1. active (当前激活的文件) - 优先级最高，AI 的主要关注点
                         * 2. selection (用户选中的代码) - 如果存在，则是 AI 应该重点分析的核心对象
                         * 3. others (其他打开的文件) - 优先级最低，作为潜在的上下文参考
                         *
                         * 注意：这是只读操作，不会修改任何数据
                         */

                        String activeFile = EditorFileUtils.getCurrentActiveFile(project);
                        List<String> allOpenedFiles = EditorFileUtils.getOpenedFiles(project);
                        Map<String, Object> selectionInfo = EditorFileUtils.getSelectedCodeInfo(project);

                        /*
                         * ========== 构建上下文 JSON 对象 ==========
                         *
                         * JSON 结构说明：
                         * {
                         *   "active": "文件路径",           // 用户当前正在查看的文件（主要焦点）
                         *   "selection": {                 // 用户选中的代码（核心分析对象）
                         *     "startLine": 起始行号,
                         *     "endLine": 结束行号,
                         *     "selectedText": "选中的代码内容"
                         *   },
                         *   "others": ["文件1", "文件2"]   // 其他打开的文件（次要参考）
                         * }
                         *
                         * 这个 JSON 对象会被传递到 Node.js 层（message-service.js），
                         * 然后被转换为系统提示词的一部分，格式如下：
                         *
                         * ## Currently Open Files in IDE
                         * **Currently Active File** (primary focus):
                         * - /path/to/file.java#L20-24
                         *
                         * **Selected Code** (this is what the user is specifically asking about):
                         * ```java
                         * 用户选中的代码内容
                         * ```
                         * This selected code is the PRIMARY FOCUS.
                         *
                         * **Other Open Files** (potentially relevant):
                         * - /path/to/other1.java
                         * - /path/to/other2.java
                         */
                        JsonObject openedFilesJson = new JsonObject();

                        if (activeFile != null) {
                            // 添加当前激活的文件路径
                            openedFilesJson.addProperty("active", activeFile);
                            LOG.debug("Current active file: " + activeFile);

                            // 如果用户选中了代码，添加选中信息
                            // 这是最重要的上下文信息，AI 应该将其作为主要分析目标
                            if (selectionInfo != null) {
                                JsonObject selectionJson = new JsonObject();
                                selectionJson.addProperty("startLine", (Integer) selectionInfo.get("startLine"));
                                selectionJson.addProperty("endLine", (Integer) selectionInfo.get("endLine"));
                                selectionJson.addProperty("selectedText", (String) selectionInfo.get("selectedText"));
                                openedFilesJson.add("selection", selectionJson);
                                LOG.debug("Code selection detected: lines " +
                                    selectionInfo.get("startLine") + "-" + selectionInfo.get("endLine"));
                            }
                        }

                        // 添加其他打开的文件（排除激活文件，避免重复）
                        // 这些文件可能与用户的问题相关，但不是主要焦点
                        JsonArray othersArray = new JsonArray();
                        for (String file : allOpenedFiles) {
                            if (!file.equals(activeFile)) {
                                othersArray.add(file);
                            }
                        }
                        if (othersArray.size() > 0) {
                            openedFilesJson.add("others", othersArray);
                            LOG.debug("Other opened files count: " + othersArray.size());
                        }

                        return openedFilesJson;
                    } catch (Exception e) {
                        LOG.warn("Failed to get file info: " + e.getMessage());
                        // 返回空对象，不影响主流程
                        return new JsonObject();
                    }
                })
                .finishOnUiThread(com.intellij.openapi.application.ModalityState.defaultModalityState(), openedFilesJson -> {
                    // 文件信息获取完成，继续执行
                    // long afterFileInfoTime = System.currentTimeMillis();
                    // LOG.info("[PERF][" + afterFileInfoTime + "] 文件信息获取完成，耗时: " + (afterFileInfoTime - beforeFileInfoTime) + "ms");
                    fileInfoFuture.complete(openedFilesJson);
                })
                .submit(AppExecutorUtil.getAppExecutorService());

            return fileInfoFuture.thenCompose(openedFilesJson -> {
            // long beforeSdkCallTime = System.currentTimeMillis();
            // LOG.info("[PERF][" + beforeSdkCallTime + "] 准备调用 SDK sendMessage()");

            // 根据 provider 选择 SDK
            CompletableFuture<Void> sendFuture;
            if ("codex".equals(provider)) {
                sendFuture = codexSDKBridge.sendMessage(
                    chId,
                    normalizedInput,
                    sessionId,  // 传递当前 sessionId
                    cwd,        // 传递工作目录
                    attachments,
                    permissionMode, // 传递权限模式
                    model,      // 传递模型
                    new CodexSDKBridge.MessageCallback() {
                    private final StringBuilder assistantContent = new StringBuilder();
                    private Message currentAssistantMessage = null;

                    @Override
                    public void onMessage(String type, String content) {
                        // Codex 的简化处理（主要是 content_delta）
                        if ("content_delta".equals(type)) {
                            assistantContent.append(content);

                            if (currentAssistantMessage == null) {
                                currentAssistantMessage = new Message(Message.Type.ASSISTANT, assistantContent.toString());
                                messages.add(currentAssistantMessage);
                            } else {
                                currentAssistantMessage.content = assistantContent.toString();
                            }

                            notifyMessageUpdate();
                        } else if ("message_end".equals(type)) {
                            busy = false;
                            loading = false;
                            updateState();
                            LOG.debug("Codex message end received");
                        }
                    }

                    @Override
                    public void onError(String error) {
                        ClaudeSession.this.error = error;
                        busy = false;
                        loading = false;
                        Message errorMessage = new Message(Message.Type.ERROR, error);
                        messages.add(errorMessage);
                        notifyMessageUpdate();
                        updateState();
                    }

                    @Override
                    public void onComplete(CodexSDKBridge.SDKResult result) {
                        busy = false;
                        loading = false;
                        lastModifiedTime = System.currentTimeMillis();
                        updateState();
                    }
                }).thenApply(result -> (Void) null);
            } else {
                sendFuture = claudeSDKBridge.sendMessage(
                    chId,
                    normalizedInput,
                    sessionId,  // 传递当前 sessionId
                    cwd,        // 传递工作目录
                    attachments,
                    permissionMode, // 传递权限模式
                    model,      // 传递模型
                    openedFilesJson, // 传递打开的文件信息（包含激活文件和其他文件）
                    new ClaudeSDKBridge.MessageCallback() {
                private final StringBuilder assistantContent = new StringBuilder();
                private Message currentAssistantMessage = null;
                private boolean isThinking = false;

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
                            LOG.warn("Failed to parse assistant message JSON: " + e.getMessage());
                        }
                    } else if ("thinking".equals(type)) {
                        // 处理思考过程
                        if (!isThinking) {
                            isThinking = true;
                            // 通知前端开始思考
                            if (callback != null) {
                                callback.onThinkingStatusChanged(true);
                            }
                            LOG.debug("Thinking started");
                        }
                    } else if ("content".equals(type) || "content_delta".equals(type)) {
                        // 处理流式内容片段（content 向后兼容，content_delta 用于图片消息流式响应）
                        // 如果之前在思考，现在开始输出内容，说明思考完成
                        if (isThinking) {
                            isThinking = false;
                            if (callback != null) {
                                callback.onThinkingStatusChanged(false);
                            }
                            LOG.debug("Thinking completed");
                        }

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
                        LOG.info("Captured session ID: " + content);
                    } else if ("tool_result".equals(type) && content.startsWith("{")) {
                        // 实时处理工具调用结果
                        // 将 tool_result 添加到消息列表中，前端可以立即更新工具状态
                        try {
                            JsonObject toolResultBlock = gson.fromJson(content, JsonObject.class);
                            String toolUseId = toolResultBlock.has("tool_use_id")
                                ? toolResultBlock.get("tool_use_id").getAsString()
                                : null;

                            if (toolUseId != null) {
                                // 构造包含 tool_result 的 user 消息
                                JsonArray contentArray = new JsonArray();
                                contentArray.add(toolResultBlock);

                                JsonObject messageObj = new JsonObject();
                                messageObj.add("content", contentArray);

                                JsonObject rawUser = new JsonObject();
                                rawUser.addProperty("type", "user");
                                rawUser.add("message", messageObj);

                                // 创建 user 消息并添加到消息列表
                                Message toolResultMessage = new Message(Message.Type.USER, "[tool_result]", rawUser);
                                messages.add(toolResultMessage);

                                LOG.debug("Tool result received for tool_use_id: " + toolUseId);
                                notifyMessageUpdate();
                            }
                        } catch (Exception e) {
                            LOG.warn("Failed to parse tool_result JSON: " + e.getMessage());
                        }
                    } else if ("message_end".equals(type)) {
                        // 消息结束时立即更新 loading 状态，避免延迟
                        // long messageEndTime = System.currentTimeMillis();
                        // LOG.info("[PERF][" + messageEndTime + "] ClaudeSession 收到 message_end，立即更新状态");

                        if (isThinking) {
                            isThinking = false;
                            if (callback != null) {
                                callback.onThinkingStatusChanged(false);
                            }
                        }
                        busy = false;
                        loading = false;
                        updateState();
                    } else if ("result".equals(type) && content.startsWith("{")) {
                        // 处理结果消息（包含最终的usage信息）
                        try {
                            JsonObject resultJson = gson.fromJson(content, JsonObject.class);
                            LOG.debug("Result message received");

                            // 如果当前消息的raw中usage为0，则用result中的usage进行更新
                            if (currentAssistantMessage != null && currentAssistantMessage.raw != null) {
                                JsonObject message = currentAssistantMessage.raw.has("message") && currentAssistantMessage.raw.get("message").isJsonObject()
                                    ? currentAssistantMessage.raw.getAsJsonObject("message")
                                    : null;

                                // 检查当前消息的usage是否全为0
                                boolean needsUsageUpdate = false;
                                if (message != null && message.has("usage")) {
                                    JsonObject usage = message.getAsJsonObject("usage");
                                    int inputTokens = usage.has("input_tokens") ? usage.get("input_tokens").getAsInt() : 0;
                                    int outputTokens = usage.has("output_tokens") ? usage.get("output_tokens").getAsInt() : 0;
                                    if (inputTokens == 0 && outputTokens == 0) {
                                        needsUsageUpdate = true;
                                    }
                                } else {
                                    needsUsageUpdate = true;
                                }

                                if (needsUsageUpdate && resultJson.has("usage")) {
                                    JsonObject resultUsage = resultJson.getAsJsonObject("usage");
                                    if (message != null) {
                                        message.add("usage", resultUsage);
                                        notifyMessageUpdate();
                                        LOG.debug("Updated assistant message usage from result message");
                                    }
                                }
                            }
                        } catch (Exception e) {
                            LOG.warn("Failed to parse result message: " + e.getMessage());
                        }
                    } else if ("slash_commands".equals(type)) {
                        // 处理斜杠命令列表
                        try {
                            JsonArray commandsArray = gson.fromJson(content, JsonArray.class);
                            slashCommands.clear();
                            for (int i = 0; i < commandsArray.size(); i++) {
                                slashCommands.add(commandsArray.get(i).getAsString());
                            }
                            LOG.debug("Received " + slashCommands.size() + " slash commands");
                            if (callback != null) {
                                callback.onSlashCommandsReceived(slashCommands);
                            }
                        } catch (Exception e) {
                            LOG.warn("Failed to parse slash commands: " + e.getMessage());
                        }
                    } else if ("system".equals(type)) {
                        // 处理系统消息
                        LOG.debug("System message: " + content);

                        // 解析 system 消息中的 slash_commands 字段
                        try {
                            JsonObject systemObj = gson.fromJson(content, JsonObject.class);
                            if (systemObj.has("slash_commands") && systemObj.get("slash_commands").isJsonArray()) {
                                JsonArray commandsArray = systemObj.getAsJsonArray("slash_commands");
                                slashCommands.clear();
                                for (int i = 0; i < commandsArray.size(); i++) {
                                    slashCommands.add(commandsArray.get(i).getAsString());
                                }
                                LOG.debug("Extracted " + slashCommands.size() + " slash commands from system message");
                                if (callback != null) {
                                    callback.onSlashCommandsReceived(slashCommands);
                                }
                            }
                        } catch (Exception e) {
                            LOG.warn("Failed to extract slash commands from system message: " + e.getMessage());
                        }
                    }
                }

                @Override
                public void onError(String error) {
                    ClaudeSession.this.error = error;
                    busy = false;
                    loading = false;
                    Message errorMessage = new Message(Message.Type.ERROR, error);
                    messages.add(errorMessage);
                    notifyMessageUpdate();
                    updateState();
                }

                @Override
                public void onComplete(ClaudeSDKBridge.SDKResult result) {
                    busy = false;
                    loading = false;
                    lastModifiedTime = System.currentTimeMillis();
                    updateState();
                }
            }).thenApply(result -> (Void) null);
            }

            return sendFuture;
            });
        }).exceptionally(ex -> {
            this.error = ex.getMessage();
            this.busy = false;
            this.loading = false;
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
                if ("codex".equals(provider)) {
                    codexSDKBridge.interruptChannel(channelId);
                } else {
                    claudeSDKBridge.interruptChannel(channelId);
                }
                this.error = null;  // 清除之前的错误状态
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
                LOG.info("Loading session from server: sessionId=" + sessionId + ", cwd=" + cwd);
                List<JsonObject> serverMessages;
                if ("codex".equals(provider)) {
                    serverMessages = codexSDKBridge.getSessionMessages(sessionId, cwd);
                } else {
                    serverMessages = claudeSDKBridge.getSessionMessages(sessionId, cwd);
                }
                LOG.debug("Received " + serverMessages.size() + " messages from server");

                messages.clear();
                for (JsonObject msg : serverMessages) {
                    Message message = parseServerMessage(msg);
                    if (message != null) {
                        messages.add(message);
                        // System.out.println("[ClaudeSession] Parsed message: type=" + message.type + ", content length=" + message.content.length());
                    } else {
                        // System.out.println("[ClaudeSession] Failed to parse message: " + msg);
                    }
                }

                LOG.debug("Total messages in session: " + messages.size());
                notifyMessageUpdate();
            } catch (Exception e) {
                LOG.error("Error loading session: " + e.getMessage(), e);
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

        // 过滤 isMeta 消息（如 "Caveat: The messages below were generated..."）
        if (msg.has("isMeta") && msg.get("isMeta").getAsBoolean()) {
            return null;
        }

        // 过滤命令消息（包含 <command-name> 或 <local-command-stdout> 标签）
        if (msg.has("message") && msg.get("message").isJsonObject()) {
            JsonObject message = msg.getAsJsonObject("message");
            if (message.has("content")) {
                JsonElement contentElement = message.get("content");
                String contentStr = null;

                if (contentElement.isJsonPrimitive()) {
                    contentStr = contentElement.getAsString();
                } else if (contentElement.isJsonArray()) {
                    // 检查数组中的文本内容
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

        if ("user".equals(type)) {
            String content = extractMessageContent(msg);
            // 如果内容为空或只包含空白字符，检查是否有 tool_result
            // tool_result 消息需要保留，因为前端需要用它来显示工具调用结果
            if (content == null || content.trim().isEmpty()) {
                // 检查是否包含 tool_result
                if (msg.has("message") && msg.get("message").isJsonObject()) {
                    JsonObject message = msg.getAsJsonObject("message");
                    if (message.has("content") && message.get("content").isJsonArray()) {
                        JsonArray contentArray = message.getAsJsonArray("content");
                        for (int i = 0; i < contentArray.size(); i++) {
                            JsonElement element = contentArray.get(i);
                            if (element.isJsonObject()) {
                                JsonObject block = element.getAsJsonObject();
                                if (block.has("type") && "tool_result".equals(block.get("type").getAsString())) {
                                    // 包含 tool_result，保留此消息（使用占位符内容）
                                    return new Message(Message.Type.USER, "[tool_result]", msg);
                                }
                            }
                        }
                    }
                }
                return null;
            }
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
            // 尝试直接从顶层获取 content（某些消息格式可能不同）
            if (msg.has("content")) {
                return extractContentFromElement(msg.get("content"));
            }
            return "";
        }

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return "";
        }

        // 获取content元素
        com.google.gson.JsonElement contentElement = message.get("content");
        return extractContentFromElement(contentElement);
    }

    /**
     * 从 JsonElement 中提取内容
     */
    private String extractContentFromElement(com.google.gson.JsonElement contentElement) {
        // 字符串格式
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        // 数组格式
        if (contentElement.isJsonArray()) {
            JsonArray contentArray = contentElement.getAsJsonArray();
            StringBuilder sb = new StringBuilder();
            boolean hasContent = false;

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
                        hasContent = true;
                    } else if ("tool_use".equals(blockType) && block.has("name") && !block.get("name").isJsonNull()) {
                        // 工具使用消息
                        String toolName = block.get("name").getAsString();
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append("[使用工具: ").append(toolName).append("]");
                        hasContent = true;
                    } else if ("tool_result".equals(blockType)) {
                        // 工具结果 - 不展示，因为对用户没有实际意义
                        // 工具结果通常很长，且已经在 assistant 的响应中体现
                        // 这里跳过不处理
                    } else if ("thinking".equals(blockType) && block.has("thinking") && !block.get("thinking").isJsonNull()) {
                        // 思考过程 - 添加一个简短提示
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append("[思考过程]");
                        hasContent = true;
                    } else if ("image".equals(blockType)) {
                        // 图片消息
                        if (sb.length() > 0) {
                            sb.append("\n");
                        }
                        sb.append("[图片]");
                        hasContent = true;
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

            // 如果没有提取到任何内容，记录调试信息
            if (!hasContent && contentArray.size() > 0) {
                // System.err.println("[ClaudeSession] Warning: Content array has " + contentArray.size() +
                //     " elements but no content was extracted. First element: " +
                //     (contentArray.size() > 0 ? contentArray.get(0).toString() : "N/A"));
            }

            return sb.toString();
        }

        // 对象格式（某些特殊情况）
        if (contentElement.isJsonObject()) {
            JsonObject contentObj = contentElement.getAsJsonObject();
            // 尝试提取 text 字段
            if (contentObj.has("text") && !contentObj.get("text").isJsonNull()) {
                return contentObj.get("text").getAsString();
            }
            // 记录无法解析的对象格式
            LOG.warn("Content is an object but has no 'text' field: " + contentObj.toString());
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
        // LOG.info("[ClaudeSession] ========== PERMISSION MODE CHANGE ==========");
        // LOG.info("[ClaudeSession] Old mode: " + this.permissionMode);
        // LOG.info("[ClaudeSession] New mode: " + mode);
        this.permissionMode = mode;
        // LOG.info("[ClaudeSession] Permission mode updated successfully");
        // LOG.info("[ClaudeSession] =============================================");
    }

    /**
     * 获取权限模式
     */
    public String getPermissionMode() {
        return permissionMode;
    }

    /**
     * 设置模型
     */
    public void setModel(String model) {
        this.model = model;
        LOG.info("Model updated to: " + model);
    }

    /**
     * 获取模型
     */
    public String getModel() {
        return model;
    }

    /**
     * 设置AI提供商
     */
    public void setProvider(String provider) {
        this.provider = provider;
        LOG.info("Provider updated to: " + provider);
    }

    /**
     * 获取AI提供商
     */
    public String getProvider() {
        return provider;
    }

    /**
     * 获取斜杠命令列表
     */
    public List<String> getSlashCommands() {
        return new ArrayList<>(slashCommands);
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
        return permissionManager.createRequest(channelId, toolName, inputs, suggestions, project);
    }

    /**
     * 处理权限决策
     */
    public void handlePermissionDecision(String channelId, boolean allow, boolean remember, String rejectMessage) {
        permissionManager.handlePermissionDecision(channelId, allow, remember, rejectMessage);
    }

    /**
     * 处理权限决策（总是允许）
     */
    public void handlePermissionDecisionAlways(String channelId, boolean allow) {
        permissionManager.handlePermissionDecisionAlways(channelId, allow);
    }
}
