package com.github.claudecodegui.clawbot;

import org.junit.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class ClawBotSenderAccessStoreTest {

    @Test
    public void deniesByDefaultAndPersistsExplicitSenderAuthorization() throws Exception {
        FakeBackend backend = new FakeBackend();
        ClawBotSenderAccessStore store = new ClawBotSenderAccessStore(backend);

        assertFalse(store.isAllowed("sender-1"));
        store.allow("sender-1");

        ClawBotSenderAccessStore reloaded = new ClawBotSenderAccessStore(backend);
        assertTrue(reloaded.isAllowed("sender-1"));
        assertEquals(1, reloaded.count());
        assertFalse(backend.values.toString().contains("message text"));
    }

    @Test
    public void revokeAndClearRemoveAuthorizedSenders() throws Exception {
        FakeBackend backend = new FakeBackend();
        ClawBotSenderAccessStore store = new ClawBotSenderAccessStore(backend);
        store.allow("sender-1");
        store.allow("sender-2");

        store.revoke("sender-1");
        assertFalse(store.isAllowed("sender-1"));
        assertTrue(store.isAllowed("sender-2"));

        store.clear();
        assertEquals(0, store.count());
        assertFalse(new ClawBotSenderAccessStore(backend).isAllowed("sender-2"));
    }

    @Test
    public void rejectsInvalidIdsWithoutChangingTheAllowlist() {
        FakeBackend backend = new FakeBackend();
        ClawBotSenderAccessStore store = new ClawBotSenderAccessStore(backend);

        assertThrows(IOException.class, () -> store.allow("bad\nidentity"));
        assertFalse(store.isAllowed("bad\nidentity"));
        assertTrue(backend.values.isEmpty());
    }

    @Test
    public void clearFailureFailsClosedAndReportsStoreUnavailable() throws Exception {
        FakeBackend backend = new FakeBackend();
        ClawBotSenderAccessStore store = new ClawBotSenderAccessStore(backend);
        store.allow("sender-1");
        backend.failClear = true;

        assertThrows(IOException.class, store::clear);
        assertFalse(store.isAllowed("sender-1"));
        assertFalse(store.available());

        backend.failClear = false;
        store.clear();
        assertTrue(store.available());
        assertFalse(new ClawBotSenderAccessStore(backend).isAllowed("sender-1"));
    }

    @Test
    public void persistsLastUseSeparatelyAndRemovesItOnRevoke() throws Exception {
        FakeBackend backend = new FakeBackend();
        ClawBotSenderAccessStore store = new ClawBotSenderAccessStore(backend);
        store.allow("sender-1");
        store.allow("sender-2");
        store.recordUse("sender-1");

        ClawBotSenderAccessStore reloaded = new ClawBotSenderAccessStore(backend);
        ClawBotSenderAccessStore.SenderPage page = reloaded.page(0);
        assertTrue(page.lastUsedAt().get("sender-1") > 0L);
        assertFalse(page.lastUsedAt().containsKey("sender-2"));
        assertFalse(backend.values.get("allowed-sender-last-used").contains("message text"));

        reloaded.revoke("sender-1");
        assertFalse(new ClawBotSenderAccessStore(backend).page(0).lastUsedAt().containsKey("sender-1"));
    }

    @Test
    public void usageMetadataWriteFailureDoesNotRevokeSenderAccess() throws Exception {
        FakeBackend backend = new FakeBackend();
        ClawBotSenderAccessStore store = new ClawBotSenderAccessStore(backend);
        store.allow("sender-1");
        backend.failUsageWrite = true;

        store.recordUse("sender-1");

        assertTrue(store.isAllowed("sender-1"));
        assertTrue(store.page(0).lastUsedAt().isEmpty());
    }

    private static final class FakeBackend implements ClawBotCredentialStore.SecretBackend {

        private final Map<String, String> values = new HashMap<>();
        private boolean failClear;
        private boolean failUsageWrite;

        @Override
        public String read(String key) {
            return values.get(key);
        }

        @Override
        public void write(String key, String value) {
            if (failUsageWrite && "allowed-sender-last-used".equals(key)) {
                throw new IllegalStateException("usage write failed");
            }
            values.put(key, value);
        }

        @Override
        public void clear(String key) {
            if (failClear) {
                throw new IllegalStateException("clear failed");
            }
            values.remove(key);
        }
    }
}
