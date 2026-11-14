package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.UncheckedIOException;
import java.nio.file.AccessDeniedException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * Provider reads must only persist changes when normalization actually repairs the configuration.
 */
public class ProviderManagerNormalizationTest {
    @Test
    public void explicitEmptyCurrentDoesNotRewriteConfig() {
        JsonObject config = createConfig("");
        JsonObject codex = new JsonObject();
        codex.addProperty("current", "codex-provider");
        config.add("codex", codex);
        config.addProperty("unrelatedSetting", "preserved");
        Fixture fixture = new Fixture(config);

        fixture.assertDisabledWithWrites(0);

        assertEquals(config, fixture.config.get());
    }

    @Test
    public void explicitEmptyCurrentWithSavedProvidersStaysDisabled() {
        JsonObject config = createConfig("");
        addSavedProviders(config);
        Fixture fixture = new Fixture(config);

        fixture.assertDisabledWithWrites(0);

        assertEquals(4, fixture.manager.getClaudeProviders().size());
        assertEquals(config, fixture.config.get());
    }

    @Test
    public void repeatedDisabledProviderReadsDoNotWriteConfig() {
        Fixture fixture = new Fixture(createConfig(""));

        for (int i = 0; i < 1000; i++) {
            fixture.assertDisabledWithWrites(0);
        }
    }

    @Test
    public void disabledProviderReadsDoNotAttemptDeniedConfigReplacement() {
        Fixture fixture = new Fixture(createConfig(""));
        fixture.rejectWrites = true;

        fixture.assertDisabledWithWrites(0);
    }

    @Test
    public void localSettingsSelectionDoesNotRewriteConfig() {
        assertSelectionIsReadOnly(ProviderManager.LOCAL_SETTINGS_PROVIDER_ID);
    }

    @Test
    public void cliLoginSelectionDoesNotRewriteConfig() {
        assertSelectionIsReadOnly(ProviderManager.CLI_LOGIN_PROVIDER_ID);
    }

    @Test
    public void savedProviderSelectionDoesNotRewriteConfig() {
        JsonObject config = createConfig("provider-a");
        addSavedProviders(config);
        Fixture fixture = new Fixture(config);

        JsonObject activeProvider = fixture.manager.getActiveClaudeProvider();
        fixture.manager.getClaudeProviders();

        assertNotNull(activeProvider);
        assertEquals("provider-a", activeProvider.get("id").getAsString());
        assertEquals(0, fixture.writes.get());
        assertEquals(config, fixture.config.get());
    }

    @Test
    public void staleSelectionIsClearedOnlyOnce() {
        JsonObject config = createConfig("deleted-provider");
        addSavedProviders(config);
        Fixture fixture = new Fixture(config);

        fixture.assertDisabledWithWrites(1);
        fixture.assertDisabledWithWrites(1);
    }

    @Test
    public void missingCurrentSelectsFirstSavedProviderOnlyOnce() {
        JsonObject config = createConfig("");
        config.getAsJsonObject("claude").remove("current");

        assertFirstSavedProviderIsSelected(config);
    }

    @Test
    public void nullCurrentSelectsFirstSavedProviderOnlyOnce() {
        JsonObject config = createConfig("");
        config.getAsJsonObject("claude").add("current", JsonNull.INSTANCE);

        assertFirstSavedProviderIsSelected(config);
    }

    @Test
    public void missingCurrentWithoutProvidersIsInitializedOnlyOnce() {
        JsonObject config = createConfig("");
        config.getAsJsonObject("claude").remove("current");
        Fixture fixture = new Fixture(config);

        fixture.assertDisabledWithWrites(1);
        fixture.assertDisabledWithWrites(1);
    }

    @Test
    public void nullCurrentWithoutProvidersIsInitializedOnlyOnce() {
        JsonObject config = createConfig("");
        config.getAsJsonObject("claude").add("current", JsonNull.INSTANCE);
        Fixture fixture = new Fixture(config);

        fixture.assertDisabledWithWrites(1);
        fixture.assertDisabledWithWrites(1);
    }

    @Test
    public void missingOrNullClaudeSchemaIsInitializedOnlyOnce() {
        for (boolean explicitNull : new boolean[]{false, true}) {
            JsonObject config = new JsonObject();
            if (explicitNull) {
                config.add("claude", JsonNull.INSTANCE);
            }
            Fixture fixture = new Fixture(config);

            fixture.manager.getClaudeProviders();
            fixture.assertDisabledWithWrites(1);
            assertEquals(0, fixture.config.get().getAsJsonObject("claude")
                    .getAsJsonObject("providers").size());
        }
    }

