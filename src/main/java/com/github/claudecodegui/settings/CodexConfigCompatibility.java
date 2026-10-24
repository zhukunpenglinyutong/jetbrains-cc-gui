package com.github.claudecodegui.settings;

import java.util.LinkedHashMap;
import java.util.Map;

/** Normalizes known legacy fields while retaining unknown configuration for native diagnostics. */
final class CodexConfigCompatibility {
    private CodexConfigCompatibility() {
    }

    @SuppressWarnings("unchecked")
    static void normalize(Map<String, Object> config) {
        config.remove("disable_response_storage");
        config.remove("windows_wsl_setup_acknowledged");

        Object legacyNetwork = config.get("network_access");
        Boolean network = legacyNetwork instanceof Boolean ? (Boolean) legacyNetwork
                : "enabled".equals(legacyNetwork) ? Boolean.TRUE
                : "disabled".equals(legacyNetwork) ? Boolean.FALSE : null;
        Object workspace = config.get("sandbox_workspace_write");
        if (network != null && (workspace == null || workspace instanceof Map)) {
            Map<String, Object> settings = workspace instanceof Map
                    ? (Map<String, Object>) workspace : new LinkedHashMap<>();
            // An explicit native setting takes precedence over the old root-level value.
            settings.putIfAbsent("network_access", network);
            config.put("sandbox_workspace_write", settings);
            config.remove("network_access");
        }

        Object profiles = config.get("profiles");
        if (profiles instanceof Map<?, ?> entries) {
            for (Object profile : entries.values()) {
                if (profile instanceof Map<?, ?> settings) {
                    settings.remove("disable_response_storage");
                    settings.remove("windows_wsl_setup_acknowledged");
                    // Native profiles have no sandbox_workspace_write table. Keep unsupported
                    // profile network settings visible to native diagnostics rather than inventing one.
                }
            }
        }
    }
}
