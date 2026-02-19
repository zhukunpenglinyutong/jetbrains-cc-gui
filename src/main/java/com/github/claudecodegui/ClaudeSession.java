package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.notifications.ClaudeNotifier;
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
import com.github.claudecodegui.terminal.TerminalMonitorService;
import org.jetbrains.annotations.Nullable;

import java.util.ArrayList;
import com.github.claudecodegui.service.RunConfigMonitorService;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Session management for Claude conversations.
 * Maintains state and message history for a single chat session.
 */
public class ClaudeSession {

    private static final Logger LOG = Logger.getInstance(ClaudeSession.class);

    /** Maximum file size for Codex context injection (100KB) */
    private static final int MAX_FILE_SIZE_BYTES = 100 * 1024;

    private final Gson gson = new Gson();
    private final Project project;

    // Session state manager
    private final com.github.claudecodegui.session.SessionState state;

    // Message processors
    private final com.github.claudecodegui.session.MessageParser messageParser;
    private final com.github.claudecodegui.session.MessageMerger messageMerger;

    // Context collector
    private final com.github.claudecodegui.session.EditorContextCollector contextCollector;

    // Callback handler
    private final com.github.claudecodegui.session.CallbackHandler callbackHandler;

    // SDK bridges
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;

    // Permission manager
    private final PermissionManager permissionManager = new PermissionManager();

    /** Represents a single message in the conversation. */
    public static class Message {
        public enum Type {
            USER, ASSISTANT, SYSTEM, ERROR
        }

        public Type type;
        public String content;
        public long timestamp;
        public JsonObject raw; // Raw message data from SDK

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

    /** Callback interface for session events. */
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

        // Streaming callback methods (with default implementations for backward compatibility)
        default void onStreamStart() {}
        default void onStreamEnd() {}
        default void onContentDelta(String delta) {}
        default void onThinkingDelta(String delta) {}
    }

