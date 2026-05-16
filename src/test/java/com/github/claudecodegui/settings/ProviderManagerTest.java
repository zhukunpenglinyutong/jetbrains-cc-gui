package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

/**
 * Regression tests for ProviderManager.
 */
public class ProviderManagerTest {
    /**
     * When current is blank and there are no saved providers, Claude should remain inactive.
     */
    @Test
    public void shouldLeaveClaudeInactiveWhenCurrentIsBlankAndNoProvidersExist() {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(createConfigWithCurrent(""));
        ProviderManager manager = createProviderManager(configRef);

        JsonObject activeProvider = manager.getActiveClaudeProvider();

        assertNull(activeProvider);
        assertEquals("", configRef.get().getAsJsonObject("claude").get("current").getAsString());
    }

    /**
     * When current is missing but explicit providers exist, the first saved provider should become active.
     */
    @Test
    public void shouldSelectFirstSavedProviderWhenCurrentIsMissing() {
        JsonObject config = new JsonObject();
        JsonObject claude = new JsonObject();
        JsonObject providersJson = new JsonObject();
        providersJson.add("provider-a", createProvider("Provider A"));
        providersJson.add("provider-b", createProvider("Provider B"));
        claude.add("providers", providersJson);
        config.add("claude", claude);

        AtomicReference<JsonObject> configRef = new AtomicReference<>(config);
        ProviderManager manager = createProviderManager(configRef);

        JsonObject activeProvider = manager.getActiveClaudeProvider();
        List<JsonObject> providers = manager.getClaudeProviders();

        assertEquals(ProviderManager.LOCAL_SETTINGS_PROVIDER_ID, providers.get(0).get("id").getAsString());
        assertFalse(providers.get(0).get("isActive").getAsBoolean());
        assertNotNull(activeProvider);
        assertEquals("provider-a", activeProvider.get("id").getAsString());
        assertEquals("provider-a", configRef.get().getAsJsonObject("claude").get("current").getAsString());
    }

    /**
     * An explicit local settings selection should still be preserved.
     */
    @Test
    public void shouldPreserveExplicitLocalSettingsSelection() {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(createConfigWithCurrent(ProviderManager.LOCAL_SETTINGS_PROVIDER_ID));
        ProviderManager manager = createProviderManager(configRef);

        JsonObject activeProvider = manager.getActiveClaudeProvider();

        assertNotNull(activeProvider);
        assertEquals(ProviderManager.LOCAL_SETTINGS_PROVIDER_ID, activeProvider.get("id").getAsString());
    }

    /**
     * Explicit deactivation should clear the active Claude provider.
     */
    @Test
    public void shouldDeactivateClaudeProvider() throws Exception {
        JsonObject config = createConfigWithCurrent("provider-a");
        config.getAsJsonObject("claude")
                .getAsJsonObject("providers")
                .add("provider-a", createProvider("Provider A"));
        AtomicReference<JsonObject> configRef = new AtomicReference<>(config);
        ProviderManager manager = createProviderManager(configRef);

        manager.deactivateClaudeProvider();

        assertEquals("", configRef.get().getAsJsonObject("claude").get("current").getAsString());
        assertNull(manager.getActiveClaudeProvider());
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

    private JsonObject createProvider(String name) {
        JsonObject provider = new JsonObject();
        provider.addProperty("name", name);
        provider.add("settingsConfig", new JsonObject());
        return provider;
    }
}
