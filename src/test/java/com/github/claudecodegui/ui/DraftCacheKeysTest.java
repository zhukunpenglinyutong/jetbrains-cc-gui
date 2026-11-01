package com.github.claudecodegui.ui;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests the draft key scope and the open-window list that lets pages delete closed drafts.
 */
public class DraftCacheKeysTest {

    /** Verifies that keys share the loaded scope, which is read only once. */
    @Test
    public void keysShareOneLazilyLoadedScope() {
        AtomicInteger loads = new AtomicInteger();
        DraftCacheKeys keys = new DraftCacheKeys(() -> "scope-" + loads.incrementAndGet());

        String first = keys.register("hash", "window-a", request -> false);
        String second = keys.register("hash", "window-b", request -> false);

        assertEquals("scope-1:hash:window-a", first);
        assertEquals("scope-1:hash:window-b", second);
        assertEquals(1, loads.get());
    }

    /** Verifies that the list names the scope and only the windows still open. */
    @Test
    public void openWindowsListOmitsClosedWindows() {
        DraftCacheKeys keys = new DraftCacheKeys(() -> "scope");
        String open = keys.register("hash", "open", request -> false);
        String closed = keys.register("hash", "closed", request -> false);

        keys.unregister(closed);

        JsonObject request = JsonParser.parseString(keys.openWindowsJson()).getAsJsonObject();
        assertEquals("scope:", request.get("scope").getAsString());
        assertEquals(1, request.getAsJsonArray("open").size());
        assertEquals(open, request.getAsJsonArray("open").get(0).getAsString());
    }

    /** Verifies that closing a window asks one ready page to delete its draft. */
    @Test
    public void closingAWindowAsksTheFirstReadyPageToPrune() {
        DraftCacheKeys keys = new DraftCacheKeys(() -> "scope");
        List<String> delivered = new ArrayList<>();
        AtomicInteger unreadyAttempts = new AtomicInteger();
        keys.register("hash", "unready", request -> {
            unreadyAttempts.incrementAndGet();
            return false;
        });
        keys.register("hash", "ready-1", request -> delivered.add(request));
        keys.register("hash", "ready-2", request -> delivered.add(request));
        String closed = keys.register("hash", "closed", request -> delivered.add(request));

        keys.unregister(closed);
        keys.unregister(closed);
        keys.unregister(null);

        assertEquals(1, delivered.size());
        assertFalse(delivered.get(0).contains("closed"));
        assertTrue(unreadyAttempts.get() <= 1);
    }
}
