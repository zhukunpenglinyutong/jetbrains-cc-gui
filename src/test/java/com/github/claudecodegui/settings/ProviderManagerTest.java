package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for ProviderManager.
 */
public class ProviderManagerTest {
    /**
     * When current is blank, the local settings.json provider should be enabled by default.
     */
    @Test
    public void shouldDefaultActiveProviderToLocalSettingsWhenCurrentIsBlank() {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(createConfigWithCurrent(""));
        ProviderManager manager = createProviderManager(configRef);

        JsonObject activeProvider = manager.getActiveClaudeProvider();

        assertNotNull(activeProvider);
        assertEquals(ProviderManager.LOCAL_SETTINGS_PROVIDER_ID, activeProvider.get("id").getAsString());
        assertEquals(
                ProviderManager.LOCAL_SETTINGS_PROVIDER_ID,
                configRef.get().getAsJsonObject("claude").get("current").getAsString()
        );
    }

    /**
     * When current is missing, the provider list should also mark the local settings.json provider as active.
     */
    @Test
    public void shouldMarkLocalProviderAsActiveWhenCurrentIsMissing() {
        JsonObject config = new JsonObject();
        JsonObject claude = new JsonObject();
        claude.add("providers", new JsonObject());
        config.add("claude", claude);

        AtomicReference<JsonObject> configRef = new AtomicReference<>(config);
        ProviderManager manager = createProviderManager(configRef);

        List<JsonObject> providers = manager.getClaudeProviders();

        assertEquals(ProviderManager.LOCAL_SETTINGS_PROVIDER_ID, providers.get(0).get("id").getAsString());
        assertTrue(providers.get(0).get("isActive").getAsBoolean());
        assertEquals(
                ProviderManager.LOCAL_SETTINGS_PROVIDER_ID,
                configRef.get().getAsJsonObject("claude").get("current").getAsString()
        );
    }

    /**
     * Build a ProviderManager backed only by in-memory config to avoid depending on the real filesystem in tests.
     */
    private ProviderManager createProviderManager(AtomicReference<JsonObject> configRef) {
        Gson gson = new Gson();
        ClaudeSettingsManager claudeSettingsManager = new ClaudeSettingsManager(gson, null) {
            @Override
            public JsonObject readClaudeSettings() {
                JsonObject settings = new JsonObject();
                settings.add("env", new JsonObject());
                return settings;
            }
        };

        return new ProviderManager(
                gson,
                ignored -> configRef.get(),
                updated -> configRef.set(JsonParser.parseString(updated.toString()).getAsJsonObject()),
                null,
                claudeSettingsManager
        );
    }

    /**
     * Build the minimal Claude configuration.
     */
    private JsonObject createConfigWithCurrent(String current) {
        JsonObject config = new JsonObject();
        JsonObject claude = new JsonObject();
        claude.addProperty("current", current);
        claude.add("providers", new JsonObject());
        config.add("claude", claude);
        return config;
    }
}
