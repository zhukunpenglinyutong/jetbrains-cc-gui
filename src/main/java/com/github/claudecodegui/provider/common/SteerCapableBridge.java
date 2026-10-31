package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Provider bridge that can inject a steer into a live turn.
 */
public interface SteerCapableBridge {

    /**
     * Enqueue a steer onto the live daemon runtime. Does not start a new turn.
     *
     * @param sessionId           session whose runtime should receive the steer
     * @param runtimeSessionEpoch runtime epoch for session matching
     * @param steerId             frontend correlation id
     * @param message             user text
     * @param attachments         optional attachments
     * @param agentPrompt         optional agent prompt
     * @param reasoningEffort     optional reasoning effort
     * @return JSON with {@code delivered} and optional {@code reason}
     */
    CompletableFuture<JsonObject> steerLive(
            String sessionId,
            String runtimeSessionEpoch,
            String steerId,
            String message,
            List<ClaudeSession.Attachment> attachments,
            String agentPrompt,
            String reasoningEffort
    );
}
