package com.github.claudecodegui.session.runtime;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Compatibility wrapper for existing SDK/daemon bridges.
 */
public class SdkSessionRuntime {
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;

    public SdkSessionRuntime(ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
    }

    public CompletableFuture<SDKResult> sendClaude(
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
        return claudeSDKBridge.sendMessage(
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
                false,
                reasoningEffort,
                "sdk",
                callback
        );
    }

    public CompletableFuture<SDKResult> sendCodex(
            String channelId,
            String message,
            String threadId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agentPrompt,
            String reasoningEffort,
            MessageCallback callback
    ) {
        return codexSDKBridge.sendMessageWithDaemonPreferred(
                channelId,
                message,
                threadId,
                cwd,
                attachments,
                permissionMode,
                model,
                agentPrompt,
                reasoningEffort,
                callback
        );
    }
}
