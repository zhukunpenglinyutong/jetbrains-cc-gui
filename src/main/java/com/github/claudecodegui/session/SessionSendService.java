package com.github.claudecodegui.session;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Owns message-send orchestration while ClaudeSession remains the public session facade.
 */
public class SessionSendService {

    private static final Logger LOG = Logger.getInstance(SessionSendService.class);

    private final Project project;
    private final SessionState state;
    private final SessionCallbackFacade callbackFacade;
    private final MessageParser messageParser;
    private final MessageMerger messageMerger;
    private final Gson gson;
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final SessionContextService contextService;

    public SessionSendService(
            Project project,
            SessionState state,
            SessionCallbackFacade callbackFacade,
            MessageParser messageParser,
            MessageMerger messageMerger,
            Gson gson,
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            SessionContextService contextService
    ) {
        this.project = project;
        this.state = state;
        this.callbackFacade = callbackFacade;
        this.messageParser = messageParser;
        this.messageMerger = messageMerger;
        this.gson = gson;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.contextService = contextService;
    }

    public void prepareContextCollector(EditorContextCollector contextCollector) {
        contextCollector.setPsiContextEnabled(state.isPsiContextEnabled());
        contextCollector.setAutoOpenFileEnabled(readAutoOpenFileEnabled());
    }

    public void updateSessionStateForSend(ClaudeSession.Message userMessage, String normalizedInput) {
        state.addMessage(userMessage);
        callbackFacade.notifyMessageUpdate(state.getMessages());

        if (state.getSummary() == null) {
            String baseSummary = (userMessage.content != null && !userMessage.content.isEmpty())
                    ? userMessage.content
                    : normalizedInput;
            String newSummary = baseSummary.length() > 45 ? baseSummary.substring(0, 45) + "..." : baseSummary;
            state.setSummary(newSummary);
            callbackFacade.notifySummaryReceived(newSummary);
        }

        state.updateLastModifiedTime();
        state.setError(null);
        state.setBusy(true);
        state.setLoading(true);
        ClaudeNotifier.setWaiting(project);
        callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    public CompletableFuture<Void> sendMessageToProvider(
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String externalAgentPrompt,
            List<String> fileTagPaths,
            String requestedPermissionMode
    ) {
        String selectedAgentPrompt = externalAgentPrompt;
        if (selectedAgentPrompt == null) {
            selectedAgentPrompt = getAgentPrompt();
            LOG.info("[Agent] Using agent from global setting (fallback)");
        } else {
            LOG.info("[Agent] Using agent from message (per-tab selection)");
        }
        String messagePromptBlock = buildMessagePromptBlock(selectedAgentPrompt);
        String finalInput = prependPromptBlockToMessage(input, messagePromptBlock);

        String currentProvider = state.getProvider();
        String sessionModeBeforeSend = state.getPermissionMode();
        String normalizedRequestedMode = normalizeRequestedPermissionMode(requestedPermissionMode);
        String effectivePermissionMode = resolveEffectivePermissionMode(
                currentProvider,
                normalizedRequestedMode,
                sessionModeBeforeSend
        );

        LOG.info(
                "[ModeSync][Backend] provider=" + currentProvider
                        + ", requested=" + (normalizedRequestedMode != null ? normalizedRequestedMode : "(none)")
                        + ", session=" + (sessionModeBeforeSend != null ? sessionModeBeforeSend : "(none)")
                        + ", effective=" + effectivePermissionMode
        );

        if ("codex".equals(currentProvider)) {
            return sendToCodex(
                    channelId,
                    finalInput,
                    attachments,
                    openedFilesJson,
                    null,
                    fileTagPaths,
                    effectivePermissionMode
            );
        }

        return sendToClaude(channelId, finalInput, attachments, openedFilesJson, null, effectivePermissionMode);
    }

    public static String normalizeRequestedPermissionMode(String mode) {
        if (mode == null) {
            return null;
        }
        String trimmed = mode.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (SessionState.isValidPermissionMode(trimmed)) {
            return trimmed;
        }
        LOG.warn("[ModeSync][Backend] Invalid requested permissionMode ignored: " + mode);
        return null;
    }

    public static String resolveEffectivePermissionMode(String provider, String requestedMode, String sessionMode) {
        String resolvedMode = requestedMode;
        if (resolvedMode == null) {
            resolvedMode = normalizeRequestedPermissionMode(sessionMode);
        }
        if (resolvedMode == null) {
            resolvedMode = "default";
        }

        if ("codex".equals(provider) && "plan".equals(resolvedMode)) {
            return "default";
        }
        return resolvedMode;
    }

    public static String getCodexRuntimeAccessError(String accessMode) {
        if (CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED.equals(accessMode)
                || CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN.equals(accessMode)) {
            return null;
        }
        return ClaudeCodeGuiBundle.message("error.codexLocalAccessNotAuthorized");
    }

    private CompletableFuture<Void> sendToCodex(
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String agentPrompt,
            List<String> fileTagPaths,
            String effectivePermissionMode
    ) {
        CodexMessageHandler handler = new CodexMessageHandler(state, callbackFacade.getCallbackHandler());
        String accessMode = CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE;
        try {
            accessMode = new CodemossSettingsService().getCodexRuntimeAccessMode();
        } catch (Exception e) {
            LOG.warn("[Codex] Failed to resolve runtime access mode: " + e.getMessage());
        }

        String accessError = getCodexRuntimeAccessError(accessMode);
        if (accessError != null) {
            handler.onError(accessError);
            return CompletableFuture.completedFuture(null);
        }

        String contextAppend = contextService.buildCodexContextAppend(openedFilesJson, fileTagPaths);
        String finalInput = (input != null ? input : "") + contextAppend;

        return codexSDKBridge.sendMessage(
                channelId,
                finalInput,
                state.getSessionId(),
                state.getCwd(),
                attachments,
                effectivePermissionMode,
                state.getModel(),
                agentPrompt,
                state.getReasoningEffort(),
                handler
        ).thenApply(result -> null);
    }

    private CompletableFuture<Void> sendToClaude(
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String agentPrompt,
            String effectivePermissionMode
    ) {
        ClaudeMessageHandler handler = new ClaudeMessageHandler(
                project,
                state,
                callbackFacade.getCallbackHandler(),
                messageParser,
                messageMerger,
                gson
        );

        Boolean streaming = readStreamingEnabled();
        final String runtimeSessionEpoch = state.getRuntimeSessionEpoch();
        final String currentModel = state.getModel();
        LOG.info("[Lifecycle] sendToClaude sessionId=" + (state.getSessionId() != null ? state.getSessionId() : "(new)")
                + ", epoch=" + runtimeSessionEpoch
                + ", cwd=" + state.getCwd()
                + ", model=" + currentModel);

        return claudeSDKBridge.sendMessage(
                        channelId,
                        input,
                        state.getSessionId(),
                        runtimeSessionEpoch,
                        state.getCwd(),
                        attachments,
                        effectivePermissionMode,
                        currentModel,
                        openedFilesJson,
                        agentPrompt,
                        streaming,
                        false,
                        handler
                ).thenApply(result -> null);
    }

    private boolean readAutoOpenFileEnabled() {
        try {
            String projectPath = project.getBasePath();
            if (projectPath != null) {
                CodemossSettingsService settingsService = new CodemossSettingsService();
                boolean autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);
                LOG.info("[EditorContext] Auto open file enabled: " + autoOpenFileEnabled);
                return autoOpenFileEnabled;
            }
        } catch (Exception e) {
            LOG.warn("[EditorContext] Failed to read autoOpenFileEnabled setting: " + e.getMessage());
        }
        return false;
    }

