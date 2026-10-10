package com.github.claudecodegui.clawbot;

import java.util.Set;

/** Immutable session data safe for channel listing and status rendering. */
public record ClawBotSessionSnapshot(
        String sessionHandleId,
        String instanceId,
        String projectId,
        String projectDisplayName,
        String provider,
        Set<String> capabilities,
        ClawBotSessionStatus status,
        long connectionEpoch,
        long registeredAtMillis,
        long lastHeartbeatAtMillis,
        String tabDisplayName,
        String generation,
        long idleMillis
) {

    public ClawBotSessionSnapshot(
            String sessionHandleId, String instanceId, String projectId, String projectDisplayName,
            String provider, Set<String> capabilities, ClawBotSessionStatus status, long connectionEpoch,
            long registeredAtMillis, long lastHeartbeatAtMillis, String tabDisplayName) {
        this(sessionHandleId, instanceId, projectId, projectDisplayName, provider, capabilities, status,
                connectionEpoch, registeredAtMillis, lastHeartbeatAtMillis, tabDisplayName, "legacy", 0);
    }

    public ClawBotSessionSnapshot(
            String sessionHandleId,
            String instanceId,
            String projectId,
            String projectDisplayName,
            String provider,
            Set<String> capabilities,
            ClawBotSessionStatus status,
            long connectionEpoch,
            long registeredAtMillis,
            long lastHeartbeatAtMillis
    ) {
        this(sessionHandleId, instanceId, projectId, projectDisplayName, provider, capabilities, status,
                connectionEpoch, registeredAtMillis, lastHeartbeatAtMillis, "Chat");
    }

    ClawBotSessionSnapshot withHeartbeat(ClawBotSessionStatus newStatus, long heartbeatAtMillis) {
        return new ClawBotSessionSnapshot(sessionHandleId, instanceId, projectId, projectDisplayName, provider,
                capabilities, newStatus, connectionEpoch, registeredAtMillis, heartbeatAtMillis, tabDisplayName, generation, idleMillis);
    }

    ClawBotSessionSnapshot withStatus(ClawBotSessionStatus newStatus) {
        return new ClawBotSessionSnapshot(sessionHandleId, instanceId, projectId, projectDisplayName, provider,
                capabilities, newStatus, connectionEpoch, registeredAtMillis, lastHeartbeatAtMillis, tabDisplayName, generation, idleMillis);
    }

    ClawBotSessionSnapshot withIdleMillis(long value) {
        return new ClawBotSessionSnapshot(sessionHandleId, instanceId, projectId, projectDisplayName, provider,
                capabilities, status, connectionEpoch, registeredAtMillis, lastHeartbeatAtMillis, tabDisplayName, generation, value);
    }
}
