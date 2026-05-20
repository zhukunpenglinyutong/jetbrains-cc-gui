package com.github.claudecodegui.session.runtime;

import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Selects the session runtime without exposing provider bridge details to send orchestration.
 */
public class SessionRuntimeRouter {
    private final SdkSessionRuntime sdkRuntime;
    private final CliSessionRuntime cliRuntime;
    private final ProcessManager cliProcessManager;

    public SessionRuntimeRouter(ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.cliProcessManager = new ProcessManager();
        this.sdkRuntime = new SdkSessionRuntime(claudeSDKBridge, codexSDKBridge);
        this.cliRuntime = new CliSessionRuntime(Map.of(
                "claude", new ClaudeCliAdapter(claudeSDKBridge, cliProcessManager),
                "codex", new CodexCliAdapter(cliProcessManager, codexSDKBridge)
        ));
    }

    public CompletableFuture<SDKResult> sendClaude(
            String invocationMode,
            String channelId,
            String message,
            String sessionId,
            String runtimeSessionEpoch,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            String reasoningEffort,
            MessageCallback callback
    ) {
        if ("cli".equals(invocationMode)) {
            RuntimeKey key = new RuntimeKey("claude", channelId, resolveTabId(channelId), runtimeSessionEpoch);
            return cliRuntime.send(new CliRequest(
                    key,
                    message,
                    sessionId,
                    cwd,
                    attachments,
                    openedFiles,
                    List.of(),
                    agentPrompt,
                    permissionMode,
                    model,
                    reasoningEffort,
                    Map.of()
            ), callback);
        }

        return sdkRuntime.sendClaude(
                channelId,
                message,
                sessionId,
                runtimeSessionEpoch,
                cwd,
                attachments,
                permissionMode,
                model,
                openedFiles,
                agentPrompt,
                streaming,
                reasoningEffort,
                callback
        );
    }

    public CompletableFuture<SDKResult> sendCodex(
            boolean useCliRuntime,
            CliRequest cliRequest,
            MessageCallback callback
    ) {
        if (useCliRuntime) {
            return cliRuntime.send(cliRequest, callback);
        }
        return sdkRuntime.sendCodex(
                cliRequest.key().channelId(),
                cliRequest.message(),
                cliRequest.sessionIdOrThreadId(),
                cliRequest.cwd(),
                cliRequest.attachments(),
                cliRequest.permissionMode(),
                cliRequest.model(),
                cliRequest.agentPrompt(),
                cliRequest.reasoningEffort(),
                callback
        );
    }

    public JsonObject launch(String provider, String channelId, String tabId, String runtimeSessionEpoch, String sessionId, String cwd) {
        RuntimeKey key = new RuntimeKey(provider, channelId, resolveTabId(tabId != null ? tabId : channelId), runtimeSessionEpoch);
        return cliRuntime.launch(key, sessionId, cwd);
    }

    public void interrupt(String provider, String channelId, String tabId) {
        cliProcessManager.interruptChannel(provider, channelId, tabId);
    }

    public void cleanupTab(String tabId) {
        cliProcessManager.cleanupTab(tabId);
    }

    public ProcessManager getCliProcessManager() {
        return cliProcessManager;
    }

    private static String resolveTabId(String value) {
        return value != null && !value.trim().isEmpty() ? value : "default";
    }
}