    public ClaudeSession(Project project, ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.project = project;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;

        // Initialize managers
        this.state = new com.github.claudecodegui.session.SessionState();
        this.messageParser = new com.github.claudecodegui.session.MessageParser();
        this.messageMerger = new com.github.claudecodegui.session.MessageMerger();
        this.contextCollector = new com.github.claudecodegui.session.EditorContextCollector(project);
        this.callbackHandler = new com.github.claudecodegui.session.CallbackHandler();

        // Set up permission manager callback
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

    // Getters - delegated to SessionState
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

    /** Set session ID and working directory (used for session restoration). */
    public void setSessionInfo(String sessionId, String cwd) {
        state.setSessionId(sessionId);
        if (cwd != null) {
            setCwd(cwd);
        } else {
            state.setCwd(null);
        }
    }

    /** Get the current working directory. */
    public String getCwd() {
        return state.getCwd();
    }

    /** Set the working directory. */
    public void setCwd(String cwd) {
        state.setCwd(cwd);
        LOG.info("Working directory updated to: " + cwd);
    }

    /**
     * Launch Claude agent.
     * Reuses existing channelId if available, otherwise creates a new one.
     */
    public CompletableFuture<String> launchClaude() {
        if (state.getChannelId() != null) {
            return CompletableFuture.completedFuture(state.getChannelId());
        }

        state.setError(null);
        state.setChannelId(UUID.randomUUID().toString());

        return CompletableFuture.supplyAsync(() -> {
            try {
                // Validate and clean invalid sessionId (e.g., path instead of UUID)
                String currentSessionId = state.getSessionId();
                if (currentSessionId != null && (currentSessionId.contains("/") || currentSessionId.contains("\\"))) {
                    LOG.warn("sessionId looks like a path, resetting: " + currentSessionId);
                    state.setSessionId(null);
                    currentSessionId = null;
                }

                // Select SDK based on provider
                JsonObject result;
                String currentProvider = state.getProvider();
                String currentChannelId = state.getChannelId();
                String currentCwd = state.getCwd();
                if ("codex".equals(currentProvider)) {
                    result = codexSDKBridge.launchChannel(currentChannelId, currentSessionId, currentCwd);
                } else {
                    result = claudeSDKBridge.launchChannel(currentChannelId, currentSessionId, currentCwd);
                }

                // Check if sessionId exists and is not null
                if (result.has("sessionId") && !result.get("sessionId").isJsonNull()) {
                    String newSessionId = result.get("sessionId").getAsString();
                    // Validate sessionId format (should be UUID format)
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
                  String timeoutMsg = "Channel launch timed out (" +
                      com.github.claudecodegui.config.TimeoutConfig.QUICK_OPERATION_TIMEOUT + "s), please retry";
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
     * Send a message using global agent settings.
     * @deprecated Use {@link #send(String, String)} with explicit agent prompt instead.
     */
    public CompletableFuture<Void> send(String input) {
        return send(input, (List<Attachment>) null, null);
    }

    /**
     * Send a message with a specific agent prompt.
     * Used for per-tab independent agent selection.
     */
    public CompletableFuture<Void> send(String input, String agentPrompt) {
        return send(input, null, agentPrompt, null);
    }

    /**
     * Send a message with a specific agent prompt and file tags.
     * Used for Codex context injection.
     */
    public CompletableFuture<Void> send(String input, String agentPrompt, List<String> fileTagPaths) {
        return send(input, null, agentPrompt, fileTagPaths);
    }

    /**
     * Send a message with attachments using global agent settings.
     * @deprecated Use {@link #send(String, List, String)} with explicit agent prompt instead.
     */
    public CompletableFuture<Void> send(String input, List<Attachment> attachments) {
        return send(input, attachments, null, null);
    }

    /**
     * Send a message with attachments and a specific agent prompt.
     * Used for per-tab independent agent selection.
     * @param input User input text
     * @param attachments List of attachments (nullable)
     * @param agentPrompt Agent prompt (falls back to global setting if null)
     */
    public CompletableFuture<Void> send(String input, List<Attachment> attachments, String agentPrompt) {
        return send(input, attachments, agentPrompt, null);
    }

    /**
     * Send a message with attachments, agent prompt, and file tags.
     * Used for Codex context injection.
     * @param input User input text
     * @param attachments List of attachments (nullable)
     * @param agentPrompt Agent prompt (falls back to global setting if null)
     * @param fileTagPaths File tag paths for Codex context injection
     */
    public CompletableFuture<Void> send(String input, List<Attachment> attachments, String agentPrompt, List<String> fileTagPaths) {
        // Prepare user message
        String normalizedInput = (input != null) ? input.trim() : "";
        Message userMessage = buildUserMessage(normalizedInput, attachments);

        // Update session state
        updateSessionStateForSend(userMessage, normalizedInput);

        // Save agentPrompt and fileTagPaths for later use
        final String finalAgentPrompt = agentPrompt;
        final List<String> finalFileTagPaths = fileTagPaths;

        // Launch Claude and send message
        return launchClaude().thenCompose(chId -> {
            // Configure PSI semantic context collection
            contextCollector.setPsiContextEnabled(state.isPsiContextEnabled());

            // Read "auto open file" setting to determine editor context collection
            boolean autoOpenFileEnabled = true;
            try {
                String projectPath = project.getBasePath();
                if (projectPath != null) {
                    CodemossSettingsService settingsService = new CodemossSettingsService();
                    autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);
                    LOG.info("[EditorContext] Auto open file enabled: " + autoOpenFileEnabled);
                }
            } catch (Exception e) {
                LOG.warn("[EditorContext] Failed to read autoOpenFileEnabled setting: " + e.getMessage());
            }
            contextCollector.setAutoOpenFileEnabled(autoOpenFileEnabled);

            return contextCollector.collectContext().thenCompose(openedFilesJson ->
                sendMessageToProvider(chId, userMessage.content, attachments, openedFilesJson, finalAgentPrompt, finalFileTagPaths)
            );
        }).exceptionally(ex -> {
            state.setError(ex.getMessage());
            state.setBusy(false);
            state.setLoading(false);
            updateState();
            return null;
        });
    }

    /** Build a user message from input text and attachments. */
    private Message buildUserMessage(String normalizedInput, List<Attachment> attachments) {
        Message userMessage = new Message(Message.Type.USER, normalizedInput);

        try {
            JsonArray contentArr = new JsonArray();
            String userDisplayText = normalizedInput;

            // Handle attachments
            if (attachments != null && !attachments.isEmpty()) {
                // Add image blocks
                for (Attachment att : attachments) {
                    if (isImageAttachment(att)) {
                        contentArr.add(createImageBlock(att));
                    }
                }

                // Provide placeholder text when no text input
                if (userDisplayText.isEmpty()) {
                    userDisplayText = generateAttachmentSummary(attachments);
                }
            }

            // Handle terminal and service references
            userDisplayText = processReferences(normalizedInput, "terminal", "Terminal Output", this::resolveTerminalContent);
            userDisplayText = processReferences(userDisplayText, "service", "Service Output", this::resolveServiceContent);

            // Always add text block
            contentArr.add(createTextBlock(userDisplayText));

            // Assemble complete message
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
     * Process @protocol://name reference patterns in the input text.
     * @param input Input text
     * @param protocol Protocol name (e.g., "terminal", "service")
     * @param blockTitle Output block title (e.g., "Terminal Output")
     * @param contentResolver Content resolution function
     * @return Processed text with references replaced
     */
    private String processReferences(String input, String protocol, String blockTitle,
                                      Function<String, String> contentResolver) {
        Pattern pattern = Pattern.compile("@" + protocol + "://([a-zA-Z0-9_]+)");
        Matcher matcher = pattern.matcher(input);
        StringBuffer result = new StringBuffer();
        int matchCount = 0;

        while (matcher.find()) {
            matchCount++;
            String safeName = matcher.group(1);
            LOG.debug("[" + protocol + "] Found mention in message: @" + protocol + "://" + safeName);
            String content = contentResolver.apply(safeName);

            if (content != null && !content.isEmpty()) {
                String block = "\n\n" + blockTitle + " (" + safeName + "):\n```\n" + content + "\n```";
                matcher.appendReplacement(result, Matcher.quoteReplacement(block));
                LOG.debug("[" + protocol + "] Successfully replaced reference for: " + safeName);
            } else {
                matcher.appendReplacement(result, "");
                LOG.debug("[" + protocol + "] Content was empty or null for: " + safeName);
            }
        }
        matcher.appendTail(result);

        if (matchCount == 0 && input.contains("@" + protocol + "://")) {
            LOG.warn("[" + protocol + "] Message contains '@" + protocol + "://' but regex did not match.");
        }

        return result.toString();
    }

    private String resolveTerminalContent(String safeName) {
        return ReadAction.compute(() -> {
            try {
                List<Object> widgets = TerminalMonitorService.getWidgets(project);
                LOG.debug("[Terminal] Resolving: " + safeName + ". Available widgets: " + widgets.size());

                Map<String, Integer> nameCounts = new HashMap<>();
                for (Object widget : widgets) {
                    String baseTitle = TerminalMonitorService.getWidgetTitle(widget);
                    int count = nameCounts.getOrDefault(baseTitle, 0) + 1;
                    nameCounts.put(baseTitle, count);

                    String titleText = baseTitle;
                    if (count > 1) {
                        titleText = baseTitle + " (" + count + ")";
                    }

                    String wSafeName = titleText.replace(" ", "_").replaceAll("[^a-zA-Z0-9_]", "");
                    LOG.debug("[Terminal] - Candidate: " + titleText + " (Safe: " + wSafeName + ")");

                    if (wSafeName.equals(safeName)) {
                        String content = TerminalMonitorService.getWidgetContent(widget);
                        LOG.debug("[Terminal] Match found! Content length: " + (content != null ? content.length() : "null"));
                        return content;
                    }
                }
                LOG.debug("[Terminal] No matching terminal found for: " + safeName);
            } catch (Exception e) {
                LOG.error("[Terminal] Error resolving terminal content: " + e.getMessage(), e);
            }
            return "";
        });
    }

    private String resolveServiceContent(String safeName) {
        return ReadAction.compute(() -> {
            try {
                List<RunConfigMonitorService.RunConfigInfo> configs = RunConfigMonitorService.getRunConfigurations(project);
                LOG.debug("[Service] Resolving: " + safeName + ". Available configs: " + configs.size());

                for (RunConfigMonitorService.RunConfigInfo config : configs) {
                    String displayName = config.getDisplayName();
                    String wSafeName = displayName.replace(" ", "_").replaceAll("[^a-zA-Z0-9_]", "");
                    LOG.debug("[Service] - Candidate: " + displayName + " (Safe: " + wSafeName + ")");

                    if (wSafeName.equals(safeName)) {
                        String content = config.getContent();
                        LOG.debug("[Service] Match found! Content length: " + (content != null ? content.length() : "null"));
                        return content;
                    }
                }
                LOG.debug("[Service] No matching service found for: " + safeName);
            } catch (Exception e) {
                LOG.error("[Service] Error resolving service content: " + e.getMessage(), e);
            }
            return "";
        });
    }

    /** Check if the attachment is an image. */
    private boolean isImageAttachment(Attachment att) {
        if (att == null) return false;
        String mt = (att.mediaType != null) ? att.mediaType : "";
        return mt.startsWith("image/") && att.data != null;
    }

    /** Create an image content block for the API request. */
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

    /** Create a text content block for the API request. */
    private JsonObject createTextBlock(String text) {
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);
        return textBlock;
    }

    /** Generate a summary text for image-only messages. */
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

        // Use standardized English bracket format for frontend localization
        // These patterns are handled by localizationUtils.ts
        if (names.isEmpty()) {
            if (imageCount > 0) {
                return "[Uploaded " + imageCount + " image(s)]";
            }
            return "[Uploaded attachment(s)]";
        }

        if (names.size() > 3) {
            return "[Uploaded Attachments: " + String.join(", ", names.subList(0, 3)) + ", ...]";
        }
        return "[Uploaded Attachments: " + String.join(", ", names) + "]";
    }

    /** Update session state when sending a message. */
    private void updateSessionStateForSend(Message userMessage, String normalizedInput) {
        // Add message to history
        state.addMessage(userMessage);
        notifyMessageUpdate();

        // Update summary (first message only)
        if (state.getSummary() == null) {
            String baseSummary = (userMessage.content != null && !userMessage.content.isEmpty())
                ? userMessage.content
                : normalizedInput;
            String newSummary = baseSummary.length() > 45 ? baseSummary.substring(0, 45) + "..." : baseSummary;
            state.setSummary(newSummary);
            callbackHandler.notifySummaryReceived(newSummary);
        }

        // Update state
        state.updateLastModifiedTime();
        state.setError(null);
        state.setBusy(true);
        state.setLoading(true);
        com.github.claudecodegui.notifications.ClaudeNotifier.setWaiting(project);
        updateState();
    }

    /**
     * Send message to the AI provider.
     * @param channelId Channel ID
     * @param input User input
     * @param attachments Attachment list
     * @param openedFilesJson Opened files context from IDE
     * @param externalAgentPrompt External agent prompt (falls back to global setting if null)
     * @param fileTagPaths File tag paths for Codex context injection
     */
    private CompletableFuture<Void> sendMessageToProvider(
        String channelId,
        String input,
        List<Attachment> attachments,
        JsonObject openedFilesJson,
        String externalAgentPrompt,
        List<String> fileTagPaths
    ) {
        // Prefer external agent prompt; fall back to global setting if not provided
        String agentPrompt = externalAgentPrompt;
        if (agentPrompt == null) {
            // Fall back to global setting (backward compatibility)
            agentPrompt = getAgentPrompt();
            LOG.info("[Agent] Using agent from global setting (fallback)");
        } else {
            LOG.info("[Agent] Using agent from message (per-tab selection)");
        }

        // Select SDK based on provider
        String currentProvider = state.getProvider();

        if ("codex".equals(currentProvider)) {
            return sendToCodex(channelId, input, attachments, openedFilesJson, agentPrompt, fileTagPaths);
        } else {
            return sendToClaude(channelId, input, attachments, openedFilesJson, agentPrompt);
        }
    }

    /**
     * Send message via Codex SDK.
     * @param fileTagPaths File tag paths for context injection
     */
    private CompletableFuture<Void> sendToCodex(
        String channelId,
        String input,
        List<Attachment> attachments,
        JsonObject openedFilesJson,
        String agentPrompt,
        List<String> fileTagPaths
    ) {
        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);

        String contextAppend = buildCodexContextAppend(openedFilesJson, fileTagPaths);
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

    /**
     * Build context content to append to Codex messages.
     * Handles IDE open files, selected code, and user file tags for context injection.
     * @param openedFilesJson IDE open file info (includes active file and selection)
     * @param fileTagPaths User-added file tag paths from the input box
     */
    private String buildCodexContextAppend(JsonObject openedFilesJson, List<String> fileTagPaths) {
        StringBuilder sb = new StringBuilder();
        boolean hasContent = false;

        // Separate terminal paths from file paths for distinct handling
        List<String> terminalPaths = new java.util.ArrayList<>();
        List<String> regularFilePaths = new java.util.ArrayList<>();

        if (fileTagPaths != null && !fileTagPaths.isEmpty()) {
            for (String path : fileTagPaths) {
                if (path != null && path.startsWith("terminal://")) {
                    terminalPaths.add(path);
                } else {
                    regularFilePaths.add(path);
                }
            }
        }

        // Process terminal context - separate section
        if (!terminalPaths.isEmpty()) {
            sb.append("\n\n## Active Terminal Session\n\n");
            sb.append("The user is working in the following terminal context:\n\n");
            for (String terminalPath : terminalPaths) {
                // Extract session name from terminal://session-name
                String sessionName = terminalPath.substring("terminal://".length());
                sb.append("- **Terminal**: `").append(sessionName).append("`\n");
            }
            sb.append("\nCommands should be executed in this terminal context.\n\n");
            hasContent = true;
        }

        // Process regular file tags added by user via @
        if (!regularFilePaths.isEmpty()) {
            sb.append("\n\n## Referenced Files\n\n");
            sb.append("The following files were referenced by the user:\n\n");

            for (String filePath : regularFilePaths) {
                String fileContent = readFileContent(filePath);
                if (fileContent != null) {
                    String extension = getFileExtension(filePath);
                    sb.append("### `").append(filePath).append("`\n\n");
                    sb.append("```").append(extension).append("\n");
                    sb.append(fileContent);
                    if (!fileContent.endsWith("\n")) {
                        sb.append("\n");
                    }
                    sb.append("```\n\n");
                    hasContent = true;
                }
            }
        }

        // Process IDE active file - inject full file content for Codex
        if (openedFilesJson != null && !openedFilesJson.isJsonNull()) {
            String activeFile = null;
            if (openedFilesJson.has("active") && !openedFilesJson.get("active").isJsonNull()) {
                activeFile = openedFilesJson.get("active").getAsString();
            }

            // Check for selected code
            JsonObject selection = null;
            String selectedText = null;
            Integer startLine = null;
            Integer endLine = null;

            if (openedFilesJson.has("selection") && openedFilesJson.get("selection").isJsonObject()) {
                selection = openedFilesJson.getAsJsonObject("selection");
                if (selection.has("selectedText") && !selection.get("selectedText").isJsonNull()) {
                    selectedText = selection.get("selectedText").getAsString();
                }
                if (selection.has("startLine") && selection.get("startLine").isJsonPrimitive()) {
                    startLine = selection.get("startLine").getAsInt();
                }
                if (selection.has("endLine") && selection.get("endLine").isJsonPrimitive()) {
                    endLine = selection.get("endLine").getAsInt();
                }
            }

            // Display selected code if present
            if (selectedText != null && !selectedText.trim().isEmpty()) {
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
                hasContent = true;
            }
            // If no selection but has active file, read and inject full file content
            else if (activeFile != null && !activeFile.trim().isEmpty()) {
                String fileContent = readFileContent(activeFile);
                if (fileContent != null) {
                    String extension = getFileExtension(activeFile);
                    sb.append("\n\n## User's Current IDE Context\n\n");
                    sb.append("The user is viewing this file in their IDE. This is the PRIMARY SUBJECT of the user's question.\n\n");
                    sb.append("### `").append(activeFile).append("`\n\n");
                    sb.append("```").append(extension).append("\n");
                    sb.append(fileContent);
                    if (!fileContent.endsWith("\n")) {
                        sb.append("\n");
                    }
                    sb.append("```\n\n");
                    hasContent = true;
                    LOG.info("[Codex Context] Injected active file content: " + activeFile);
                }
            }
        }

        return hasContent ? sb.toString() : "";
    }

    /**
     * Read file content with size limit.
     * @param filePath File path
     * @return File content, or null if reading fails
     */
    private String readFileContent(String filePath) {
        try {
            java.io.File file = new java.io.File(filePath);
            if (!file.exists() || !file.isFile() || !file.canRead()) {
                LOG.warn("[Codex Context] File not accessible: " + filePath);
                return null;
            }

            long fileSize = file.length();
            // Enforce file size limit (max 100KB)
            if (fileSize > MAX_FILE_SIZE_BYTES) {
                LOG.info("[Codex Context] File too large, reading first 100KB: " + filePath + " (" + fileSize + " bytes)");
                try (java.io.FileInputStream fis = new java.io.FileInputStream(file)) {
                    byte[] buffer = new byte[MAX_FILE_SIZE_BYTES];
                    int bytesRead = fis.read(buffer);
                    if (bytesRead > 0) {
                        return new String(buffer, 0, bytesRead, java.nio.charset.StandardCharsets.UTF_8)
                            + "\n\n... (file truncated, showing first 100KB of " + (fileSize / 1024) + "KB)";
                    }
                }
                return null;
            } else {
                String content = java.nio.file.Files.readString(file.toPath(), java.nio.charset.StandardCharsets.UTF_8);
                LOG.info("[Codex Context] Read file content: " + filePath + " (" + fileSize + " bytes)");
                return content;
            }
        } catch (Exception e) {
            LOG.warn("[Codex Context] Failed to read file: " + filePath + ", error: " + e.getMessage());
            return null;
        }
    }

    /** Get file extension for code block syntax highlighting. */
    private String getFileExtension(String filePath) {
        if (filePath == null) return "";
        int lastDot = filePath.lastIndexOf('.');
        if (lastDot > 0 && lastDot < filePath.length() - 1) {
            return filePath.substring(lastDot + 1).toLowerCase();
        }
        return "";
    }

    /** Send message via Claude SDK. */
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

        // Read streaming configuration
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
        ).thenApply(result -> null)
        .thenCompose(v -> {
            // Add a small delay to ensure JSONL file is written and flushed
            // Non-streaming responses return very fast, and filesystem I/O may not be complete yet
            return CompletableFuture.runAsync(() -> {
                try {
                    Thread.sleep(100); // 100ms delay to allow file system flush
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                updateUserMessageUuids();
            });
        });
    }

    /**
     * Update user message UUIDs from session history
     * This is needed because SDK streaming does not include UUID,
     * but persisted messages in JSONL files do have UUID.
     */
    private void updateUserMessageUuids() {
        String sessionId = state.getSessionId();
        String cwd = state.getCwd();

        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }

        // Retry logic to handle filesystem I/O delay
        int maxRetries = 3;
        int retryDelayMs = 50;

        for (int attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                List<JsonObject> historyMessages = claudeSDKBridge.getSessionMessages(sessionId, cwd);
                if (historyMessages == null || historyMessages.isEmpty()) {
                    if (attempt < maxRetries) {
                        Thread.sleep(retryDelayMs);
                        continue;
                    }
                    return;
                }

                List<Message> localMessages = state.getMessages();
                boolean updated = false;

                // Find user messages in history that have UUID
                for (JsonObject historyMsg : historyMessages) {
                    if (!historyMsg.has("type") || !"user".equals(historyMsg.get("type").getAsString())) {
                        continue;
                    }
                    if (!historyMsg.has("uuid") || historyMsg.get("uuid").isJsonNull()) {
                        continue;
                    }

                    String uuid = historyMsg.get("uuid").getAsString();

                    // Extract content from history message for matching
                    String historyContent = extractMessageContentForMatching(historyMsg);
                    if (historyContent == null || historyContent.isEmpty()) {
                        continue;
                    }

                    // Find matching local user message and update its UUID
                    for (Message localMsg : localMessages) {
                        if (localMsg.type != Message.Type.USER || localMsg.raw == null) {
                            continue;
                        }
                        // Skip if already has UUID
                        if (localMsg.raw.has("uuid") && !localMsg.raw.get("uuid").isJsonNull()) {
                            continue;
                        }

                        String localContent = localMsg.content;
                        if (localContent != null && localContent.equals(historyContent)) {
                            localMsg.raw.addProperty("uuid", uuid);
                            updated = true;
                            break;
                        }
                    }
                }

                if (updated) {
                    callbackHandler.notifyMessageUpdate(localMessages);
                    return; // Success, no need to retry
                }

                // If no update but found history messages, likely UUID already present
                if (!historyMessages.isEmpty()) {
                    return;
                }

                // Retry if no history messages found yet
                if (attempt < maxRetries) {
                    Thread.sleep(retryDelayMs);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception e) {
                LOG.warn("[Rewind] Failed to update user message UUIDs (attempt " + attempt + "): " + e.getMessage());
                if (attempt >= maxRetries) {
                    break;
                }
                try {
                    Thread.sleep(retryDelayMs);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
    }

    /**
     * Extract message content for matching
     */
    private String extractMessageContentForMatching(JsonObject msg) {
        if (!msg.has("message") || !msg.get("message").isJsonObject()) {
            return null;
        }
        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content")) {
            return null;
        }

        JsonElement contentElement = message.get("content");
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        if (contentElement.isJsonArray()) {
            JsonArray contentArray = contentElement.getAsJsonArray();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < contentArray.size(); i++) {
                JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    JsonObject block = element.getAsJsonObject();
                    if (block.has("type") && "text".equals(block.get("type").getAsString()) && block.has("text")) {
                        if (sb.length() > 0) sb.append("\n");
                        sb.append(block.get("text").getAsString());
                    }
                }
            }
            return sb.toString();
        }

        return null;
    }

    /** Get the agent prompt from settings. */
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

    /** Interrupt the current execution. */
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
                state.setError(null);  // Clear previous error state
                state.setBusy(false);
                state.setLoading(false);  // Also reset loading state

                // Note: We intentionally don't call notifyStreamEnd() here because:
                // 1. The frontend's interruptSession() already cleans up streaming state directly
                // 2. Calling notifyStreamEnd() would trigger flushStreamMessageUpdates(),
                //    which might restore previous messages via lastMessagesSnapshot, interfering with clearMessages
                // 3. State reset is notified via updateState() -> onStateChange()

                updateState();
            } catch (Exception e) {
                state.setError(e.getMessage());
                state.setLoading(false);  // Also reset loading on error
                updateState();
            }
        });
    }

