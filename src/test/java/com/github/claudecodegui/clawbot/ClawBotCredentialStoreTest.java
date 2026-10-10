package com.github.claudecodegui.clawbot;

import com.intellij.credentialStore.CredentialAttributes;
import com.intellij.credentialStore.CredentialStore;
import com.intellij.credentialStore.Credentials;
import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClawBotCredentialStoreTest {

    @Test
    public void authorizingAndSelectingSessionsMustNotOverwriteBindingToken() throws Exception {
        ServiceNameCredentialStore passwordSafe = new ServiceNameCredentialStore();
        ClawBotCredentialStore store = new ClawBotCredentialStore(new ClawBotCredentialStore.PasswordSafeBackend(passwordSafe));
        ClawBotSenderAccessStore senders = new ClawBotSenderAccessStore(new ClawBotCredentialStore.PasswordSafeBackend(passwordSafe));
        ClawBotConversationRouteStore routes = new ClawBotConversationRouteStore(new ClawBotCredentialStore.PasswordSafeBackend(passwordSafe));

        store.saveBotToken("fixture-token");
        senders.allow("fixture-sender");
        routes.save(Map.of("fixture-sender", "fixture-session"));

        assertEquals("fixture-token", store.loadBotToken().orElseThrow());
        assertTrue(new ClawBotSenderAccessStore(new ClawBotCredentialStore.PasswordSafeBackend(passwordSafe)).isAllowed("fixture-sender"));
        assertEquals(Map.of("fixture-sender", "fixture-session"), routes.load());
        routes.clear();
        assertEquals("fixture-token", store.loadBotToken().orElseThrow());
        senders.clear();
        assertEquals("fixture-token", store.loadBotToken().orElseThrow());
    }

    @Test
    public void migratesOnlyTheLegacyEntryWithMatchingIdentity() {
        ServiceNameCredentialStore passwordSafe = new ServiceNameCredentialStore();
        passwordSafe.set(new CredentialAttributes(ClawBotCredentialStore.SERVICE_NAME, "conversation-routes"),
                new Credentials("conversation-routes", "{}"));
        ClawBotCredentialStore.PasswordSafeBackend backend = new ClawBotCredentialStore.PasswordSafeBackend(passwordSafe);

        assertTrue(new ClawBotCredentialStore(backend).loadBotToken().isEmpty());
        assertEquals("{}", backend.read("conversation-routes"));
        assertTrue(passwordSafe.get(new CredentialAttributes(ClawBotCredentialStore.SERVICE_NAME)) == null);
        assertEquals("{}", backend.read("conversation-routes"));
        backend.clear("conversation-routes");
        assertTrue(backend.read("conversation-routes") == null);
    }

    @Test
    public void migratesSurvivingLegacyTokenAndKeepsItAfterAuthorizationChanges() {
        ServiceNameCredentialStore passwordSafe = new ServiceNameCredentialStore();
        passwordSafe.set(new CredentialAttributes(ClawBotCredentialStore.SERVICE_NAME, "default"),
                new Credentials("default", "legacy-fixture-token"));
        ClawBotCredentialStore.PasswordSafeBackend backend = new ClawBotCredentialStore.PasswordSafeBackend(passwordSafe);

        assertEquals("legacy-fixture-token", backend.read("default"));
        backend.write("allowed-senders", "[]");
        backend.write("conversation-routes", "{}");
        assertEquals("legacy-fixture-token", backend.read("default"));
        backend.clear("default");
        assertTrue(backend.read("default") == null);
        assertEquals("[]", backend.read("allowed-senders"));
        assertEquals("{}", backend.read("conversation-routes"));
    }

    @Test
    public void clearingAnotherKeyDoesNotDeleteSurvivingLegacyCredentials() {
        ServiceNameCredentialStore passwordSafe = new ServiceNameCredentialStore();
        passwordSafe.set(new CredentialAttributes(ClawBotCredentialStore.SERVICE_NAME, "default"),
                new Credentials("default", "legacy-fixture-token"));
        ClawBotCredentialStore.PasswordSafeBackend backend = new ClawBotCredentialStore.PasswordSafeBackend(passwordSafe);

        backend.clear("allowed-senders");
        backend.clear("conversation-routes");
        assertEquals("legacy-fixture-token", backend.read("default"));
    }

    @Test
    public void clearingLegacyEntryPreventsRestoringItOnNextRead() {
        ServiceNameCredentialStore passwordSafe = new ServiceNameCredentialStore();
        passwordSafe.set(new CredentialAttributes(ClawBotCredentialStore.SERVICE_NAME, "default"),
                new Credentials("default", "legacy-fixture-token"));
        ClawBotCredentialStore.PasswordSafeBackend backend = new ClawBotCredentialStore.PasswordSafeBackend(passwordSafe);

        backend.clear("default");
        assertTrue(backend.read("default") == null);
    }

    @Test
    public void savesAndLoadsOnlyTheActiveBindingToken() {
        FakeBackend backend = new FakeBackend();
        ClawBotCredentialStore store = new ClawBotCredentialStore(backend);

        store.saveBotToken("fixture-token");

        assertEquals("fixture-token", store.loadBotToken().orElseThrow());
        assertEquals(Map.of(ClawBotCredentialStore.DEFAULT_BINDING_KEY, "fixture-token"), backend.values);
    }

    @Test
    public void clearRemovesTheActiveBindingToken() {
        FakeBackend backend = new FakeBackend();
        ClawBotCredentialStore store = new ClawBotCredentialStore(backend);
        store.saveBotToken("fixture-token");

        store.clearBotToken();

        assertTrue(store.loadBotToken().isEmpty());
        assertTrue(backend.values.isEmpty());
    }

    @Test
    public void missingOrEmptyBackendValuesAreUnbound() {
        ClawBotCredentialStore store = new ClawBotCredentialStore(new FakeBackend());

        assertFalse(store.loadBotToken().isPresent());
    }

    @Test
    public void rejectsInvalidTokensWithoutWritingThem() {
        FakeBackend backend = new FakeBackend();
        ClawBotCredentialStore store = new ClawBotCredentialStore(backend);

        assertInvalid(store, null);
        assertInvalid(store, "");
        assertInvalid(store, "bad\nsecret");
        assertTrue(backend.values.isEmpty());
    }

    private static void assertInvalid(ClawBotCredentialStore store, String token) {
        try {
            store.saveBotToken(token);
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("Expected invalid credential to be rejected");
    }

    private static final class ServiceNameCredentialStore implements CredentialStore {

        private final Map<String, Credentials> entries = new HashMap<>();

        @Override
        public Credentials get(CredentialAttributes attributes) {
            Credentials credentials = entries.get(attributes.getServiceName());
            return credentials != null && (attributes.getUserName() == null
                    || attributes.getUserName().equals(credentials.getUserName())) ? credentials : null;
        }

        @Override
        public void set(CredentialAttributes attributes, Credentials credentials) {
            if (credentials != null) {
                entries.put(attributes.getServiceName(), credentials);
            } else if (get(attributes) != null) {
                entries.remove(attributes.getServiceName());
            }
        }
    }

    private static final class FakeBackend implements ClawBotCredentialStore.SecretBackend {

        private final Map<String, String> values = new HashMap<>();

        @Override
        public String read(String key) {
            return values.get(key);
        }

        @Override
        public void write(String key, String value) {
            values.put(key, value);
        }

        @Override
        public void clear(String key) {
            values.remove(key);
        }
    }
}
