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
     * Local Settings provider must skip startup repair so we don't overwrite
     * the user's hand-managed {@code ~/.claude/settings.json}.
     */
    @Test
    public void repairActiveProviderSkipsLocalSettingsMode() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(
                createConfigWithCurrent(ProviderManager.LOCAL_SETTINGS_PROVIDER_ID));
        ProviderManager manager = createProviderManager(configRef);

        boolean changed = manager.repairActiveProviderToClaudeSettings();

        assertFalse("Local settings provider must skip repair", changed);
    }

    /**
     * CLI Login provider must skip startup repair — the SDK owns auth via
     * native OAuth, so the plugin must not touch settings.json.
     */
    @Test
    public void repairActiveProviderSkipsCliLoginMode() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(
                createConfigWithCurrent(ProviderManager.CLI_LOGIN_PROVIDER_ID));
        ProviderManager manager = createProviderManager(configRef);

        boolean changed = manager.repairActiveProviderToClaudeSettings();

        assertFalse("CLI login provider must skip repair", changed);
    }

    /**
     * Disabled mode (persisted as an explicitly blank current id) must skip
     * startup repair — there is no active provider to repair from.
     */
    @Test
    public void repairActiveProviderSkipsDisabledMode() throws Exception {
        AtomicReference<JsonObject> configRef = new AtomicReference<>(createConfigWithCurrent(""));
        ProviderManager manager = createProviderManager(configRef);

        boolean changed = manager.repairActiveProviderToClaudeSettings();

        assertFalse("Disabled (blank current) must skip repair", changed);
    }

    /**
     * A provider with an empty {@code settingsConfig.env} payload is incomplete
     * state (same invariant as {@link ClaudeSettingsSyncPlan}) and must skip
     * startup repair — it must not stamp model / provider id into settings.json.
     */
    @Test
    public void repairActiveProviderSkipsEmptyEnvProvider() throws Exception {
        JsonObject config = createConfigWithCurrent("provider-a");
        // createProvider() adds an empty settingsConfig with no env payload.
        config.getAsJsonObject("claude")
                .getAsJsonObject("providers")
                .add("provider-a", createProvider("Provider A"));
        AtomicReference<JsonObject> configRef = new AtomicReference<>(config);
        ProviderManager manager = createProviderManager(configRef);

        boolean changed = manager.repairActiveProviderToClaudeSettings();

        assertFalse("Provider with empty env payload must skip repair", changed);
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