    /** Restart the Claude agent. */
    public CompletableFuture<Void> restart() {
        return interrupt().thenCompose(v -> {
            state.setChannelId(null);
            state.setBusy(false);
            updateState();
            return launchClaude().thenApply(chId -> null);
        });
    }

    /** Load message history from the server. */
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

                // Extract token usage from the last assistant message for status bar display
                extractAndDisplayTokenUsage(serverMessages);

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
     * Extract token usage from the last assistant message in loaded history
     * and update the status bar.
     */
    private void extractAndDisplayTokenUsage(List<JsonObject> serverMessages) {
        try {
            JsonObject lastUsage = ClaudeMessageHandler.findLastUsageFromRawMessages(serverMessages);
            if (lastUsage == null) return;

            int usedTokens = ClaudeMessageHandler.extractUsedTokens(lastUsage, state.getProvider());
            int maxTokens = SettingsHandler.getModelContextLimit(state.getModel());
            ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
            LOG.debug("Restored token usage from history: " + usedTokens + " / " + maxTokens);
        } catch (Exception e) {
            LOG.warn("Failed to extract token usage from history: " + e.getMessage());
        }
    }

    /** Notify callback of message updates. */
    private void notifyMessageUpdate() {
        callbackHandler.notifyMessageUpdate(getMessages());
    }

