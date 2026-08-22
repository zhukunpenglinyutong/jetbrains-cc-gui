package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class CodexProviderManagerCredentialTest {

    @Test
    public void newCredentialIsStoredOutsideConfigAndHydratedOnRead() throws Exception {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        FakeCredentialStore credentials = new FakeCredentialStore();
        CodexProviderManager manager = manager(config, credentials);
        JsonObject provider = provider("provider-secret");
        provider.addProperty("authJson", "{\"OPENAI_API_KEY\":\"secret\"}");

        manager.addCodexProvider(provider);

        JsonObject persisted = provider(config, "provider-secret");
        assertFalse(persisted.has("authJson"));
        assertTrue(persisted.get("authStoredInPasswordSafe").getAsBoolean());
        JsonObject hydrated = manager.getCodexProviders().stream()
                .filter(candidate -> "provider-secret".equals(candidate.get("id").getAsString()))
                .findFirst()
                .orElseThrow();
        assertEquals("{\"OPENAI_API_KEY\":\"secret\"}", hydrated.get("authJson").getAsString());
    }

    @Test
    public void recoversCredentialWhenOlderUpdateLostPasswordSafeMarker() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authJson", "");
        FakeCredentialStore credentials = new FakeCredentialStore();
        credentials.values.put("provider-a", "{\"OPENAI_API_KEY\":\"recovered\"}");

        JsonObject returned = manager(config, credentials).getCodexProviders().stream()
                .filter(candidate -> "provider-a".equals(candidate.get("id").getAsString()))
                .findFirst()
                .orElseThrow();

        assertEquals("{\"OPENAI_API_KEY\":\"recovered\"}", returned.get("authJson").getAsString());
        assertTrue(provider(config, "provider-a").get("authStoredInPasswordSafe").getAsBoolean());
        assertFalse(provider(config, "provider-a").has("authJson"));
    }

    @Test
    public void unavailableCredentialIsNotDeletedWhenUpdatingOtherFields() throws Exception {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authStoredInPasswordSafe", true);
        config.get().getAsJsonObject("codex").addProperty("current", "provider-a");
        FakeCredentialStore credentials = new FakeCredentialStore();
        JsonObject updates = new JsonObject();
        updates.addProperty("name", "Renamed Provider");
        updates.addProperty("authJson", "");

        manager(config, credentials).updateCodexProvider("provider-a", updates);

        JsonObject persisted = provider(config, "provider-a");
        assertEquals("Renamed Provider", persisted.get("name").getAsString());
        assertTrue(persisted.get("authStoredInPasswordSafe").getAsBoolean());
        assertFalse(persisted.has("authJson"));
        assertEquals(0, credentials.deleteAttempts);
    }

    @Test
    public void availableCredentialCanBeExplicitlyCleared() throws Exception {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authStoredInPasswordSafe", true);
        FakeCredentialStore credentials = new FakeCredentialStore();
        credentials.values.put("provider-a", "{\"OPENAI_API_KEY\":\"old\"}");
        JsonObject updates = new JsonObject();
        updates.addProperty("authJson", "");

        manager(config, credentials).updateCodexProvider("provider-a", updates);

        JsonObject persisted = provider(config, "provider-a");
        assertFalse(persisted.has("authStoredInPasswordSafe"));
        assertFalse(persisted.has("authJson"));
        assertEquals(1, credentials.deleteAttempts);
    }

    @Test
    public void configWriteFailureRestoresPreviousCredential() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authStoredInPasswordSafe", true);
        FakeCredentialStore credentials = new FakeCredentialStore();
        credentials.values.put("provider-a", "{\"OPENAI_API_KEY\":\"old\"}");
        CodexProviderManager manager = manager(config, ignored -> {
            throw new IllegalStateException("config write failed");
        }, credentials);
        JsonObject updates = new JsonObject();
        updates.addProperty("authJson", "{\"OPENAI_API_KEY\":\"new\"}");

        assertThrows(IOException.class, () -> manager.updateCodexProvider("provider-a", updates));
        assertEquals("{\"OPENAI_API_KEY\":\"old\"}", credentials.read("provider-a"));
    }

    @Test
    public void unavailableCredentialBlocksProviderSwitch() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authStoredInPasswordSafe", true);

        assertThrows(IOException.class,
                () -> manager(config, new FakeCredentialStore()).switchCodexProvider("provider-a"));
    }

    private CodexProviderManager manager(
            AtomicReference<JsonObject> config,
            CodexProviderCredentialStore credentials) {
        return manager(config, config::set, credentials);
    }

    private CodexProviderManager manager(
            AtomicReference<JsonObject> config,
            Consumer<JsonObject> configWriter,
            CodexProviderCredentialStore credentials) {
        Gson gson = new Gson();
        return new CodexProviderManager(
                ignored -> config.get().deepCopy(),
                configWriter,
                new ConfigPathManager(),
                new CodexSettingsManager(gson),
                credentials);
    }

    private JsonObject configWithProvider() {
        JsonObject providers = new JsonObject();
        providers.add("provider-a", provider("provider-a"));
        JsonObject codex = new JsonObject();
        codex.addProperty("current", "");
        codex.add("providers", providers);
        JsonObject config = new JsonObject();
        config.add("codex", codex);
        return config;
    }

    private JsonObject provider(AtomicReference<JsonObject> config, String id) {
        return config.get().getAsJsonObject("codex").getAsJsonObject("providers").getAsJsonObject(id);
    }

    private JsonObject provider(String id) {
        JsonObject provider = new JsonObject();
        provider.addProperty("id", id);
        provider.addProperty("name", "Provider");
        return provider;
    }

    private static final class FakeCredentialStore extends CodexProviderCredentialStore {
        private final Map<String, String> values = new HashMap<>();
        private int deleteAttempts;

        @Override
        public boolean isPersistentStorageAvailable() {
            return true;
        }

        @Override
        public boolean writeVerified(String providerId, String authJson) {
            values.put(providerId, authJson);
            return authJson.equals(read(providerId));
        }

        @Override
        public String read(String providerId) {
            return values.get(providerId);
        }

        @Override
        public void delete(String providerId) {
            values.remove(providerId);
        }

        @Override
        public boolean deleteVerified(String providerId) {
            deleteAttempts++;
            values.remove(providerId);
            return true;
        }
    }
}
