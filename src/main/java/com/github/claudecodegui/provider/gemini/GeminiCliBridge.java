package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * Gemini CLI bridge.
 *
 * <p>No official SDK — spawns local {@code agy} via channel-manager and maps
 * stream-json onto the shared marker protocol.
 */
public class GeminiCliBridge extends MarkerCliBridge {

    public GeminiCliBridge() {
        super(GeminiCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "gemini";
    }

    @Override
    protected String getStdinEnvKey() {
        return "GEMINI_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        // Reserved for future Gemini-specific env.
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        // History reader arrives in Story 1.7
        return Collections.emptyList();
    }
}
