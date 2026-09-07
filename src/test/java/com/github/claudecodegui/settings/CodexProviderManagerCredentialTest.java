package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Provider auth (authJson) is stored inline in ~/.codemoss/config.json.
 * Keychain/PasswordSafe storage was removed before release because macOS shows
 * a scary keychain-access prompt; these tests pin the inline-storage behavior.
 */
public class CodexProviderManagerCredentialTest {

    @Test
    public void newCredentialStaysInlineInConfigAndIsReturnedOnRead() throws Exception {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        CodexProviderManager manager = manager(config);
        JsonObject provider = provider("provider-secret");
        provider.addProperty("authJson", "{\"OPENAI_API_KEY\":\"secret\"}");

        manager.addCodexProvider(provider);

        JsonObject persisted = provider(config, "provider-secret");
        assertEquals("{\"OPENAI_API_KEY\":\"secret\"}", persisted.get("authJson").getAsString());
        JsonObject listed = manager.getCodexProviders().stream()
                .filter(candidate -> "provider-secret".equals(candidate.get("id").getAsString()))
                .findFirst()
                .orElseThrow();
        assertEquals("{\"OPENAI_API_KEY\":\"secret\"}", listed.get("authJson").getAsString());
    }

    @Test
    public void updatingOtherFieldsKeepsInlineCredential() throws Exception {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authJson", "{\"OPENAI_API_KEY\":\"secret\"}");
        JsonObject updates = new JsonObject();
        updates.addProperty("name", "Renamed Provider");

        manager(config).updateCodexProvider("provider-a", updates);

        JsonObject persisted = provider(config, "provider-a");
        assertEquals("Renamed Provider", persisted.get("name").getAsString());
        assertEquals("{\"OPENAI_API_KEY\":\"secret\"}", persisted.get("authJson").getAsString());
    }

    @Test
    public void credentialCanBeExplicitlyCleared() throws Exception {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authJson", "{\"OPENAI_API_KEY\":\"old\"}");
        JsonObject updates = new JsonObject();
        updates.add("authJson", null);

        manager(config).updateCodexProvider("provider-a", updates);

        assertFalse(provider(config, "provider-a").has("authJson"));
    }

    @Test
    public void deletingProviderLeavesOtherCredentialsUntouched() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authJson", "{\"OPENAI_API_KEY\":\"a\"}");
        config.get().getAsJsonObject("codex").getAsJsonObject("providers")
                .add("provider-b", provider("provider-b"));
        provider(config, "provider-b").addProperty("authJson", "{\"OPENAI_API_KEY\":\"b\"}");

        assertTrue(manager(config).deleteCodexProvider("provider-a").isSuccess());

        JsonObject providers = config.get().getAsJsonObject("codex").getAsJsonObject("providers");
        assertFalse(providers.has("provider-a"));
        assertEquals("{\"OPENAI_API_KEY\":\"b\"}",
                providers.getAsJsonObject("provider-b").get("authJson").getAsString());
    }

    @Test
    public void legacyKeychainMarkersAreStrippedOnRead() {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        JsonObject legacy = provider(config, "provider-a");
        legacy.addProperty("authStoredInPasswordSafe", true);
        legacy.addProperty("credentialUnavailable", true);

        JsonObject listed = manager(config).getCodexProviders().stream()
                .filter(candidate -> "provider-a".equals(candidate.get("id").getAsString()))
                .findFirst()
                .orElseThrow();

        assertFalse(listed.has("authStoredInPasswordSafe"));
        assertFalse(listed.has("credentialUnavailable"));
        assertFalse(listed.has("authJson"));
    }

    @Test
    public void legacyKeychainMarkersAreStrippedOnSave() throws Exception {
        AtomicReference<JsonObject> config = new AtomicReference<>(configWithProvider());
        provider(config, "provider-a").addProperty("authStoredInPasswordSafe", true);
        JsonObject updates = new JsonObject();
        updates.addProperty("name", "Renamed Provider");
        updates.addProperty("authJson", "{\"OPENAI_API_KEY\":\"fresh\"}");

        manager(config).updateCodexProvider("provider-a", updates);

        JsonObject persisted = provider(config, "provider-a");
        assertFalse(persisted.has("authStoredInPasswordSafe"));
        assertEquals("{\"OPENAI_API_KEY\":\"fresh\"}", persisted.get("authJson").getAsString());
    }

    private CodexProviderManager manager(AtomicReference<JsonObject> config) {
        Gson gson = new Gson();
        return new CodexProviderManager(
                ignored -> config.get().deepCopy(),
                config::set,
                new ConfigPathManager(),
                new CodexSettingsManager(gson));
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
}
