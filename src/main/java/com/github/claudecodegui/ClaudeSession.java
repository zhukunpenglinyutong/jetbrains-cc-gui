package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.github.claudecodegui.permission.PermissionManager;
import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.session.ClaudeMessageHandler;
import com.github.claudecodegui.session.CodexMessageHandler;
import com.github.claudecodegui.util.EditorFileUtils;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.project.Project;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.Nullable;

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
    private final Project project;

    // 会话状态管理器
    private final com.github.claudecodegui.session.SessionState state;

    // 消息处理器
    private final com.github.claudecodegui.session.MessageParser messageParser;
    private final com.github.claudecodegui.session.MessageMerger messageMerger;

    // 上下文收集器
    private final com.github.claudecodegui.session.EditorContextCollector contextCollector;

    // 回调处理器
    private final com.github.claudecodegui.session.CallbackHandler callbackHandler;

    // SDK 桥接
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;

    // 权限管理
    private final PermissionManager permissionManager = new PermissionManager();

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
        default void onStatusMessage(String message) {}
        void onSessionIdReceived(String sessionId);
        void onPermissionRequested(PermissionRequest request);
        void onThinkingStatusChanged(boolean isThinking);
        void onSlashCommandsReceived(List<String> slashCommands);
        void onNodeLog(String log);
        void onSummaryReceived(String summary);

        // 🔧 流式传输回调方法（带默认实现，保持向后兼容）
        default void onStreamStart() {}
        default void onStreamEnd() {}
        default void onContentDelta(String delta) {}
        default void onThinkingDelta(String delta) {}
    }

    public ClaudeSession(Project project, ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.project = project;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;

        // 初始化管理器
        this.state = new com.github.claudecodegui.session.SessionState();
        this.messageParser = new com.github.claudecodegui.session.MessageParser();
        this.messageMerger = new com.github.claudecodegui.session.MessageMerger();
        this.contextCollector = new com.github.claudecodegui.session.EditorContextCollector(project);
        this.callbackHandler = new com.github.claudecodegui.session.CallbackHandler();

        // 设置权限管理器回调
        permissionManager.setOnPermissionRequestedCallback(request -> {
            callbackHandler.notifyPermissionRequested(request);
        });
    }

    public void setCallback(SessionCallback callback) {
        callbackHandler.setCallback(callback);
    }

    public com.github.claudecodegui.session.EditorContextCollector getContextCollector() {
        return contextCollector;
    }

    // Getters - 委托给 SessionState
    public String getSessionId() {
        return state.getSessionId();
    }

    public String getChannelId() {
        return state.getChannelId();
    }

    public boolean isBusy() {
        return state.isBusy();
    }

    public boolean isLoading() {
        return state.isLoading();
    }

    public String getError() {
        return state.getError();
    }

    public List<Message> getMessages() {
        return state.getMessages();
    }

    public String getSummary() {
        return state.getSummary();
    }

    public long getLastModifiedTime() {
        return state.getLastModifiedTime();
    }

    /**
     * 设置会话ID和工作目录（用于恢复会话）
     */
    public void setSessionInfo(String sessionId, String cwd) {
        state.setSessionId(sessionId);
        if (cwd != null) {
            setCwd(cwd);
        } else {
            state.setCwd(null);
        }
    }

    /**
     * 获取当前工作目录
     */
    public String getCwd() {
        return state.getCwd();
    }

    /**
     * 设置工作目录
     */
    public void setCwd(String cwd) {
        state.setCwd(cwd);
        LOG.info("Working directory updated to: " + cwd);
    }

    /**
     * 启动 Claude Agent
     * 如果已有 channelId 则复用，否则创建新的
     */
    public CompletableFuture<String> launchClaude() {
        if (state.getChannelId() != null) {
            return CompletableFuture.completedFuture(state.getChannelId());
        }

        state.setError(null);
        state.setChannelId(UUID.randomUUID().toString());

        return CompletableFuture.supplyAsync(() -> {
            try {
                // 检查并清理错误的 sessionId（如果是路径而不是 UUID）
                String currentSessionId = state.getSessionId();
                if (currentSessionId != null && (currentSessionId.contains("/") || currentSessionId.contains("\\"))) {
                    LOG.warn("sessionId looks like a path, resetting: " + currentSessionId);
                    state.setSessionId(null);
                    currentSessionId = null;
                }

                // 根据 provider 选择 SDK
                JsonObject result;
                String currentProvider = state.getProvider();
                String currentChannelId = state.getChannelId();
                String currentCwd = state.getCwd();
                if ("codex".equals(currentProvider)) {
                    result = codexSDKBridge.launchChannel(currentChannelId, currentSessionId, currentCwd);
                } else {
                    result = claudeSDKBridge.launchChannel(currentChannelId, currentSessionId, currentCwd);
                }

                // 检查 sessionId 是否存在且不为 null
                if (result.has("sessionId") && !result.get("sessionId").isJsonNull()) {
                    String newSessionId = result.get("sessionId").getAsString();
                    // 验证 sessionId 格式（应该是 UUID 格式）
                    if (!newSessionId.contains("/") && !newSessionId.contains("\\")) {
                        state.setSessionId(newSessionId);
                        callbackHandler.notifySessionIdReceived(newSessionId);
                    } else {
                        LOG.warn("Ignoring invalid sessionId: " + newSessionId);
                    }
                }

                return currentChannelId;
            } catch (Exception e) {
                state.setError(e.getMessage());
                state.setChannelId(null);
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
                  state.setError(timeoutMsg);
                  state.setChannelId(null);
                  updateState();
                  throw new RuntimeException(timeoutMsg);
              }
              throw new RuntimeException(ex.getCause());
          });
    }

    /**
     * 发送消息（使用全局智能体设置）
     * 【注意】此方法用于向后兼容，优先使用 send(input, agentPrompt) 版本
     */
    public CompletableFuture<Void> send(String input) {
        return send(input, (List<Attachment>) null, null);
    }

    /**
     * 【FIX】发送消息（指定智能体提示词）
     * 英文：Send message with specific agent prompt
     * 解释：发送消息给AI，使用指定的智能体提示词（用于多标签页独立智能体选择）
     */
    public CompletableFuture<Void> send(String input, String agentPrompt) {
        return send(input, null, agentPrompt);
    }

    /**
     * 发送消息（支持附件，使用全局智能体设置）
     * 【注意】此方法用于向后兼容，优先使用 send(input, attachments, agentPrompt) 版本
     */
    public CompletableFuture<Void> send(String input, List<Attachment> attachments) {
        return send(input, attachments, null);
    }

    /**
     * 【FIX】发送消息（支持附件和指定智能体提示词）
     * 英文：Send message with attachments and specific agent prompt
     * 解释：发送消息给AI，带上图片等附件，使用指定的智能体提示词（用于多标签页独立智能体选择）
     * @param input 用户输入的消息文本
     * @param attachments 附件列表（可为空）
     * @param agentPrompt 智能体提示词（如为空则使用全局设置）
     */
    public CompletableFuture<Void> send(String input, List<Attachment> attachments, String agentPrompt) {
        // 第1步：准备用户消息
        // Step 1: Prepare user message
        // 解释：把用户说的话和图片整理好
        String normalizedInput = (input != null) ? input.trim() : "";
        Message userMessage = buildUserMessage(normalizedInput, attachments);

        // 第2步：更新会话状态
        // Step 2: Update session state
        // 解释：把消息存起来，更新状态
        updateSessionStateForSend(userMessage, normalizedInput);

        // 保存 agentPrompt 用于后续发送
        final String finalAgentPrompt = agentPrompt;

        // 第3步：启动Claude并发送消息
        // Step 3: Launch Claude and send message
        // 解释：叫醒AI，发消息过去
        return launchClaude().thenCompose(chId -> {
            // 设置是否启用PSI语义上下文收集
            contextCollector.setPsiContextEnabled(state.isPsiContextEnabled());
            return contextCollector.collectContext().thenCompose(openedFilesJson ->
                sendMessageToProvider(chId, normalizedInput, attachments, openedFilesJson, finalAgentPrompt)
            );
        }).exceptionally(ex -> {
            state.setError(ex.getMessage());
            state.setBusy(false);
            state.setLoading(false);
            updateState();
            return null;
        });
    }

    /**
     * 构建用户消息
     * 英文：Build user message
     * 解释：把用户的文字和图片组装成规范的消息格式
     */
    private Message buildUserMessage(String normalizedInput, List<Attachment> attachments) {
        Message userMessage = new Message(Message.Type.USER, normalizedInput);

        try {
            JsonArray contentArr = new JsonArray();
            String userDisplayText = normalizedInput;

            // 处理附件
            // Handle attachments
            // 解释：有图片的话，把图片加进去
            if (attachments != null && !attachments.isEmpty()) {
                // 添加图片块
                for (Attachment att : attachments) {
                    if (isImageAttachment(att)) {
                        contentArr.add(createImageBlock(att));
                    }
                }

                // 当用户未输入文本时，提供占位说明
                // Provide placeholder when no text input
                // 解释：如果只发了图，没写字，就显示"已上传图片"
                if (userDisplayText.isEmpty()) {
                    userDisplayText = generateAttachmentSummary(attachments);
                }
            }

            // 添加文本块（始终添加）
            // Always add text block
            // 解释：把用户说的话也加进去
            contentArr.add(createTextBlock(userDisplayText));

            // 组装完整消息
            // Assemble complete message
            // 解释：把所有内容打包成完整消息
            JsonObject messageObj = new JsonObject();
            messageObj.add("content", contentArr);
            JsonObject rawUser = new JsonObject();
            rawUser.add("message", messageObj);
            userMessage.raw = rawUser;
            userMessage.content = userDisplayText;

            LOG.info("[ClaudeSession] Created user message: content=" +
                    (userDisplayText.length() > 50 ? userDisplayText.substring(0, 50) + "..." : userDisplayText) +
                    ", hasRaw=true, contentBlocks=" + contentArr.size());
        } catch (Exception e) {
            LOG.warn("Failed to build user message raw: " + e.getMessage());
        }

        return userMessage;
    }

    /**
     * 判断是否为图片附件
     * 英文：Check if attachment is an image
     * 解释：看看这个附件是不是图片
     */
    private boolean isImageAttachment(Attachment att) {
        if (att == null) return false;
        String mt = (att.mediaType != null) ? att.mediaType : "";
        return mt.startsWith("image/") && att.data != null;
    }

    /**
     * 创建图片块
     * 英文：Create image block
     * 解释：把图片转成AI能理解的格式
     */
    private JsonObject createImageBlock(Attachment att) {
        JsonObject imageBlock = new JsonObject();
        imageBlock.addProperty("type", "image");

        JsonObject source = new JsonObject();
        source.addProperty("type", "base64");
        source.addProperty("media_type", att.mediaType);
        source.addProperty("data", att.data);
        imageBlock.add("source", source);

        return imageBlock;
    }

    /**
     * 创建文本块
     * 英文：Create text block
     * 解释：把文字转成AI能理解的格式
     */
    private JsonObject createTextBlock(String text) {
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);
        return textBlock;
    }

    /**
     * 生成附件摘要
     * 英文：Generate attachment summary
     * 解释：用户只发了图没写字，就显示"已上传X张图片"
     */
    private String generateAttachmentSummary(List<Attachment> attachments) {
        int imageCount = 0;
        List<String> names = new ArrayList<>();

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

        return "已上传附件: " + nameSummary;
    }

    /**
     * 更新会话状态（发送消息时）
     * 英文：Update session state when sending message
     * 解释：记录消息、更新摘要、设置状态
     */
    private void updateSessionStateForSend(Message userMessage, String normalizedInput) {
        // 添加消息到历史
        state.addMessage(userMessage);
        notifyMessageUpdate();

        // 更新摘要（第一条消息）
        if (state.getSummary() == null) {
            String baseSummary = (userMessage.content != null && !userMessage.content.isEmpty())
                ? userMessage.content
                : normalizedInput;
            String newSummary = baseSummary.length() > 45 ? baseSummary.substring(0, 45) + "..." : baseSummary;
            state.setSummary(newSummary);
            callbackHandler.notifySummaryReceived(newSummary);
        }

        // 更新状态
        state.updateLastModifiedTime();
        state.setError(null);
        state.setBusy(true);
        state.setLoading(true);
        com.github.claudecodegui.notifications.ClaudeNotifier.setWaiting(project);
        updateState();
    }

    /**
     * 【FIX】发送消息到AI提供商
     * 英文：Send message to AI provider
     * 解释：根据选择的AI（Claude或Codex），发送消息
     * @param channelId 通道ID
     * @param input 用户输入
     * @param attachments 附件列表
     * @param openedFilesJson 已打开文件信息
     * @param externalAgentPrompt 外部传入的智能体提示词（如为空则使用全局设置）
     */
    private CompletableFuture<Void> sendMessageToProvider(
        String channelId,
        String input,
        List<Attachment> attachments,
        JsonObject openedFilesJson,
        String externalAgentPrompt
    ) {
        // 【FIX】优先使用外部传入的智能体提示词，否则回退到全局设置
        // Use external agent prompt if provided, otherwise fall back to global setting
        String agentPrompt = externalAgentPrompt;
        if (agentPrompt == null) {
            // 回退到全局设置（向后兼容）
            agentPrompt = getAgentPrompt();
            LOG.info("[Agent] Using agent from global setting (fallback)");
        } else {
            LOG.info("[Agent] Using agent from message (per-tab selection)");
        }

        // 根据 provider 选择 SDK
        // Choose SDK based on provider
        // 解释：看看是用Claude还是Codex
        String currentProvider = state.getProvider();

        if ("codex".equals(currentProvider)) {
            return sendToCodex(channelId, input, attachments, openedFilesJson, agentPrompt);
        } else {
            return sendToClaude(channelId, input, attachments, openedFilesJson, agentPrompt);
        }
    }

    /**
     * 发送消息到Codex
     * 英文：Send message to Codex
     * 解释：用Codex AI发送消息
     */
    private CompletableFuture<Void> sendToCodex(
        String channelId,
        String input,
        List<Attachment> attachments,
        JsonObject openedFilesJson,
        String agentPrompt
    ) {
        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);

        String contextAppend = buildCodexContextAppend(openedFilesJson);
        String finalInput = (input != null ? input : "") + contextAppend;

        return codexSDKBridge.sendMessage(
            channelId,
            finalInput,
            state.getSessionId(),
            state.getCwd(),
            attachments,
            state.getPermissionMode(),
            state.getModel(),
            agentPrompt,
            state.getReasoningEffort(),
            handler
        ).thenApply(result -> null);
    }

    private String buildCodexContextAppend(JsonObject openedFilesJson) {
        if (openedFilesJson == null || openedFilesJson.isJsonNull()) {
            return "";
        }

        JsonObject selection = null;
        if (openedFilesJson.has("selection") && openedFilesJson.get("selection").isJsonObject()) {
            selection = openedFilesJson.getAsJsonObject("selection");
        }
        if (selection == null) {
            return "";
        }

        String selectedText = null;
        if (selection.has("selectedText") && !selection.get("selectedText").isJsonNull()) {
            selectedText = selection.get("selectedText").getAsString();
        }
        if (selectedText == null || selectedText.trim().isEmpty()) {
            return "";
        }

        String activeFile = null;
        if (openedFilesJson.has("active") && !openedFilesJson.get("active").isJsonNull()) {
            activeFile = openedFilesJson.get("active").getAsString();
        }

        Integer startLine = null;
        Integer endLine = null;
        if (selection.has("startLine") && selection.get("startLine").isJsonPrimitive()) {
            startLine = selection.get("startLine").getAsInt();
        }
        if (selection.has("endLine") && selection.get("endLine").isJsonPrimitive()) {
            endLine = selection.get("endLine").getAsInt();
        }

        StringBuilder sb = new StringBuilder();
        sb.append("\n\n## IDE Context\n\n");
        if (activeFile != null && !activeFile.trim().isEmpty()) {
            sb.append("Active file: `").append(activeFile);
            if (startLine != null && endLine != null) {
                if (startLine.equals(endLine)) {
                    sb.append("#L").append(startLine);
                } else {
                    sb.append("#L").append(startLine).append("-").append(endLine);
                }
            }
            sb.append("`\n\n");
        }
        sb.append("Selected code:\n```\n");
        sb.append(selectedText);
        sb.append("\n```\n");
        sb.append("The selected code above is the primary subject of the user's question.\n");
        return sb.toString();
    }

    /**
     * 发送消息到Claude
     * 英文：Send message to Claude
     * 解释：用Claude AI发送消息
     */
    private CompletableFuture<Void> sendToClaude(
        String channelId,
        String input,
        List<Attachment> attachments,
        JsonObject openedFilesJson,
        String agentPrompt
    ) {
        ClaudeMessageHandler handler = new ClaudeMessageHandler(
            project,
            state,
            callbackHandler,
            messageParser,
            messageMerger,
            gson
        );

        // 🔧 读取流式传输配置
        Boolean streaming = null;
        try {
            String projectPath = project.getBasePath();
            if (projectPath != null) {
                CodemossSettingsService settingsService = new CodemossSettingsService();
                streaming = settingsService.getStreamingEnabled(projectPath);
                LOG.info("[Streaming] Read streaming config: " + streaming);
            }
        } catch (Exception e) {
            LOG.warn("[Streaming] Failed to read streaming config: " + e.getMessage());
        }

        return claudeSDKBridge.sendMessage(
            channelId,
            input,
            state.getSessionId(),
            state.getCwd(),
            attachments,
            state.getPermissionMode(),
            state.getModel(),
            openedFilesJson,
            agentPrompt,
            streaming,
            handler
        ).thenApply(result -> null);
    }

    /**
     * 获取智能体提示词
     * 英文：Get agent prompt
     * 解释：读取用户选的智能体配置
     */
    private String getAgentPrompt() {
        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            String selectedAgentId = settingsService.getSelectedAgentId();
            LOG.info("[Agent] Checking selected agent ID: " + (selectedAgentId != null ? selectedAgentId : "null"));

            if (selectedAgentId != null && !selectedAgentId.isEmpty()) {
                JsonObject agent = settingsService.getAgent(selectedAgentId);
                if (agent != null && agent.has("prompt") && !agent.get("prompt").isJsonNull()) {
                    String agentPrompt = agent.get("prompt").getAsString();
                    String agentName = agent.has("name") ? agent.get("name").getAsString() : "Unknown";
                    LOG.info("[Agent] ✓ Found agent: " + agentName);
                    LOG.info("[Agent] ✓ Prompt length: " + agentPrompt.length() + " chars");
                    LOG.info("[Agent] ✓ Prompt preview: " + (agentPrompt.length() > 100 ? agentPrompt.substring(0, 100) + "..." : agentPrompt));
                    return agentPrompt;
                } else {
                    LOG.info("[Agent] ✗ Agent found but no prompt configured");
                }
            } else {
                LOG.info("[Agent] ✗ No agent selected");
            }
        } catch (Exception e) {
            LOG.warn("[Agent] ✗ Failed to get agent prompt: " + e.getMessage());
        }
        return null;
    }

    /**
     * 中断当前执行
     */
    public CompletableFuture<Void> interrupt() {
        if (state.getChannelId() == null) {
            return CompletableFuture.completedFuture(null);
        }

        return CompletableFuture.runAsync(() -> {
            try {
                String currentProvider = state.getProvider();
                String currentChannelId = state.getChannelId();
                if ("codex".equals(currentProvider)) {
                    codexSDKBridge.interruptChannel(currentChannelId);
                } else {
                    claudeSDKBridge.interruptChannel(currentChannelId);
                }
                state.setError(null);  // 清除之前的错误状态
                state.setBusy(false);
                updateState();
            } catch (Exception e) {
                state.setError(e.getMessage());
                updateState();
            }
        });
    }

    /**
     * 重启 Claude Agent
     */
    public CompletableFuture<Void> restart() {
        return interrupt().thenCompose(v -> {
            state.setChannelId(null);
            state.setBusy(false);
            updateState();
            return launchClaude().thenApply(chId -> null);
        });
    }

    /**
     * 加载服务器端的历史消息
     */
    public CompletableFuture<Void> loadFromServer() {
        if (state.getSessionId() == null) {
            return CompletableFuture.completedFuture(null);
        }

        state.setLoading(true);
        updateState();

        return CompletableFuture.runAsync(() -> {
            try {
                String currentSessionId = state.getSessionId();
                String currentCwd = state.getCwd();
                String currentProvider = state.getProvider();

                LOG.info("Loading session from server: sessionId=" + currentSessionId + ", cwd=" + currentCwd);
                List<JsonObject> serverMessages;
                if ("codex".equals(currentProvider)) {
                    serverMessages = codexSDKBridge.getSessionMessages(currentSessionId, currentCwd);
                } else {
                    serverMessages = claudeSDKBridge.getSessionMessages(currentSessionId, currentCwd);
                }
                LOG.debug("Received " + serverMessages.size() + " messages from server");

                state.clearMessages();
                for (JsonObject msg : serverMessages) {
                    Message message = messageParser.parseServerMessage(msg);
                    if (message != null) {
                        state.addMessage(message);
                        // System.out.println("[ClaudeSession] Parsed message: type=" + message.type + ", content length=" + message.content.length());
                    } else {
                        // System.out.println("[ClaudeSession] Failed to parse message: " + msg);
                    }
                }

                LOG.debug("Total messages in session: " + state.getMessages().size());
                notifyMessageUpdate();
            } catch (Exception e) {
                LOG.error("Error loading session: " + e.getMessage(), e);
                state.setError(e.getMessage());
            } finally {
                state.setLoading(false);
                updateState();
            }
        });
    }

    /**
     * 通知消息更新
     */
    private void notifyMessageUpdate() {
        callbackHandler.notifyMessageUpdate(getMessages());
    }

    /**
     * 通知状态更新
     */
    private void updateState() {
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
        
        // Show error in status bar
        String error = state.getError();
        if (error != null && !error.isEmpty()) {
            com.github.claudecodegui.notifications.ClaudeNotifier.showError(project, error);
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
     * 将前端权限模式字符串映射到 PermissionManager 枚举值
     */
    public void setPermissionMode(String mode) {
        state.setPermissionMode(mode);

        // 同步更新 PermissionManager 的权限模式
        // 前端模式映射:
        // - "default" -> DEFAULT (每次询问)
        // - "acceptEdits" -> ACCEPT_EDITS (代理模式,自动接受文件编辑等操作)
        // - "bypassPermissions" -> ALLOW_ALL (自动模式,绕过所有权限检查)
        // - "plan" -> DENY_ALL (规划模式,暂不支持)
        PermissionManager.PermissionMode pmMode;
        if ("bypassPermissions".equals(mode)) {
            pmMode = PermissionManager.PermissionMode.ALLOW_ALL;
            LOG.info("Permission mode set to ALLOW_ALL for mode: " + mode);
        } else if ("acceptEdits".equals(mode)) {
            pmMode = PermissionManager.PermissionMode.ACCEPT_EDITS;
            LOG.info("Permission mode set to ACCEPT_EDITS for mode: " + mode);
        } else if ("plan".equals(mode)) {
            pmMode = PermissionManager.PermissionMode.DENY_ALL;
            LOG.info("Permission mode set to DENY_ALL for mode: " + mode);
        } else {
            // "default" 或其他未知模式
            pmMode = PermissionManager.PermissionMode.DEFAULT;
            LOG.info("Permission mode set to DEFAULT for mode: " + mode);
        }

        permissionManager.setPermissionMode(pmMode);
    }

    /**
     * 获取权限模式
     */
    public String getPermissionMode() {
        return state.getPermissionMode();
    }

    /**
     * 设置模型
     */
    public void setModel(String model) {
        state.setModel(model);
        LOG.info("Model updated to: " + model);
    }

    /**
     * 获取模型
     */
    public String getModel() {
        return state.getModel();
    }

    /**
     * 设置AI提供商
     */
    public void setProvider(String provider) {
        state.setProvider(provider);
        LOG.info("Provider updated to: " + provider);
    }

    /**
     * 获取AI提供商
     */
    public String getProvider() {
        return state.getProvider();
    }

    /**
     * 设置推理深度 (Reasoning Effort)
     */
    public void setReasoningEffort(String effort) {
        state.setReasoningEffort(effort);
        LOG.info("Reasoning effort updated to: " + effort);
    }

    /**
     * 获取推理深度 (Reasoning Effort)
     */
    public String getReasoningEffort() {
        return state.getReasoningEffort();
    }

    /**
     * 获取斜杠命令列表
     */
    public List<String> getSlashCommands() {
        return state.getSlashCommands();
    }



    /**
     * 创建权限请求（供SDK调用）
     */
    public PermissionRequest createPermissionRequest(String toolName, Map<String, Object> inputs, JsonObject suggestions, Project project) {
        return permissionManager.createRequest(state.getChannelId(), toolName, inputs, suggestions, project);
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
