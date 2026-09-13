package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.session.ClaudeSession.Message;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
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
}
