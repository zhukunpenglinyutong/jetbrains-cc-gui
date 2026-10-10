package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/** Verifies runtime-scoped native interaction identity and replay ordering. */
public class CodexInteractionRegistryTest {

    @Test
    public void reusedRpcIdsAcrossRuntimeGenerationsRemainDistinct() {
        CodexInteractionRegistry registry = new CodexInteractionRegistry();
        JsonObject params = new JsonObject();
        params.addProperty("question", "safe");
        CodexInteractionRegistry.Entry first = registry.register(
                new JsonPrimitive(7), "item/tool/requestUserInput", "channel",
                "epoch-a", "runtime-1", "root", "child-a", "turn-a", "item-a", params, 10L);
        CodexInteractionRegistry.Entry second = registry.register(
                new JsonPrimitive(7), "item/tool/requestUserInput", "channel",
                "epoch-b", "runtime-2", "root", "child-b", "turn-b", "item-b", params, 20L);

        assertNotEquals(first.interactionKey(), second.interactionKey());
        assertNotNull(registry.get(first.interactionKey()));
        assertNotNull(registry.get(second.interactionKey()));
        assertTrue(registry.resolve(first.interactionKey()));
        assertFalse(registry.resolve(first.interactionKey()));
        assertNotNull(registry.get(second.interactionKey()));
    }

    @Test
    public void snapshotKeepsDeliveryOrderAndNativePayload() {
        CodexInteractionRegistry registry = new CodexInteractionRegistry();
        JsonObject params = new JsonObject();
        params.addProperty("isBlocking", false);
        registry.register(new JsonPrimitive(1), "first", "channel", "epoch", "runtime",
                "root", "root", null, null, params, 1L);
        registry.register(new JsonPrimitive(2), "second", "channel", "epoch", "runtime",
                "root", "child", "turn", "item", params, 2L);

        List<CodexInteractionRegistry.Entry> entries = registry.snapshot("channel");
        assertEquals(2, entries.size());
        assertEquals("first", entries.get(0).method());
        assertFalse(entries.get(1).params().get("isBlocking").getAsBoolean());
    }

    @Test
    public void pageTokenChangesOnReplayAndInvalidatesAfterResolution() {
        CodexInteractionRegistry registry = new CodexInteractionRegistry();
        CodexInteractionRegistry.Entry entry = registry.register(
                new JsonPrimitive(3), "approval", "channel", "epoch", "runtime",
                "root", "root", "turn", "item", new JsonObject(), 3L);

        String firstToken = registry.pageToken(entry.interactionKey());
        String replayToken = registry.issuePageToken(entry.interactionKey());

        assertNotNull(firstToken);
        assertNotNull(replayToken);
        assertNotEquals(firstToken, replayToken);
        assertFalse(registry.matchesPageToken(entry.interactionKey(), firstToken));
        assertTrue(registry.matchesPageToken(entry.interactionKey(), replayToken));
        assertTrue(registry.resolve(entry.interactionKey()));
        assertFalse(registry.matchesPageToken(entry.interactionKey(), replayToken));
    }

    @Test
    public void deliveryAcknowledgementsAcceptCurrentPageAndRetainResolvedTombstone() {
        CodexInteractionRegistry registry = new CodexInteractionRegistry();
        CodexInteractionRegistry.Entry entry = registry.register(
                new JsonPrimitive(4), "approval", "channel", "epoch", "runtime",
                "root", "root", "turn", "item", new JsonObject(), 4L);
        String token = registry.pageToken(entry.interactionKey());

        assertTrue(registry.acknowledge(entry.interactionKey(), token,
                entry.deliverySequence(), "show"));
        assertFalse(registry.acknowledge(entry.interactionKey(), "stale", entry.deliverySequence(), "show"));
        assertTrue(registry.resolve(entry.interactionKey()));
        assertTrue(registry.hasResolvedTombstone(entry.interactionKey()));
        assertTrue(registry.acknowledge(entry.interactionKey(), token,
                entry.deliverySequence(), "close"));
        assertFalse(registry.acknowledge(entry.interactionKey(), token,
                entry.deliverySequence(), "show"));
    }
}
