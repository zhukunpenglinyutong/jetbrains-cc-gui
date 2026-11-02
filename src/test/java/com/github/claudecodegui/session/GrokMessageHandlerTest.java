package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.provider.grok.GrokUsageLedger;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.lang.reflect.Constructor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for Grok transcript integrity:
 * - do not double-add send-time user messages from ACP echoes
 * - never reuse a completed previous-turn assistant for a new stream
 */
public class GrokMessageHandlerTest {

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        final List<List<Message>> messageSnapshots = new ArrayList<>();
        final List<int[]> usageUpdates = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<Message> messages) {
            messageSnapshots.add(new ArrayList<>(messages));
        }

        @Override
        public void onUsageUpdate(int usedTokens, int maxTokens) {
            usageUpdates.add(new int[]{usedTokens, maxTokens});
        }

        @Override public void onStateChange(boolean busy, boolean loading, String error) {}
        @Override public void onSessionIdReceived(String sessionId) {}
        @Override public void onPermissionRequested(PermissionRequest request) {}
        @Override public void onThinkingStatusChanged(boolean isThinking) {}
        @Override public void onSlashCommandsReceived(List<String> slashCommands) {}
        @Override public void onNodeLog(String log) {}
        @Override public void onSummaryReceived(String summary) {}
        @Override public void onStreamStart() {}
        @Override public void onStreamEnd() {}
        @Override public void onContentDelta(String delta) {}
        @Override public void onThinkingDelta(String delta) {}
    }

    private static GrokMessageHandler newHandler(SessionState state) {
        return newHandler(state, new RecordingCallback());
    }

    private static GrokMessageHandler newHandler(SessionState state, RecordingCallback callback) {
        CallbackHandler callbacks = new CallbackHandler();
        callbacks.setCallback(callback);
        return new GrokMessageHandler(state, callbacks);
    }

    @Test
    public void userEchoDoesNotDuplicateSendTimeUserMessage() {
        SessionState state = new SessionState();
        Message sendTimeUser = new Message(Message.Type.USER, "investigate the hang");
        state.addMessage(sendTimeUser);

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("user", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"investigate the hang\"}]}}");

        List<Message> messages = state.getMessages();
        assertEquals("ACP user echo must not add a second user bubble", 1, messages.size());
        assertSame(sendTimeUser, messages.get(0));
        assertEquals("investigate the hang", messages.get(0).content);
    }

    @Test
    public void userEchoAfterAssistantDoesNotAppendTrailingUserBubble() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "first question"));
        state.addMessage(new Message(Message.Type.ASSISTANT, "first answer"));

        GrokMessageHandler handler = newHandler(state);
        // Late echo of the first user message — previously landed AFTER the assistant.
        handler.onMessage("user", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"first question\"}]}}");

        List<Message> messages = state.getMessages();
        assertEquals(2, messages.size());
        assertEquals(Message.Type.USER, messages.get(0).type);
        assertEquals(Message.Type.ASSISTANT, messages.get(1).type);
    }

    @Test
    public void toolResultUserMessagesAreStillAdded() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.ASSISTANT, "calling tool"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage(
                "user",
                "{\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"content\":\"ok\"}]}}"
        );

        List<Message> messages = state.getMessages();
        assertEquals(2, messages.size());
        assertEquals(Message.Type.USER, messages.get(1).type);
        assertEquals("[tool_result]", messages.get(1).content);
    }

    @Test
    public void newStreamDoesNotReusePreviousTurnAssistantEvenIfLastIsAssistant() {
        SessionState state = new SessionState();
        Message prevAssistant = new Message(Message.Type.ASSISTANT, "previous turn answer with PR links");
        state.addMessage(new Message(Message.Type.USER, "first"));
        state.addMessage(prevAssistant);
        // Simulate missing send-time user for turn 2 (the frontend race case).

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "new turn answer");

        List<Message> messages = state.getMessages();
        assertEquals("must append a new assistant bubble for the new stream", 3, messages.size());
        assertSame(prevAssistant, messages.get(1));
        assertEquals("previous turn answer with PR links", messages.get(1).content);
        assertEquals(Message.Type.ASSISTANT, messages.get(2).type);
        assertEquals("new turn answer", messages.get(2).content);
        assertNotSame(prevAssistant, messages.get(2));
    }

    @Test
    public void contentDeltasAccumulateOnStreamOwnedAssistant() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "q"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Hello");
        handler.onMessage("content_delta", " world");

        List<Message> messages = state.getMessages();
        assertEquals(2, messages.size());
        assertEquals("Hello world", messages.get(1).content);
    }

    @Test
    public void blockResetKeepsSameStreamAssistantForNextTextSegment() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "q"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "before tools");
        handler.onMessage("block_reset", "");
        handler.onMessage("content_delta", " after tools");

        List<Message> messages = state.getMessages();
        assertEquals("block_reset must not create a second assistant for the same stream", 2, messages.size());
        // Accumulator is cleared on block_reset; subsequent deltas start a new text segment
        // on the same stream-owned bubble.
        assertTrue(messages.get(1).content.contains("after tools") || messages.get(1).content.equals(" after tools"));
    }

    @Test
    public void acpCamelCaseUsageUpdatesContextRing() {
        SessionState state = new SessionState();
        state.setModel("grok-4.6");
        state.addMessage(new Message(Message.Type.USER, "q"));

        RecordingCallback callback = new RecordingCallback();
        GrokMessageHandler handler = newHandler(state, callback);
        handler.onMessage("stream_start", "");
        handler.onMessage("usage", "{\"totalTokens\":12345,\"inputTokens\":10000,\"outputTokens\":2345}");

        assertEquals("notifyUsageUpdate must fire for ACP camelCase usage", 1, callback.usageUpdates.size());
        assertEquals(12_345, callback.usageUpdates.get(0)[0]);
        assertTrue("maxTokens should be model context limit", callback.usageUpdates.get(0)[1] > 0);
    }

    @Test
    public void snakeCaseUsageUpdatesContextRingAndStoresCanonical() {
        SessionState state = new SessionState();
        state.setModel("grok-4.6");
        state.addMessage(new Message(Message.Type.USER, "q"));

        RecordingCallback callback = new RecordingCallback();
        GrokMessageHandler handler = newHandler(state, callback);
        handler.onMessage("stream_start", "");
        handler.onMessage("usage", "{\"total_tokens\":500,\"input_tokens\":400,\"output_tokens\":100}");

        assertEquals(1, callback.usageUpdates.size());
        assertEquals(500, callback.usageUpdates.get(0)[0]);

        Message assistant = state.getMessages().get(1);
        assertTrue(assistant.raw.getAsJsonObject("message").has("usage"));
        assertEquals(
                500,
                assistant.raw.getAsJsonObject("message").getAsJsonObject("usage").get("total_tokens").getAsInt()
        );
    }

    @Test
    public void finalMessageWithoutUsageDoesNotWipePriorUsage() {
        SessionState state = new SessionState();
        state.setModel("grok-4.6");
        state.addMessage(new Message(Message.Type.USER, "q"));

        RecordingCallback callback = new RecordingCallback();
        GrokMessageHandler handler = newHandler(state, callback);
        handler.onMessage("stream_start", "");
        handler.onMessage("usage", "{\"totalTokens\":17571,\"inputTokens\":17557,\"outputTokens\":14}");
        // Final assistant MESSAGE historically had no usage and wiped the ring snapshot.
        handler.onMessage("message",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"pong\"}]}}");
        handler.onMessage("stream_end", "");

        Message assistant = state.getMessages().get(1);
        assertTrue(assistant.raw.getAsJsonObject("message").has("usage"));
        assertEquals(
                17571,
                assistant.raw.getAsJsonObject("message").getAsJsonObject("usage").get("total_tokens").getAsInt()
        );
        // stream_end re-pushes context usage
        assertTrue(callback.usageUpdates.size() >= 2);
        int lastUsed = callback.usageUpdates.get(callback.usageUpdates.size() - 1)[0];
        assertEquals(17571, lastUsed);
    }

    /**
     * REGRESSION: Grok finishSuccess flushes tool_use mid-turn, then emits a final
     * [MESSAGE] with only thinking/text. That final snapshot must not replace raw
     * and erase tool_use — otherwise StatusPanel "编辑 +N -M" is empty until the
     * session is reloaded from history.
     */
    @Test
    public void finalTextMessageDoesNotWipeMidTurnToolUse() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "create timestamp file"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");

        // Ledger flush: Write tool_use (as GrokEventNormalizer.#emitToolUse)
        handler.onMessage(
                "message",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{"
                        + "\"type\":\"tool_use\",\"id\":\"fs-write-1\",\"name\":\"Write\","
                        + "\"input\":{\"path\":\"/proj/20260815,172939\",\"file_path\":\"/proj/20260815,172939\","
                        + "\"content\":\"123\",\"new_string\":\"123\"}}]}}"
        );
        handler.onMessage(
                "tool_result",
                "{\"type\":\"tool_result\",\"tool_use_id\":\"fs-write-1\",\"content\":\"ok\",\"is_error\":false}"
        );
        // block_reset after tool (normalizer emits this after tool_use)
        handler.onMessage("block_reset", "");

        // finishSuccess final MESSAGE: thinking + text only (no tool_use)
        handler.onMessage(
                "message",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":["
                        + "{\"type\":\"thinking\",\"thinking\":\"create file with timestamp name\"},"
                        + "{\"type\":\"text\",\"text\":\"已创建文件: 20260815, 172939\"}"
                        + "]}}"
        );
        handler.onMessage("stream_end", "");

        Message assistant = null;
        for (Message m : state.getMessages()) {
            if (m.type == Message.Type.ASSISTANT) {
                assistant = m;
                break;
            }
        }
        assertTrue("stream-owned assistant must exist", assistant != null);
        assertTrue(assistant.raw != null && assistant.raw.has("message"));

        com.google.gson.JsonArray content = assistant.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        boolean hasToolUse = false;
        boolean hasText = false;
        boolean hasThinking = false;
        for (int i = 0; i < content.size(); i++) {
            com.google.gson.JsonObject block = content.get(i).getAsJsonObject();
            String type = block.has("type") ? block.get("type").getAsString() : "";
            if ("tool_use".equals(type) && "fs-write-1".equals(block.get("id").getAsString())) {
                hasToolUse = true;
            }
            if ("text".equals(type)) {
                hasText = true;
            }
            if ("thinking".equals(type)) {
                hasThinking = true;
            }
        }
        assertTrue("tool_use must survive final text/thinking MESSAGE for StatusPanel edits", hasToolUse);
        assertTrue("final text must still be present", hasText);
        assertTrue("final thinking must still be present", hasThinking);

        // tool_result user message must also remain (useFileChanges needs both)
        boolean hasToolResult = false;
        for (Message m : state.getMessages()) {
            if (m.type == Message.Type.USER && "[tool_result]".equals(m.content)) {
                hasToolResult = true;
                break;
            }
        }
        assertTrue("tool_result user message must remain", hasToolResult);
    }

    @Test
    public void blockResetStartsNewThinkingBlock() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "q"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking_delta", "Thinking about step 1");
        handler.onMessage("thinking_delta", " continues");
        handler.onMessage("block_reset", "");
        handler.onMessage("thinking_delta", "Reflecting on step 2");
        handler.onMessage("thinking_delta", " more");

        com.google.gson.JsonArray streamed = state.getMessages().get(1).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals(2, streamed.size());
        assertEquals("Thinking about step 1 continues", streamed.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("Reflecting on step 2 more", streamed.get(1).getAsJsonObject().get("thinking").getAsString());

        handler.onMessage(
                "message",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":["
                        + "{\"type\":\"thinking\",\"thinking\":\"Thinking about step 1 continues\"},"
                        + "{\"type\":\"thinking\",\"thinking\":\"Reflecting on step 2 more\"}"
                        + "]}}"
        );

        com.google.gson.JsonArray merged = state.getMessages().get(1).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("final snapshot must not glue the thoughts or repeat the second one", 2, merged.size());
        assertEquals("Thinking about step 1 continues", merged.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("Reflecting on step 2 more", merged.get(1).getAsJsonObject().get("thinking").getAsString());
    }

    @Test
    public void blockResetKeepsPreToolTextBeforeToolCardOnFinalMerge() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "q"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Checking config");
        handler.onMessage("content_delta", " first.");
        handler.onMessage("block_reset", "");
        handler.onMessage(
                "message",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{"
                        + "\"type\":\"tool_use\",\"id\":\"call-grep-1\",\"name\":\"grep\","
                        + "\"input\":{\"pattern\":\"nbns\"}}]}}"
        );
        handler.onMessage("content_delta", "Config is clean");
        handler.onMessage("content_delta", " now.");

        handler.onMessage(
                "message",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":["
                        + "{\"type\":\"text\",\"text\":\"Checking config first.\"},"
                        + "{\"type\":\"text\",\"text\":\"Config is clean now.\"}"
                        + "]}}"
        );
        handler.onMessage("stream_end", "");

        com.google.gson.JsonArray merged = state.getMessages().get(1).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("pre-tool text, tool_use, and post-tool text must remain 3 ordered blocks", 3, merged.size());
        assertEquals("text", merged.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("Checking config first.", merged.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("tool_use", merged.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("call-grep-1", merged.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals("text", merged.get(2).getAsJsonObject().get("type").getAsString());
        assertEquals("Config is clean now.", merged.get(2).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void proseSaidWhileToolRunsStaysAboveLateToolCard() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "q"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Before.");
        // Tool announced: the normalizer seals the open segment.
        handler.onMessage("block_reset", "");
        handler.onMessage("content_delta", "While running.");
        // Tool card emitted late: the prose said while it ran is sealed first.
        handler.onMessage("block_reset", "");
        handler.onMessage(
                "message",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{"
                        + "\"type\":\"tool_use\",\"id\":\"call-slow\",\"name\":\"grep\",\"input\":{}}]}}"
        );
        handler.onMessage("content_delta", "After.");
        handler.onMessage(
                "message",
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":["
                        + "{\"type\":\"text\",\"text\":\"Before.\"},"
                        + "{\"type\":\"text\",\"text\":\"While running.\"},"
                        + "{\"type\":\"text\",\"text\":\"After.\"}"
                        + "]}}"
        );
        handler.onMessage("stream_end", "");

        com.google.gson.JsonArray merged = state.getMessages().get(1).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("each segment keeps its own block around the tool card", 4, merged.size());
        assertEquals("Before.", merged.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("While running.", merged.get(1).getAsJsonObject().get("text").getAsString());
        assertEquals("tool_use", merged.get(2).getAsJsonObject().get("type").getAsString());
        assertEquals("After.", merged.get(3).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void textAndThinkingInOneSegmentEachGrowOneBlock() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "q"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking_delta", "Plan");
        handler.onMessage("content_delta", "Ans");
        handler.onMessage("thinking_delta", " more");
        handler.onMessage("content_delta", "wer");

        com.google.gson.JsonArray streamed = state.getMessages().get(1).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals(2, streamed.size());
        assertEquals("Plan more", streamed.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("Answer", streamed.get(1).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void resultAfterBlockResetStampsNormalizedTurnUsageOnStreamAssistantMessage() {
        SessionState state = new SessionState();
        state.addMessage(new Message(Message.Type.USER, "Prompt"));

        GrokMessageHandler handler = newHandler(state);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Thinking and working");
        handler.onMessage("block_reset", "");

        JsonObject resultObj = new JsonObject();
        JsonObject usageObj = new JsonObject();
        usageObj.addProperty("inputTokens", 46915);
        usageObj.addProperty("cachedReadTokens", 24960);
        usageObj.addProperty("outputTokens", 415);
        usageObj.addProperty("reasoningTokens", 361);
        usageObj.addProperty("totalTokens", 47330);
        resultObj.add("usage", usageObj);

        handler.onMessage("result", resultObj.toString());
        handler.onMessage("stream_end", "");

        List<Message> messages = state.getMessages();
        assertEquals(2, messages.size());
        Message assistant = messages.get(1);
        assertNotNull("Assistant raw must not be null", assistant.raw);
        assertTrue("Assistant raw must contain turnUsage", assistant.raw.has("turnUsage"));

        JsonObject turnUsage = assistant.raw.getAsJsonObject("turnUsage");
        assertEquals("input_tokens must be cache-exclusive", 21955, turnUsage.get("input_tokens").getAsInt());
        assertEquals("cache_read_input_tokens must be 24960", 24960, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals("output_tokens must be 415", 415, turnUsage.get("output_tokens").getAsInt());
        assertEquals("thinking_tokens must be 361", 361, turnUsage.get("thinking_tokens").getAsInt());
        assertEquals("total_tokens must be 47330", 47330, turnUsage.get("total_tokens").getAsInt());
    }

    @Test
    public void midStreamUsageDoesNotWriteDuplicateLedgerRowsAndTurnRecordsOnceWithCwd() throws Exception {
        SessionState state = new SessionState();
        state.setSessionId("test-session-ledger");
        state.setModel("grok-4.7");
        state.setCwd("/test/cwd/project");
        state.addMessage(new Message(Message.Type.USER, "Prompt"));

        Path tempLedger = Files.createTempFile("grok-ledger-test", ".jsonl");
        try {
            Constructor<GrokUsageLedger> ledgerCtor = GrokUsageLedger.class.getDeclaredConstructor(Path.class);
            ledgerCtor.setAccessible(true);
            GrokUsageLedger ledger = ledgerCtor.newInstance(tempLedger);

            GrokMessageHandler handler;
            try {
                Constructor<GrokMessageHandler> ctor = GrokMessageHandler.class.getDeclaredConstructor(
                        SessionState.class,
                        CallbackHandler.class,
                        GrokUsageLedger.class
                );
                ctor.setAccessible(true);
                CallbackHandler callbacks = new CallbackHandler();
                callbacks.setCallback(new RecordingCallback());
                handler = ctor.newInstance(state, callbacks, ledger);
            } catch (NoSuchMethodException e) {
                throw new AssertionError("GrokMessageHandler(SessionState, CallbackHandler, GrokUsageLedger) constructor not found", e);
            }

            handler.onMessage("stream_start", "");
            handler.onMessage("usage", "{\"total_tokens\":12000,\"input_tokens\":10000,\"output_tokens\":2000}");
            handler.onMessage("usage", "{\"total_tokens\":24000,\"input_tokens\":20000,\"output_tokens\":4000}");

            assertEquals("Mid-stream usage must not write to ledger", 0, Files.readAllLines(tempLedger).size());

            JsonObject resultObj = new JsonObject();
            JsonObject usageObj = new JsonObject();
            usageObj.addProperty("totalTokens", 24000);
            usageObj.addProperty("inputTokens", 20000);
            usageObj.addProperty("outputTokens", 4000);
            resultObj.add("usage", usageObj);
            handler.onMessage("result", resultObj.toString());
            handler.onMessage("stream_end", "");

            List<String> lines = Files.readAllLines(tempLedger);
            assertEquals("Turn completion must record exactly one ledger entry", 1, lines.size());
            assertTrue("Ledger entry must record cwd", lines.get(0).contains("/test/cwd/project"));
        } finally {
            Files.deleteIfExists(tempLedger);
        }
    }

    @Test
    public void ledgerRecordsCacheExclusiveInputFromTurnResult() throws Exception {
        Path tempLedger = Files.createTempFile("grok-ledger-result", ".jsonl");
        try {
            GrokMessageHandler handler = newLedgerHandler(newLedgerState(), tempLedger);
            handler.onMessage("stream_start", "");
            handler.onMessage("content_delta", "Answer");
            handler.onMessage("result", "{\"usage\":{\"totalTokens\":47330,\"inputTokens\":46915,"
                    + "\"cachedReadTokens\":24960,\"outputTokens\":415}}");
            handler.onMessage("stream_end", "");

            JsonObject entry = singleLedgerEntry(tempLedger);
            assertEquals(21955, entry.get("inputTokens").getAsLong());
            assertEquals(24960, entry.get("cacheReadTokens").getAsLong());
            assertEquals(415, entry.get("outputTokens").getAsLong());
            assertEquals(47330, entry.get("totalTokens").getAsLong());
        } finally {
            Files.deleteIfExists(tempLedger);
        }
    }

    @Test
    public void ledgerFallbackAtStreamEndSplitsCacheOutOfTheContextSnapshot() throws Exception {
        Path tempLedger = Files.createTempFile("grok-ledger-fallback", ".jsonl");
        try {
            GrokMessageHandler handler = newLedgerHandler(newLedgerState(), tempLedger);
            handler.onMessage("stream_start", "");
            handler.onMessage("content_delta", "Answer");
            // The total is not exactly input + output; the split must not depend on that.
            handler.onMessage("usage", "{\"totalTokens\":24086,\"inputTokens\":23722,"
                    + "\"cachedReadTokens\":23168,\"outputTokens\":356}");
            handler.onMessage("stream_end", "");

            JsonObject entry = singleLedgerEntry(tempLedger);
            assertEquals(554, entry.get("inputTokens").getAsLong());
            assertEquals(23168, entry.get("cacheReadTokens").getAsLong());
            assertEquals(24086, entry.get("totalTokens").getAsLong());
        } finally {
            Files.deleteIfExists(tempLedger);
        }
    }

    private static SessionState newLedgerState() {
        SessionState state = new SessionState();
        state.setSessionId("ledger-session");
        state.setModel("grok-4.7");
        state.setCwd("/test/cwd/project");
        state.addMessage(new Message(Message.Type.USER, "Prompt"));
        return state;
    }

    private static GrokMessageHandler newLedgerHandler(SessionState state, Path ledgerPath) throws Exception {
        Constructor<GrokUsageLedger> ledgerCtor = GrokUsageLedger.class.getDeclaredConstructor(Path.class);
        ledgerCtor.setAccessible(true);
        CallbackHandler callbacks = new CallbackHandler();
        callbacks.setCallback(new RecordingCallback());
        return new GrokMessageHandler(state, callbacks, ledgerCtor.newInstance(ledgerPath));
    }

    private static JsonObject singleLedgerEntry(Path ledgerPath) throws Exception {
        List<String> lines = Files.readAllLines(ledgerPath);
        assertEquals("Exactly one ledger entry per turn", 1, lines.size());
        return com.google.gson.JsonParser.parseString(lines.get(0)).getAsJsonObject();
    }
}