    private Boolean readStreamingEnabled() {
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
        return streaming;
    }

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
                    LOG.info("[Agent] ✓ Prompt preview: "
                            + (agentPrompt.length() > 100 ? agentPrompt.substring(0, 100) + "..." : agentPrompt));
                    return agentPrompt;
                }
                LOG.info("[Agent] ✗ Agent found but no prompt configured");
            } else {
                LOG.info("[Agent] ✗ No agent selected");
            }
        } catch (Exception e) {
            LOG.warn("[Agent] ✗ Failed to get agent prompt: " + e.getMessage());
        }
        return null;
    }

    private String buildMessagePromptBlock(String selectedAgentPrompt) {
        String normalizedAgentPrompt = normalizePromptText(selectedAgentPrompt);
        String autoInjectPrompt = state.isPromptInjected() ? null : getEnabledPromptsInstructionBlock();
        String autoCommitPrompt = getAutoCommitInstructionBlock();

        if (normalizedAgentPrompt == null && autoInjectPrompt == null && autoCommitPrompt == null) {
            return null;
        }

        StringBuilder builder = new StringBuilder();
        if (normalizedAgentPrompt != null) {
            builder.append("## Agent Role and Instructions\n\n");
            builder.append(normalizedAgentPrompt);
        }

        if (autoInjectPrompt != null) {
            if (builder.length() > 0) {
                builder.append("\n\n");
            }
            builder.append(autoInjectPrompt);
            state.setPromptInjected(true);
        }

        if (autoCommitPrompt != null) {
            if (builder.length() > 0) {
                builder.append("\n\n");
            }
            builder.append(autoCommitPrompt);
        }

        return builder.toString();
    }

    private String prependPromptBlockToMessage(String input, String promptBlock) {
        String normalizedInput = input != null ? input : "";
        if (promptBlock == null) {
            return normalizedInput;
        }
        return promptBlock + "\n\n---\n\n" + normalizedInput;
    }

    private String getEnabledPromptsInstructionBlock() {
        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            List<String> enabledPromptContents = new ArrayList<>();

            appendScopeEnabledPromptContents(
                    enabledPromptContents,
                    settingsService,
                    com.github.claudecodegui.model.PromptScope.PROJECT
            );
            appendScopeEnabledPromptContents(
                    enabledPromptContents,
                    settingsService,
                    com.github.claudecodegui.model.PromptScope.GLOBAL
            );

            if (enabledPromptContents.isEmpty()) {
                return null;
            }

            StringBuilder builder = new StringBuilder();
            builder.append("## Auto Injected Prompt Instructions\n\n");
            builder.append("Apply all enabled prompt instructions below throughout this conversation.\n\n");
            for (int i = 0; i < enabledPromptContents.size(); i++) {
                builder.append(enabledPromptContents.get(i));
                if (i < enabledPromptContents.size() - 1) {
                    builder.append("\n\n---\n\n");
                }
            }
            LOG.info("[PromptAutoInject] Enabled prompts injected: " + enabledPromptContents.size());
            return builder.toString();
        } catch (Exception e) {
            LOG.warn("[PromptAutoInject] Failed to resolve enabled prompt instructions: " + e.getMessage());
            return null;
        }
    }

    private void appendScopeEnabledPromptContents(
            List<String> collector,
            CodemossSettingsService settingsService,
            com.github.claudecodegui.model.PromptScope scope
    ) {
        try {
            appendEnabledPromptContents(collector, settingsService.getPrompts(scope, project));
        } catch (Exception e) {
            LOG.debug("[PromptAutoInject] Skip scope " + scope.getValue() + ": " + e.getMessage());
        }
    }

    private void appendEnabledPromptContents(List<String> collector, List<JsonObject> prompts) {
        if (prompts == null || prompts.isEmpty()) {
            return;
        }
        for (JsonObject prompt : prompts) {
            if (prompt == null) {
                continue;
            }
            boolean autoInject = prompt.has("autoInject")
                    && !prompt.get("autoInject").isJsonNull()
                    && prompt.get("autoInject").getAsBoolean();
            if (!autoInject) {
                continue;
            }
            if (!prompt.has("content") || prompt.get("content").isJsonNull()) {
                continue;
            }
            String content = normalizePromptText(prompt.get("content").getAsString());
            if (content != null) {
                collector.add(content);
            }
        }
    }

    private String normalizePromptText(String text) {
        if (text == null) {
            return null;
        }
        String trimmed = text.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private String getAutoCommitInstructionBlock() {
        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            boolean autoCommitEnabled = settingsService.getAutoCommitEnabled();
            boolean autoResolveConflictsEnabled = settingsService.getAutoResolveConflictsEnabled();
            String language = settingsService.getUiLanguage();
            boolean chinese = "zh".equals(language) || "zh-TW".equals(language);
            if (autoCommitEnabled) {
                if (chinese) {
                    return """
## Git Auto Commit Policy

当前项目已开启自动提交。
完成代码修改后：
1. 先执行 git status 检查变更文件。
2. 如果存在变更，执行一次 git add 和 git commit。
3. 不要回退或覆盖其他并行 AI 会话产生的较新改动。
4. 同一文件中不重叠的改动必须自动合并保留。
5. %s
6. 生成的 commit message 必须使用中文。
""".formatted(
                            autoResolveConflictsEnabled
                                    ? "同一位置冲突已开启自动解决：在安全前提下尽量保留两边意图。"
                                    : "同一位置冲突未开启自动解决：出现冲突时停止并上报给用户决策。"
                    );
                }
                return """
## Git Auto Commit Policy

Auto commit is enabled for this project.
After finishing code changes:
1. Run git status to check changed files.
2. If there are changes, run git add and git commit once.
3. Do not revert or overwrite newer changes from other parallel AI sessions.
4. Resolve non-overlapping same-file changes by merging them.
5. %s
""".formatted(
                        autoResolveConflictsEnabled
                                ? "Auto resolve for same-line conflicts is enabled: merge both intents when safe."
                                : "Auto resolve for same-line conflicts is disabled: stop and report conflicts for user decision."
                );
            }
            if (chinese) {
                return """
## Git Auto Commit Policy

当前项目未开启自动提交。
除非用户在本轮明确要求，否则不要自动执行 git commit。
若用户要求提交，commit message 必须使用中文。
""";
            }
            return """
## Git Auto Commit Policy

Auto commit is disabled for this project.
Do not run git commit automatically unless the user explicitly asks in this turn.
""";
        } catch (Exception e) {
            LOG.debug("[AutoCommit] Failed to read auto commit setting for prompt injection: " + e.getMessage());
            return null;
        }
    }
}
