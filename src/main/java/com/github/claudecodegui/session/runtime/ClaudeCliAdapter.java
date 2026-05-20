package com.github.claudecodegui.session.runtime;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.provider.claude.ClaudeCliBridge;
import com.github.claudecodegui.provider.claude.ClaudeCliDetector;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * CliAdapter facade for Claude CLI.
 */
public class ClaudeCliAdapter implements CliAdapter {
    private final ClaudeCliBridge bridge;
    private final ClaudeSDKBridge sdkBridge;
    private final ProcessManager processManager;

    public ClaudeCliAdapter(ClaudeSDKBridge sdkBridge, ProcessManager processManager) {
        this(
                sdkBridge,
                processManager,
                new ClaudeCliBridge(
                        processManager,
                        ClaudeCliDetector.getInstance(),
                        new Gson(),
                        new EnvironmentConfigurator()
                )
        );
    }

    public ClaudeCliAdapter(ClaudeSDKBridge sdkBridge, ProcessManager processManager, ClaudeCliBridge bridge) {
        this.sdkBridge = sdkBridge;
        this.processManager = processManager;
        this.bridge = bridge;
    }

    @Override
    public CompletableFuture<SDKResult> send(CliRequest request, MessageCallback callback) {
        RuntimeKey key = request.key();
        return bridge.sendMessage(
                key,
                key.channelId(),
                request.message(),
                request.sessionIdOrThreadId(),
                key.runtimeSessionEpoch(),
                request.cwd(),
                request.attachments(),
                request.permissionMode(),
                request.model(),
                request.openedFiles(),
                request.agentPrompt(),
                true,
                false,
                request.reasoningEffort(),
                callback
        );
    }

    @Override
    public JsonObject launch(RuntimeKey key, String sessionId, String cwd) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.addProperty("channelId", key.channelId());
        if (sessionId != null) {
            result.addProperty("sessionId", sessionId);
        }
        result.addProperty("message", "Claude CLI runtime ready");
        return result;
    }

    @Override
    public void interrupt(RuntimeKey key) {
        processManager.interruptRuntime(key);
    }

    @Override
    public List<JsonObject> loadMessages(String sessionId, String cwd) {
        return sdkBridge.getSessionMessages(sessionId, cwd);
    }
}
