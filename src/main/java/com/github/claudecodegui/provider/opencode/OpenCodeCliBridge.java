package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * OpenCode CLI bridge.
 *
 * <p>MVP uses {@code opencode run --format json} via channel-manager (same
 * approach as desktop-cc-gui). Managed {@code opencode serve} / SDK can be
 * layered later without changing the Java marker contract.
 */
public class OpenCodeCliBridge extends MarkerCliBridge {

    public OpenCodeCliBridge() {
        super(OpenCodeCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "opencode";
    }

    @Override
    protected String getStdinEnvKey() {
        return "OPENCODE_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        // Reserved for OPENCODE_HOME / OPENCODE_CONFIG_CONTENT injection.
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new OpenCodeHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[OpenCode] Failed to load session messages: " + e.getMessage());
            return Collections.emptyList();
        }
    }
}
