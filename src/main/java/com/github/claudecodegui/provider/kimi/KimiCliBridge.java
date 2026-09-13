package com.github.claudecodegui.provider.kimi;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Kimi CLI bridge.
 *
 * <p>No official SDK — spawns local {@code kimi} via channel-manager and maps
 * stream-json onto the shared marker protocol.
 */
public class KimiCliBridge extends MarkerCliBridge {

    public KimiCliBridge() {
        super(KimiCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "kimi";
    }

    @Override
    protected String getStdinEnvKey() {
        return "KIMI_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        // Reserved for future Kimi-specific env (e.g. KIMI_CODE_HOME).
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new KimiHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[Kimi] Failed to load session messages: " + e.getMessage());
            return Collections.emptyList();
        }
    }
}
