package com.github.claudecodegui.clawbot;

import java.util.HashSet;
import java.util.Objects;
import java.util.Set;

/** Sanitized registration data supplied by one IDE client. */
public record ClawBotSessionRegistration(
        String sessionHandleId,
        String instanceId,
        String projectId,
        String projectDisplayName,
        String provider,
        Set<String> capabilities,
        ClawBotSessionStatus status,
        long connectionEpoch,
        String tabDisplayName,
        String generation
) {

    private static final int MAX_ID_LENGTH = 256;
    private static final int MAX_DISPLAY_NAME_LENGTH = 128;

    public ClawBotSessionRegistration {
        requireValue(sessionHandleId, "sessionHandleId", MAX_ID_LENGTH);
        requireValue(instanceId, "instanceId", MAX_ID_LENGTH);
        requireValue(projectId, "projectId", MAX_ID_LENGTH);
        requireValue(projectDisplayName, "projectDisplayName", MAX_DISPLAY_NAME_LENGTH);
        requireValue(provider, "provider", MAX_DISPLAY_NAME_LENGTH);
        requireValue(tabDisplayName, "tabDisplayName", MAX_DISPLAY_NAME_LENGTH);
        requireValue(generation, "generation", MAX_ID_LENGTH);
        capabilities = copyCapabilities(capabilities);
        Objects.requireNonNull(status, "status");
        if (connectionEpoch < 0) {
            throw new IllegalArgumentException("connectionEpoch must not be negative");
        }
    }

    public ClawBotSessionRegistration(
            String sessionHandleId, String instanceId, String projectId, String projectDisplayName,
            String provider, Set<String> capabilities, ClawBotSessionStatus status, long connectionEpoch,
            String tabDisplayName) {
        this(sessionHandleId, instanceId, projectId, projectDisplayName, provider, capabilities,
                status, connectionEpoch, tabDisplayName, "legacy");
    }

    public ClawBotSessionRegistration(
            String sessionHandleId,
            String instanceId,
            String projectId,
            String projectDisplayName,
            String provider,
            Set<String> capabilities,
            ClawBotSessionStatus status,
            long connectionEpoch
    ) {
        this(sessionHandleId, instanceId, projectId, projectDisplayName, provider, capabilities,
                status, connectionEpoch, "Chat");
    }

    ClawBotSessionRegistration withStatus(ClawBotSessionStatus nextStatus) {
        return new ClawBotSessionRegistration(sessionHandleId, instanceId, projectId, projectDisplayName,
                provider, capabilities, nextStatus, connectionEpoch, tabDisplayName, generation);
    }

    private static Set<String> copyCapabilities(Set<String> values) {
        Objects.requireNonNull(values, "capabilities");
        Set<String> copy = new HashSet<>();
        for (String value : values) {
            copy.add(requireValue(value, "capability", MAX_DISPLAY_NAME_LENGTH));
        }
        return Set.copyOf(copy);
    }

    private static String requireValue(String value, String name, int maxLength) {
        if (value == null || value.isBlank() || value.length() > maxLength || containsControl(value)) {
            throw new IllegalArgumentException("Invalid " + name);
        }
        return value;
    }

    private static boolean containsControl(String value) {
        for (int index = 0; index < value.length(); index++) {
            if (Character.isISOControl(value.charAt(index))) {
                return true;
            }
        }
        return false;
    }
}
