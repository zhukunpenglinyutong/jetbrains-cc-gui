package com.github.claudecodegui.session.runtime;

import com.github.claudecodegui.cli.CliSendRequest;
import com.github.claudecodegui.cli.CliSessionManager;
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
 * CLI mode routes to the new CliSessionManager (zero SDK dependency).
 * SDK mode routes to SdkSessionRuntime (ai-bridge daemon).
 */
public class SessionRuntimeRouter {
    private final SdkSessionRuntime sdkRuntime;
    private final CliSessionManager cliManager;

    public SessionRuntimeRouter(ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.sdkRuntime = new SdkSessionRuntime(claudeSDKBridge, codexSDKBridge);
        this.cliManager = new CliSessionManager();
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
            String tabId = resolveTabId(channelId);
            return cliManager.send(new CliSendRequest(
                    tabId, "claude", message, sessionId, cwd,
                    attachments, openedFiles, List.of(),
                    agentPrompt, permissionMode, model, reasoningEffort, Map.of()
            ), callback);
        }
        return sdkRuntime.sendClaude(channelId, message, sessionId, runtimeSessionEpoch, cwd,
                attachments, permissionMode, model, openedFiles, agentPrompt, streaming, reasoningEffort, callback);
    }

    public CompletableFuture<SDKResult> sendCodex(
            boolean useCliRuntime,
            CliRequest cliRequest,
            MessageCallback callback
    ) {
        if (useCliRuntime) {
            String tabId = resolveTabId(cliRequest.key().channelId());
            return cliManager.send(new CliSendRequest(
                    tabId, "codex",
                    cliRequest.message(),
                    cliRequest.sessionIdOrThreadId(),
                    cliRequest.cwd(),
                    cliRequest.attachments(),
                    cliRequest.openedFiles(),
                    cliRequest.fileTagPaths(),
                    cliRequest.agentPrompt(),
                    cliRequest.permissionMode(),
                    cliRequest.model(),
                    cliRequest.reasoningEffort(),
                    cliRequest.env()
            ), callback);
        }
        return sdkRuntime.sendCodex(
                cliRequest.key().channelId(), cliRequest.message(),
                cliRequest.sessionIdOrThreadId(), cliRequest.cwd(),
                cliRequest.attachments(), cliRequest.permissionMode(),
                cliRequest.model(), cliRequest.agentPrompt(),
                cliRequest.reasoningEffort(), callback);
    }

    public JsonObject launch(String provider, String channelId, String tabId, String runtimeSessionEpoch, String sessionId, String cwd) {
        // CLI mode: no-op launch (session starts on first send)
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.addProperty("channelId", channelId);
        if (sessionId != null) {
            result.addProperty("sessionId", sessionId);
        }
        return result;
    }

    public void interrupt(String provider, String channelId, String tabId) {
        cliManager.interrupt(resolveTabId(tabId != null ? tabId : channelId), provider);
    }

    public void cleanupTab(String tabId) {
        cliManager.disposeTab(resolveTabId(tabId));
    }

    private static String resolveTabId(String value) {
        return value != null && !value.trim().isEmpty() ? value : "default";
    }
}