    @Test
    public void missingOrNullProvidersAreInitializedOnlyOnce() {
        for (boolean explicitNull : new boolean[]{false, true}) {
            JsonObject config = createConfig("");
            JsonObject claude = config.getAsJsonObject("claude");
            if (explicitNull) {
                claude.add("providers", JsonNull.INSTANCE);
            } else {
                claude.remove("providers");
            }
            Fixture fixture = new Fixture(config);

            fixture.manager.getClaudeProviders();
            fixture.assertDisabledWithWrites(1);
            assertEquals(0, fixture.config.get().getAsJsonObject("claude")
                    .getAsJsonObject("providers").size());
        }
    }

    @Test
    public void necessaryConfigWritesStillPropagateAccessDenied() {
        Fixture fixture = new Fixture(createConfig("deleted-provider"));
        fixture.rejectWrites = true;

        UncheckedIOException failure = assertThrows(
                UncheckedIOException.class, () -> fixture.manager.getActiveClaudeProvider());

        assertTrue(failure.getCause() instanceof AccessDeniedException);
        assertEquals(1, fixture.writes.get());
        assertEquals("deleted-provider", fixture.config.get().getAsJsonObject("claude")
                .get("current").getAsString());
    }

    @Test
    public void readsAfterDeactivationDoNotWriteConfigAgain() throws Exception {
        JsonObject config = createConfig("provider-a");
        addSavedProviders(config);
        Fixture fixture = new Fixture(config);

        fixture.manager.deactivateClaudeProvider();

        fixture.assertDisabledWithWrites(1);
        fixture.assertDisabledWithWrites(1);
    }

    private void assertSelectionIsReadOnly(String current) {
        JsonObject config = createConfig(current);
        Fixture fixture = new Fixture(config);

        JsonObject activeProvider = fixture.manager.getActiveClaudeProvider();
        fixture.manager.getClaudeProviders();

        assertNotNull(activeProvider);
        assertEquals(current, activeProvider.get("id").getAsString());
        assertEquals(0, fixture.writes.get());
        assertEquals(config, fixture.config.get());
    }

    private void assertFirstSavedProviderIsSelected(JsonObject config) {
        addSavedProviders(config);
        Fixture fixture = new Fixture(config);

        fixture.manager.getClaudeProviders();
        JsonObject activeProvider = fixture.manager.getActiveClaudeProvider();

        assertNotNull(activeProvider);
        assertEquals("provider-a", activeProvider.get("id").getAsString());
        assertEquals("provider-a", fixture.config.get().getAsJsonObject("claude")
                .get("current").getAsString());
        assertEquals(1, fixture.writes.get());
    }

    private JsonObject createConfig(String current) {
        JsonObject config = new JsonObject();
        JsonObject claude = new JsonObject();
        claude.addProperty("current", current);
        claude.add("providers", new JsonObject());
        config.add("claude", claude);
        return config;
    }

    private void addSavedProviders(JsonObject config) {
        JsonObject providers = config.getAsJsonObject("claude").getAsJsonObject("providers");
        for (String id : new String[]{"provider-a", "provider-b"}) {
            JsonObject provider = new JsonObject();
            provider.addProperty("name", id);
            provider.add("settingsConfig", new JsonObject());
            providers.add(id, provider);
        }
    }

    /**
     * Model independent config reads and count writes without touching the user's filesystem.
     */
    private static final class Fixture {
        private final AtomicReference<JsonObject> config;
        private final AtomicInteger writes = new AtomicInteger();
        private final ProviderManager manager;
        private boolean rejectWrites;

        private Fixture(JsonObject initialConfig) {
            config = new AtomicReference<>(initialConfig.deepCopy());
            Gson gson = new Gson();
            ClaudeSettingsManager settingsManager = new ClaudeSettingsManager(gson, null) {
                @Override
                public JsonObject readClaudeSettings() {
                    JsonObject settings = new JsonObject();
                    settings.add("env", new JsonObject());
                    return settings;
                }
            };
            manager = new ProviderManager(
                    gson,
                    ignored -> config.get().deepCopy(),
                    updated -> {
                        writes.incrementAndGet();
                        if (rejectWrites) {
                            throw new UncheckedIOException(
                                    new AccessDeniedException("config.json.tmp", "config.json", "Simulated denied replacement"));
                        }
                        config.set(updated.deepCopy());
                    },
                    null,
                    settingsManager);
        }

        private void assertDisabledWithWrites(int expectedWrites) {
            assertNull(manager.getActiveClaudeProvider());
            for (JsonObject provider : manager.getClaudeProviders()) {
                assertFalse(provider.get("isActive").getAsBoolean());
            }
            assertEquals("", config.get().getAsJsonObject("claude").get("current").getAsString());
            assertEquals(expectedWrites, writes.get());
        }
    }
}
