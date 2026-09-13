package com.github.claudecodegui.provider.omp;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * OMP CLI bridge.
 *
 * <p>No official SDK — spawns local {@code omp} via channel-manager and maps
 * its JSON event stream onto the shared marker protocol.
 */
public class OmpCliBridge extends MarkerCliBridge {

    public OmpCliBridge() {
        super(OmpCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "omp";
    }

    @Override
    protected String getStdinEnvKey() {
        return "OMP_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        // Reserved for future OMP-specific env (e.g. OMP_OFFLINE).
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new OmpHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[OMP] Failed to load session messages: " + e.getMessage());
            return Collections.emptyList();
        }
    }
}