    /** Notify callback of state changes. */
    private void updateState() {
        callbackHandler.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
        
        // Show error in status bar
        String error = state.getError();
        if (error != null && !error.isEmpty()) {
            com.github.claudecodegui.notifications.ClaudeNotifier.showError(project, error);
        }
    }

    /** Represents a file attachment (e.g., image). */
    public static class Attachment {
        public String fileName;
        public String mediaType;
        public String data; // Base64 encoded data

        public Attachment(String fileName, String mediaType, String data) {
            this.fileName = fileName;
            this.mediaType = mediaType;
            this.data = data;
        }
    }

    /** Get the permission manager. */
    public PermissionManager getPermissionManager() {
        return permissionManager;
    }

    /**
     * Set the permission mode.
     * Maps frontend permission mode strings to PermissionManager enum values.
     */
    public void setPermissionMode(String mode) {
        state.setPermissionMode(mode);

        // Sync PermissionManager mode with frontend mode:
        // - "default" -> DEFAULT (ask every time)
        // - "acceptEdits" -> ACCEPT_EDITS (agent mode, auto-accept file edits)
        // - "bypassPermissions" -> ALLOW_ALL (auto mode, bypass all permission checks)
        // - "plan" -> DENY_ALL (plan mode, not yet supported)
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
            // "default" or other unknown modes
            pmMode = PermissionManager.PermissionMode.DEFAULT;
            LOG.info("Permission mode set to DEFAULT for mode: " + mode);
        }

