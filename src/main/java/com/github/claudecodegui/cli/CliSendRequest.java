package com.github.claudecodegui.cli;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * CLI 模式发送请求，完全独立于 SDK。
 */
public record CliSendRequest(
        String tabId,
        String provider,
        String message,
        String sessionId,
        String cwd,
        List<ClaudeSession.Attachment> attachments,
        JsonObject openedFiles,
        List<String> fileTagPaths,
        String agentPrompt,
        String permissionMode,
        String model,
        String reasoningEffort,
        String permissionSessionId,
        Map<String, String> extraEnv
) {
    public CliSendRequest {
        if (tabId == null || tabId.isBlank()) {
            throw new IllegalArgumentException("tabId required");
        }
        if (provider == null || provider.isBlank()) {
            throw new IllegalArgumentException("provider required");
        }
        message = Objects.requireNonNullElse(message, "");
        attachments = attachments != null ? List.copyOf(attachments) : List.of();
        fileTagPaths = fileTagPaths != null ? List.copyOf(fileTagPaths) : List.of();
        extraEnv = extraEnv != null ? Map.copyOf(extraEnv) : Map.of();
    }
}
