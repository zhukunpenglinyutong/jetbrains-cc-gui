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
        assertEquals(386, transport.baseIndex());
        assertEquals(64, transport.messages().size());
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
    public void replacedPrefixForcesAFullRebase() {
        List<ClaudeSession.Message> previous = messages(400);
        List<ClaudeSession.Message> rebuilt = new ArrayList<>(previous);
        rebuilt.set(10, new ClaudeSession.Message(ClaudeSession.Message.Type.SYSTEM, "summary"));

        StreamMessageCoalescer.MessageTransport transport =
                StreamMessageCoalescer.selectMessageTransport(rebuilt, previous);

        assertFalse(transport.tailUpdate());
        assertEquals(0, transport.baseIndex());
        assertEquals(rebuilt, transport.messages());
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