        permissionManager.setPermissionMode(pmMode);
    }

    /** Get the permission mode. */
    public String getPermissionMode() {
        return state.getPermissionMode();
    }

    /** Set the model. */
    public void setModel(String model) {
        state.setModel(model);
        LOG.info("Model updated to: " + model);
    }

    /** Get the model. */
    public String getModel() {
        return state.getModel();
    }

    /** Set the AI provider. */
    public void setProvider(String provider) {
        state.setProvider(provider);
        LOG.info("Provider updated to: " + provider);
    }

    /** Get the AI provider. */
    public String getProvider() {
        return state.getProvider();
    }

    /** Set the reasoning effort level. */
    public void setReasoningEffort(String effort) {
        state.setReasoningEffort(effort);
        LOG.info("Reasoning effort updated to: " + effort);
    }

    /** Get the reasoning effort level. */
    public String getReasoningEffort() {
        return state.getReasoningEffort();
    }

    /** Get the list of available slash commands. */
    public List<String> getSlashCommands() {
        return state.getSlashCommands();
    }



    /** Create a permission request (called by the SDK). */
    public PermissionRequest createPermissionRequest(String toolName, Map<String, Object> inputs, JsonObject suggestions, Project project) {
        return permissionManager.createRequest(state.getChannelId(), toolName, inputs, suggestions, project);
    }

    /** Handle a permission decision. */
    public void handlePermissionDecision(String channelId, boolean allow, boolean remember, String rejectMessage) {
        permissionManager.handlePermissionDecision(channelId, allow, remember, rejectMessage);
    }

    /** Handle an "always allow" permission decision. */
    public void handlePermissionDecisionAlways(String channelId, boolean allow) {
        permissionManager.handlePermissionDecisionAlways(channelId, allow);
    }
}
