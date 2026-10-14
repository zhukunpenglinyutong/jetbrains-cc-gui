package com.github.claudecodegui.clawbot;

import org.junit.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClawBotBindingHandoffTest {

    @Test
    public void acceptsPairingResultAndReturnsOnlySanitizedState() {
        FakeBackend backend = new FakeBackend();
        ClawBotBindingHandoff handoff = newHandoff(backend);

        ClawBotBindingHandoff.BindingSnapshot snapshot = handoff.accept(
                "fixture-bot", "https://ROUTE-1.weixin.qq.com/", "fixture-user", "fixture-token");

        assertEquals("BOUND", snapshot.state());
        assertEquals("https://route-1.weixin.qq.com", snapshot.baseUrl());
        assertEquals(1L, snapshot.revision());
        assertEquals("fixture-token", backend.values.get(ClawBotCredentialStore.DEFAULT_BINDING_KEY));
        assertFalse(snapshot.toString().contains("fixture-token"));
    }

    @Test
    public void restoresRouteAndRevisionFromNonSecretMetadata() {
        FakeBackend backend = new FakeBackend();
        FakeMetadataBackend metadata = new FakeMetadataBackend();
        ClawBotBindingHandoff first = newHandoff(backend, metadata);
        first.accept("fixture-bot", "https://route-1.weixin.qq.com", "fixture-user", "fixture-token");

        ClawBotBindingHandoff restarted = newHandoff(backend, metadata);
        ClawBotBindingHandoff.BindingSnapshot snapshot = restarted.status();

        assertEquals("BOUND", snapshot.state());
        assertEquals("https://route-1.weixin.qq.com", snapshot.baseUrl());
        assertEquals(1L, snapshot.revision());
    }

    @Test
    public void acceptsPairingResultWithoutOptionalUserId() {
        FakeBackend backend = new FakeBackend();
        ClawBotBindingHandoff handoff = newHandoff(backend);

        ClawBotBindingHandoff.BindingSnapshot snapshot = handoff.accept(
                "fixture-bot", "https://ilinkai.weixin.qq.com", null, "fixture-token");

        assertEquals("BOUND", snapshot.state());
        assertEquals("https://ilinkai.weixin.qq.com", snapshot.baseUrl());
        assertEquals("fixture-token", backend.values.get(ClawBotCredentialStore.DEFAULT_BINDING_KEY));
    }

    @Test
    public void statusRecoversBoundStateFromStoredTokenWithoutExposingIt() {
        FakeBackend backend = new FakeBackend();
        backend.values.put(ClawBotCredentialStore.DEFAULT_BINDING_KEY, "fixture-token");
        ClawBotBindingHandoff handoff = newHandoff(backend);

        ClawBotBindingHandoff.BindingSnapshot snapshot = handoff.status();

        assertEquals("BOUND", snapshot.state());
        assertEquals("https://ilinkai.weixin.qq.com", snapshot.baseUrl());
        assertFalse(snapshot.toString().contains("fixture-token"));
        assertEquals("LEGACY_METADATA_MISSING", snapshot.diagnostic());
    }

    @Test
    public void clearRemovesTokenAndMovesBackToUnbound() {
        FakeBackend backend = new FakeBackend();
        ClawBotBindingHandoff handoff = newHandoff(backend);
        handoff.accept("fixture-bot", "https://ilinkai.weixin.qq.com", "fixture-user", "fixture-token");

        ClawBotBindingHandoff.BindingSnapshot snapshot = handoff.clear();

        assertEquals("UNBOUND", snapshot.state());
        assertTrue(snapshot.baseUrl() == null);
        assertTrue(backend.values.isEmpty());
    }

    @Test
    public void missingPersistedTokenRemainsUnknownUntilExplicitCleanup() {
        FakeBackend backend = new FakeBackend();
        ClawBotBindingHandoff handoff = newHandoff(backend);
        handoff.accept("fixture-bot", "https://ilinkai.weixin.qq.com", "fixture-user", "fixture-token");
        backend.clear(ClawBotCredentialStore.DEFAULT_BINDING_KEY);

        ClawBotBindingHandoff.BindingSnapshot unknown = handoff.status();
        assertEquals("UNKNOWN", unknown.state());
        assertEquals("BOUND_TOKEN_MISSING", unknown.diagnostic());
        assertTrue(handoff.runtimeCredentials().isEmpty());
        assertEquals("UNBOUND", handoff.clear().state());
        assertEquals("UNBOUND", handoff.status().state());
    }

    @Test
    public void reportsPasswordSafeFailureWithoutThrowingOrChangingItToUnbound() {
        FakeBackend backend = new FakeBackend();
        backend.readUnavailable = true;
        ClawBotBindingHandoff handoff = newHandoff(backend);

        ClawBotBindingHandoff.BindingSnapshot snapshot = handoff.status();

        assertEquals("UNKNOWN", snapshot.state());
        assertEquals("PASSWORD_SAFE_UNAVAILABLE", snapshot.diagnostic());
    }

    @Test
    public void reportsInvalidBindingMetadataInsteadOfTreatingItAsUnbound() {
        FakeBackend backend = new FakeBackend();
        FakeMetadataBackend metadata = new FakeMetadataBackend();
        metadata.values.put("ccgui.clawbot.binding.metadata", "not-json");
        ClawBotBindingHandoff handoff = newHandoff(backend, metadata);

        ClawBotBindingHandoff.BindingSnapshot snapshot = handoff.status();

        assertEquals("UNKNOWN", snapshot.state());
        assertEquals("BINDING_METADATA_INVALID", snapshot.diagnostic());
    }

    @Test
    public void reportsMetadataStoreFailureWithoutFailingStatusRead() {
        FakeBackend backend = new FakeBackend();
        FakeMetadataBackend metadata = new FakeMetadataBackend();
        metadata.readUnavailable = true;
        ClawBotBindingHandoff handoff = newHandoff(backend, metadata);

        ClawBotBindingHandoff.BindingSnapshot snapshot = handoff.status();

        assertEquals("UNKNOWN", snapshot.state());
        assertEquals("BINDING_METADATA_UNAVAILABLE", snapshot.diagnostic());
    }

    @Test
    public void rejectsUnapprovedBindingInputsBeforeWritingSecret() {
        FakeBackend backend = new FakeBackend();
        ClawBotBindingHandoff handoff = newHandoff(backend);

        assertInvalid(() -> handoff.accept(
                "fixture-bot", "https://attacker.example", "fixture-user", "fixture-token"));
        assertInvalid(() -> handoff.accept(
                "fixture-bot", "http://ilinkai.weixin.qq.com", "fixture-user", "fixture-token"));
        assertInvalid(() -> handoff.accept(
                "fixture-bot", "https://ilinkai.weixin.qq.com", "user\nvalue", "fixture-token"));
        assertTrue(backend.values.isEmpty());
    }

    private static void assertInvalid(Runnable action) {
        try {
            action.run();
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("Expected binding input to be rejected");
    }

    private static ClawBotBindingHandoff newHandoff(FakeBackend backend) {
        return newHandoff(backend, new FakeMetadataBackend());
    }

    private static ClawBotBindingHandoff newHandoff(
            FakeBackend backend, FakeMetadataBackend metadata) {
        return new ClawBotBindingHandoff(
                new ClawBotCredentialStore(backend), new ClawBotBindingMetadataStore(metadata));
    }

    private static final class FakeBackend implements ClawBotCredentialStore.SecretBackend {

        private final Map<String, String> values = new HashMap<>();
        private boolean readUnavailable;

        @Override
        public String read(String key) {
            if (readUnavailable) {
                throw new IllegalStateException("credential backend unavailable");
            }
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

    private static final class FakeMetadataBackend implements ClawBotBindingMetadataStore.MetadataBackend {

        private final Map<String, String> values = new HashMap<>();
        private boolean readUnavailable;

        @Override
        public String read(String key) {
            if (readUnavailable) {
                throw new IllegalStateException("metadata backend unavailable");
            }
            return values.get(key);
        }

        @Override
        public void write(String key, String value) {
            values.put(key, value);
        }
    }
}
