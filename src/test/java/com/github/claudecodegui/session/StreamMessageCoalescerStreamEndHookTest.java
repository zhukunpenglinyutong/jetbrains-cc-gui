package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Integration tests for the stream lifecycle on the REAL
 * {@link StreamMessageCoalescer}.
 *
 * <p>These drive the production coalescer (not a re-implementation), so they
 * catch regressions in the actual onStreamStart/onStreamEnd lifecycle: the
 * {@code streamActive} transition and per-turn repetition. The deferred-reload
 * drain no longer hangs off this lifecycle — it is owned by the adapter's
 * stream-end callback, which fires only after the final snapshot has been
 * accepted by the ordered webview queue.
 */
public class StreamMessageCoalescerStreamEndHookTest {

    /** Codex snapshots keep growing before the native turn reaches its terminal. */
    @Test
    public void codexTextAndThinkingSnapshotsAreCapturedDuringTheTurn() throws Exception {
        HandlerContext context = new HandlerContext(null, null, null, null, null);
        context.setCurrentProvider("codex");
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new StreamMessageCoalescer.JsCallbackTarget() {
            @Override public boolean callJavaScript(String name, String... args) { return true; }
            @Override public boolean isDisposed() { return false; }
            @Override public HandlerContext getHandlerContext() { return context; }
        });
        try {
            coalescer.onStreamStart();
            for (String type : List.of("text", "thinking")) {
                ClaudeSession.Message message = new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "first");
                JsonObject block = new JsonObject();
                block.addProperty("type", type);
                block.addProperty(type, "first");
                JsonArray content = new JsonArray();
                content.add(block);
                message.raw = new JsonObject();
                message.raw.addProperty("codexSnapshot", true);
                message.raw.add("content", content);
                List<ClaudeSession.Message> live = List.of(message);
                coalescer.enqueue(live);
                message.content = "first and second";
                block.addProperty(type, message.content);
                coalescer.enqueue(live);
                assertEquals("the live snapshot must not wait for stream end", message.content,
                        capturedMessages(coalescer).get(0).raw.getAsJsonArray("content").get(0)
                                .getAsJsonObject().get(type).getAsString());
                assertTrue(coalescer.isStreamActive());
            }
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void stableHistoryIsCapturedOnceAcrossThirtyToolResults() throws Exception {
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new CountingTarget());
        try {
            List<ClaudeSession.Message> live = messages(200);
            for (ClaudeSession.Message message : live) {
                message.raw = new JsonObject();
                message.raw.addProperty("text", message.content);
            }
            coalescer.enqueue(live);
            List<ClaudeSession.Message> previous = capturedMessages(coalescer);
            int copies = previous.size();
            for (int index = 0; index < 30; index++) {
                JsonObject result = new JsonObject();
                result.addProperty("type", "tool_result");
                result.addProperty("tool_use_id", "tool-" + index);
                result.addProperty("content", "synthetic result");
                live.add(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "[tool_result]", result));
                coalescer.enqueue(live);
                List<ClaudeSession.Message> next = capturedMessages(coalescer);
                for (int messageIndex = 0; messageIndex < next.size(); messageIndex++) {
                    if (messageIndex >= previous.size() || next.get(messageIndex) != previous.get(messageIndex)) {
                        copies++;
                    }
                }
                previous = next;
            }
            assertEquals("200 history captures + 30 newly added results, not 6665 captures", 230, copies);
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void cachedSnapshotsInvalidateNestedChangesAndReset() throws Exception {
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new CountingTarget());
        try {
            List<ClaudeSession.Message> live = messages(2);
            JsonObject block = new JsonObject();
            block.addProperty("type", "tool_use");
            JsonObject input = new JsonObject();
            input.addProperty("command", "before");
            block.add("input", input);
            live.get(1).raw = new JsonObject();
            JsonArray blocks = new JsonArray();
            blocks.add(block);
            live.get(1).raw.add("content", blocks);
            coalescer.enqueue(live);
            List<ClaudeSession.Message> first = capturedMessages(coalescer);
            input.addProperty("command", "after");
            live.get(1).content = "changed";
            coalescer.enqueue(live);
            List<ClaudeSession.Message> second = capturedMessages(coalescer);
            assertSame(first.get(0), second.get(0));
            assertNotSame(first.get(1), second.get(1));
            assertEquals("before", first.get(1).raw.getAsJsonArray("content").get(0)
                    .getAsJsonObject().getAsJsonObject("input").get("command").getAsString());
            assertEquals("after", second.get(1).raw.getAsJsonArray("content").get(0)
                    .getAsJsonObject().getAsJsonObject("input").get("command").getAsString());
            coalescer.resetStreamState();
            coalescer.enqueue(live);
            assertNotSame(second.get(0), capturedMessages(coalescer).get(0));
        } finally {
            coalescer.dispose();
        }
    }

    @SuppressWarnings("unchecked")
    private static List<ClaudeSession.Message> capturedMessages(StreamMessageCoalescer coalescer) throws Exception {
        java.lang.reflect.Field field = StreamMessageCoalescer.class.getDeclaredField("latestSourceMessages");
        field.setAccessible(true);
        return (List<ClaudeSession.Message>) field.get(coalescer);
    }

    @Test
    public void inPlaceToolMutationInvalidatesStructuralSignature() throws Exception {
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new CountingTarget());
        try {
            List<ClaudeSession.Message> live = messages(1);
            JsonObject block = new JsonObject();
            block.addProperty("type", "tool_use");
            block.addProperty("id", "tool");
            JsonObject input = new JsonObject();
            input.addProperty("command", "before");
            block.add("input", input);
            JsonArray blocks = new JsonArray();
            blocks.add(block);
            live.get(0).raw = new JsonObject();
            live.get(0).raw.add("content", blocks);
            coalescer.enqueue(live);
            java.lang.reflect.Field field = StreamMessageCoalescer.class.getDeclaredField("latestStructuralSignature");
            field.setAccessible(true);
            Object before = field.get(coalescer);
            input.addProperty("command", "after");
            coalescer.enqueue(live);
            assertFalse("Mutable raw identity is not a version", before.equals(field.get(coalescer)));
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void textThinkingAndToolChangesInvalidateOnlyTheChangedMessage() throws Exception {
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new CountingTarget());
        try {
            List<ClaudeSession.Message> live = messages(2);
            live.get(1).raw = new JsonObject();
            coalescer.enqueue(live);
            for (String field : List.of("text", "thinking", "tool_result")) {
                List<ClaudeSession.Message> previous = capturedMessages(coalescer);
                String previousRaw = previous.get(1).raw.toString();
                live.get(1).raw.addProperty(field, "new value");
                coalescer.enqueue(live);
                List<ClaudeSession.Message> current = capturedMessages(coalescer);
                assertSame(previous.get(0), current.get(0));
                assertNotSame(previous.get(1), current.get(1));
                assertEquals(previousRaw, previous.get(1).raw.toString());
                assertEquals("new value", current.get(1).raw.get(field).getAsString());
                coalescer.flush(live, null);
                assertSame(current.get(1), capturedMessages(coalescer).get(1));
            }
            List<ClaudeSession.Message> beforeReplay = capturedMessages(coalescer);
            coalescer.replayLatestSnapshot(StreamMessageCoalescer.copyMessagesForTransport(live));
            coalescer.enqueue(live);
            assertNotSame(beforeReplay.get(0), capturedMessages(coalescer).get(0));
        } finally {
            coalescer.dispose();
        }
        java.lang.reflect.Field field = StreamMessageCoalescer.class.getDeclaredField("transportSnapshotCache");
        field.setAccessible(true);
        assertTrue(((java.util.Map<?, ?>) field.get(coalescer)).isEmpty());
    }

    /** Minimal JsCallbackTarget that records nothing; lifecycle only. */
    private static final class CountingTarget implements StreamMessageCoalescer.JsCallbackTarget {
        @Override public boolean callJavaScript(String functionName, String... args) { return true; }
        @Override public boolean isDisposed() { return false; }
        @Override public HandlerContext getHandlerContext() { return null; }
    }

    @Test
    public void onStreamEndClearsActive() {
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            coalescer.onStreamStart();
            assertTrue("stream active after start", coalescer.isStreamActive());

            coalescer.onStreamEnd();
            assertFalse("stream inactive after end", coalescer.isStreamActive());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void streamActiveFollowsEachTurnAcrossMultipleTurns() {
        // A long session fans out many turns; each boundary must toggle the
        // streaming flag so deferred work observes a clean idle edge.
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            for (int i = 0; i < 5; i++) {
                coalescer.onStreamStart();
                assertTrue(coalescer.isStreamActive());
                coalescer.onStreamEnd();
                assertFalse(coalescer.isStreamActive());
            }
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void resetStreamStateClearsActive() {
        // resetStreamState() (new-session / restart) also drops streamActive, but
        // it is NOT a turn boundary — no drain may be triggered for it, or a reload
        // could run against a session the user just navigated away from.
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            coalescer.onStreamStart();
            assertTrue(coalescer.isStreamActive());

            coalescer.resetStreamState();
            assertFalse("reset clears active", coalescer.isStreamActive());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void firstLongConversationSnapshotKeepsTheFullPrefix() {
        List<ClaudeSession.Message> messages = messages(400);

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(messages, null);

        assertFalse(transport.tailUpdate());
        assertEquals(0, transport.baseIndex());
        assertEquals(messages, transport.messages());
    }

    @Test
    public void thresholdConversationKeepsTheFullSnapshot() {
        List<ClaudeSession.Message> messages = messages(300);

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(messages, null);

        assertFalse(transport.tailUpdate());
        assertEquals(0, transport.baseIndex());
        assertEquals(messages, transport.messages());
    }

    @Test
    public void growingConversationWithStablePrefixUsesTail() {
        List<ClaudeSession.Message> previous = messages(400);
        List<ClaudeSession.Message> growing = new ArrayList<>();
        for (ClaudeSession.Message message : previous) {
            ClaudeSession.Message copy = new ClaudeSession.Message(message.type, message.content);
            copy.timestamp = message.timestamp;
            growing.add(copy);
        }
        for (int i = 400; i < 450; i++) {
            growing.add(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "message-" + i));
        }

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(growing, previous);

        assertTrue(transport.tailUpdate());
        // Divergence-based transport ships only the appended suffix, not a fixed tail.
        assertEquals(400, transport.baseIndex());
        assertEquals(50, transport.messages().size());
    }

    @Test
    public void shortConversationGrowthAlsoUsesTail() {
        // The reported freeze: ~50 messages with a huge transcript re-pushed in
        // full every 2s. Incremental delivery must not be gated on length.
        List<ClaudeSession.Message> previous = messages(50);
        List<ClaudeSession.Message> growing = new ArrayList<>(previous);
        growing.add(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "message-50"));
        growing.add(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "message-51"));

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(growing, previous);

        assertTrue(transport.tailUpdate());
        assertEquals(50, transport.baseIndex());
        assertEquals(2, transport.messages().size());
    }

    @Test
    public void contentChangeInLastMessageTailsOnlyThatMessage() {
        // Streaming appends text to the last message; only it should ship.
        List<ClaudeSession.Message> previous = messages(50);
        List<ClaudeSession.Message> streaming = new ArrayList<>(previous);
        ClaudeSession.Message last = previous.get(49);
        ClaudeSession.Message longer = new ClaudeSession.Message(last.type, last.content + "…delta");
        longer.timestamp = last.timestamp;
        streaming.set(49, longer);

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(streaming, previous);

        assertTrue(transport.tailUpdate());
        assertEquals(49, transport.baseIndex());
        assertEquals(1, transport.messages().size());
        assertEquals(last.content + "…delta", transport.messages().get(0).content);
    }

    @Test
    public void identicalSnapshotsFallBackToFull() {
        List<ClaudeSession.Message> previous = messages(20);

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(previous, previous);

        assertFalse(transport.tailUpdate());
        assertEquals(0, transport.baseIndex());
    }

    @Test
    public void divergenceAtFirstMessageForcesAFullRebase() {
        List<ClaudeSession.Message> previous = messages(20);
        List<ClaudeSession.Message> rebuilt = new ArrayList<>(previous);
        rebuilt.set(0, new ClaudeSession.Message(ClaudeSession.Message.Type.SYSTEM, "rewritten"));

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(rebuilt, previous);

        assertFalse(transport.tailUpdate());
        assertEquals(0, transport.baseIndex());
        assertEquals(rebuilt, transport.messages());
    }

    @Test
    public void shrinkingConversationForcesAFullRebase() {
        List<ClaudeSession.Message> previous = messages(400);
        List<ClaudeSession.Message> compacted = new ArrayList<>(previous.subList(0, 350));

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(compacted, previous);

        assertFalse(transport.tailUpdate());
        assertEquals(0, transport.baseIndex());
        assertEquals(compacted, transport.messages());
    }

    @Test
    public void replacedMiddleMessageTailsFromTheDivergence() {
        // An edited/compacted middle message widens the suffix but does not
        // force a full re-push: everything from the divergence point ships.
        List<ClaudeSession.Message> previous = messages(400);
        List<ClaudeSession.Message> rebuilt = new ArrayList<>(previous);
        rebuilt.set(10, new ClaudeSession.Message(ClaudeSession.Message.Type.SYSTEM, "summary"));

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(rebuilt, previous);

        assertTrue(transport.tailUpdate());
        assertEquals(10, transport.baseIndex());
        assertEquals(390, transport.messages().size());
        assertEquals("summary", transport.messages().get(0).content);
    }

    @Test
    public void transportSnapshotDeepCopiesMutableRaw() {
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", "tool-1");
        block.addProperty("name", "Bash");
        block.addProperty("input", "before");
        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.add("message", message);
        ClaudeSession.Message original = new ClaudeSession.Message(
                ClaudeSession.Message.Type.ASSISTANT, "before", raw);

        List<ClaudeSession.Message> snapshot =
                StreamMessageCoalescer.copyMessagesForTransport(List.of(original));
        original.content = "after";
        block.addProperty("input", "after");

        assertNotSame(original, snapshot.get(0));
        assertEquals("before", snapshot.get(0).content);
        assertEquals("before", snapshot.get(0).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content")
                .get(0).getAsJsonObject()
                .get("input").getAsString());
    }

    @Test
    public void sessionStateSnapshotDoesNotShareMutableRawTrees() {
        SessionState state = new SessionState();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", "tool-1");
        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject message = new JsonObject();
        message.add("content", content);
        JsonObject raw = new JsonObject();
        raw.add("message", message);
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "", raw));

        List<ClaudeSession.Message> snapshot = state.getMessagesSnapshot();
        block.addProperty("id", "tool-2");
        content.add(new JsonObject());

        JsonArray snapshotContent = snapshot.get(0).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals(1, snapshotContent.size());
        assertEquals("tool-1", snapshotContent.get(0).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void resetDeliveryBaselineStillRunsAPendingAfterFlushCallback() {
        // The stream-end signal rides flush()'s afterFlush callback. A page reload
        // during streaming drops the queued snapshot, but it must NOT drop that
        // callback: without it the frontend waits out the adapter's multi-second
        // fallback before it learns the turn ended.
        List<String> callbacks = new ArrayList<>();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new CountingTarget());
        try {
            coalescer.onStreamStart();
            coalescer.flush((List<ClaudeSession.Message>) null, sequence -> callbacks.add("after-flush:" + sequence));

            coalescer.resetDeliveryBaseline();

            assertEquals(1, callbacks.size());
            assertTrue(callbacks.get(0).startsWith("after-flush:"));
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void parkedSnapshotStateDoesNotReportBuildPending() {
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(new CountingTarget());
        try {
            coalescer.flush(messages(4), null);
            awaitSnapshotBuildIdle(coalescer);
            assertFalse("serialization has finished", coalescer.isSnapshotBuildPending());

            // The live state is retained so the next ready page can replay it, but
            // nothing is being serialized. isSnapshotBuildPending must stay false: the
            // deferred-reload pollers re-arm on it, so reporting retained state as work
            // in flight would spin them on a condition they cannot resolve.
            coalescer.resetDeliveryBaseline();

            assertFalse("a parked snapshot is not serialization work",
                    coalescer.isSnapshotBuildPending());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void usagePushFailureAfterAcceptStillRunsTheAfterFlush() {
        // The snapshot was accepted by the queue; a failure in the trailing usage
        // push (foreign HandlerContext code, e.g. mid-teardown) must not park the
        // delivered snapshot's afterFlush — that callback carries the stream-end
        // signal, and parking it would stall the frontend until the fallback alarm.
        List<String> callbacks = new ArrayList<>();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(
                new StreamMessageCoalescer.JsCallbackTarget() {
                    @Override public boolean callJavaScript(String functionName, String... args) {
                        return true;
                    }
                    @Override public boolean isDisposed() { return false; }
                    @Override public HandlerContext getHandlerContext() {
                        throw new IllegalStateException("handler context torn down");
                    }
                });
        try {
            coalescer.flush(messages(2), sequence -> callbacks.add("after-flush:" + sequence));
            awaitSnapshotBuildIdle(coalescer);

            assertEquals("afterFlush runs exactly once for the delivered snapshot",
                    1, callbacks.size());
        } finally {
            coalescer.dispose();
        }
    }

    private static void awaitSnapshotBuildIdle(StreamMessageCoalescer coalescer) {
        long deadline = System.currentTimeMillis() + 5_000L;
        while (coalescer.isSnapshotBuildPending() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(5L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private static List<ClaudeSession.Message> messages(int count) {
        List<ClaudeSession.Message> messages = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            messages.add(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "message-" + i));
        }
        return messages;
    }
}
