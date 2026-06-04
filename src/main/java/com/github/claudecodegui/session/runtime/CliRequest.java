package com.github.claudecodegui.session.runtime;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Provider-neutral request passed from session orchestration to a CLI adapter.
 */
public record CliRequest(
        RuntimeKey key,
        String message,
        String sessionIdOrThreadId,
        String cwd,
        List<ClaudeSession.Attachment> attachments,
        JsonObject openedFiles,
        List<String> fileTagPaths,
        String agentPrompt,
        String permissionMode,
        String model,
        String reasoningEffort,
        String permissionSessionId,
        Map<String, String> env
) {
    public CliRequest {
        if (key == null) {
            throw new IllegalArgumentException("key is required");
        }
        message = message != null ? message : "";
        attachments = attachments != null ? List.copyOf(attachments) : Collections.emptyList();
        fileTagPaths = fileTagPaths != null ? List.copyOf(fileTagPaths) : Collections.emptyList();
        env = env != null ? Map.copyOf(env) : Collections.emptyMap();
    }
}
