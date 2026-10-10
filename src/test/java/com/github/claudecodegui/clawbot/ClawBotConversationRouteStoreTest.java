package com.github.claudecodegui.clawbot;

import org.junit.Test;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class ClawBotConversationRouteStoreTest {

    @Test
    public void persistsSenderRoutesWithoutWritingThemToPlaintextState() throws Exception {
        FakeBackend backend = new FakeBackend();
        ClawBotConversationRouteStore store = new ClawBotConversationRouteStore(backend);
        Map<String, String> routes = Map.of("sender-1", "session-1");

        store.save(routes);

        assertEquals(routes, new ClawBotConversationRouteStore(backend).load());
        assertTrue(backend.values.containsKey("conversation-routes"));
    }

    @Test
    public void rejectsCorruptStoredRoutePayload() {
        FakeBackend backend = new FakeBackend();
        backend.values.put("conversation-routes", "not-json");

        assertThrows(IOException.class, () -> new ClawBotConversationRouteStore(backend).load());
    }

    @Test
    public void clearRemovesPersistedRoutes() throws Exception {
        FakeBackend backend = new FakeBackend();
        ClawBotConversationRouteStore store = new ClawBotConversationRouteStore(backend);
        store.save(Map.of("sender-1", "session-1"));

        store.clear();

        assertTrue(store.load().isEmpty());
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
