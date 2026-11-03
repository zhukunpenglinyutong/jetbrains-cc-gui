package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SteerCapableBridge;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Routes {@code steer_message} to the provider's {@link SteerCapableBridge}.
 * Missing implementations reject with {@code unsupported_provider}.
 */
public class SessionSteerService {

    private static final Logger LOG = Logger.getInstance(SessionSteerService.class);

    private final Map<String, SteerCapableBridge> bridges = new HashMap<>();

    /**
     * Register a provider implementation.
     *
     * @param provider provider id (e.g. {@code claude})
     * @param bridge   live-steer bridge
     */
    public void register(String provider, SteerCapableBridge bridge) {
        if (provider != null && bridge != null) {
            bridges.put(provider, bridge);
        }
    }

    /**
     * Steer a message into the live turn of {@code provider}.
     *
     * @param provider            current session provider
     * @param sessionId           session id
     * @param runtimeSessionEpoch runtime epoch
     * @param steerId             frontend correlation id
     * @param message             user text
     * @param attachments         optional attachments
     * @param agentPrompt         optional agent prompt
     * @param reasoningEffort     optional reasoning effort
     * @return delivered/reason JSON
     */
    public CompletableFuture<JsonObject> steer(
            String provider,
            String sessionId,
            String runtimeSessionEpoch,
            String steerId,
            String message,
            List<ClaudeSession.Attachment> attachments,
            String agentPrompt,
            String reasoningEffort
    ) {
        SteerCapableBridge bridge = provider != null ? bridges.get(provider) : null;
        if (bridge == null) {
            LOG.info("[SessionSteerService] No steer implementation for provider=" + provider);
            JsonObject rejected = new JsonObject();
            rejected.addProperty("delivered", false);
            rejected.addProperty("reason", "unsupported_provider");
            return CompletableFuture.completedFuture(rejected);
        }
        return bridge.steerLive(
                sessionId,
                runtimeSessionEpoch,
                steerId,
                message,
                attachments,
                agentPrompt,
                reasoningEffort
        );
    }
}
