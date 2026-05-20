package com.github.claudecodegui.session.runtime;

import java.util.Objects;

/**
 * Identifies one provider runtime owned by a chat tab.
 */
public record RuntimeKey(
        String provider,
        String channelId,
        String tabId,
        String runtimeSessionEpoch
) {
    public RuntimeKey {
        provider = normalizeRequired(provider, "provider");
        channelId = normalizeRequired(channelId, "channelId");
        tabId = normalizeRequired(tabId, "tabId");
        runtimeSessionEpoch = normalizeRequired(runtimeSessionEpoch, "runtimeSessionEpoch");
    }

    public boolean matches(String provider, String channelId, String tabId) {
        return matchesNullable(this.provider, provider)
                && matchesNullable(this.channelId, channelId)
                && matchesNullable(this.tabId, tabId);
    }

    private static String normalizeRequired(String value, String fieldName) {
        String normalized = value != null ? value.trim() : "";
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException(fieldName + " is required");
        }
        return normalized;
    }

    private static boolean matchesNullable(String actual, String expected) {
        return expected == null || Objects.equals(actual, expected.trim());
    }
}
