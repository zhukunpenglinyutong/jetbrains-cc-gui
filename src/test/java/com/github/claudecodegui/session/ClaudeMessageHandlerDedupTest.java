package com.github.claudecodegui.session;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Tests for ClaudeMessageHandler dedup logic.
 * Uses a recording CallbackHandler to verify notifications.
 */
public class ClaudeMessageHandlerDedupTest {

    private RecordingCallbackHandler callbackHandler;
    private SessionState state;
    private ClaudeMessageHandler handler;

    @Before
    public void setUp() {
        callbackHandler = new RecordingCallbackHandler();
        state = new SessionState();
        MessageParser messageParser = new MessageParser();
        MessageMerger messageMerger = new MessageMerger();
        Gson gson = new GsonBuilder().create();

        handler = new ClaudeMessageHandler(
                null, // project not needed for these tests
                state,
                callbackHandler,
                messageParser,
                messageMerger,
                gson,
                state.getRuntimeSessionEpoch()
        );
    }

    /**
     * Test that content delta is skipped when it duplicates existing content after conservative sync.
     */
    @Test
    public void handleContentDelta_skipsDuplicateAfterConservativeSync() {
        // Simulate stream start
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // Simulate conservative sync with full content "ABC"
        String fullMessage = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"ABC\"}]}}";
        handler.onMessage("assistant", fullMessage);
        callbackHandler.clear();

        // Now try to send a duplicate delta "C" which is already in "ABC"
        handler.onMessage("content_delta", "C");

        // Should NOT notify frontend about the duplicate delta
        assertTrue("Duplicate delta should not be notified",
                callbackHandler.contentDeltas.isEmpty());
    }

    /**
     * Test that replayed chunks are skipped after a conservative full-message sync.
     */
    @Test
    public void handleContentDelta_skipsChunkedReplayAfterConservativeSync() {
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "A");
        callbackHandler.clear();

        // Full assistant snapshot advanced the backend state from "A" to "ABC".
        String fullMessage = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"ABC\"}]}}";
        handler.onMessage("assistant", fullMessage);
        callbackHandler.clear();

        // The SDK can still deliver the already-synced tail as small deltas.
        handler.onMessage("content_delta", "B");
        handler.onMessage("content_delta", "C");

        assertTrue("Chunked replay should not be notified",
                callbackHandler.contentDeltas.isEmpty());

        handler.onMessage("content_delta", "D");
        assertEquals("Novel content after replay should still be notified",
                List.of("D"), callbackHandler.contentDeltas);
    }

    /**
     * Test that a delta partially covered by conservative sync only forwards its novel suffix.
     */
    @Test
    public void handleContentDelta_trimsSyncedPrefixFromPartialReplay() {
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "A");
        callbackHandler.clear();

        String fullMessage = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"ABC\"}]}}";
        handler.onMessage("assistant", fullMessage);
        callbackHandler.clear();

        handler.onMessage("content_delta", "BCD");

        assertEquals("Only the unsynced suffix should be notified",
                List.of("D"), callbackHandler.contentDeltas);
    }

    /**
     * Test replay skipping across tool-separated text blocks.
     */
    @Test
    public void handleContentDelta_skipsReplayAcrossToolSeparatedTextBlocks() {
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Before.");
        callbackHandler.clear();

        String fullMessage = "{\"type\":\"assistant\",\"message\":{\"content\":["
                + "{\"type\":\"text\",\"text\":\"Before.\"},"
                + "{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Read\"},"
                + "{\"type\":\"text\",\"text\":\"After.\"}"
                + "]}}";
        handler.onMessage("assistant", fullMessage);
        callbackHandler.clear();

        handler.onMessage("content_delta", "Aft");
        handler.onMessage("content_delta", "er.");

        assertTrue("Tool-separated replay should not be notified",
                callbackHandler.contentDeltas.isEmpty());

        handler.onMessage("content_delta", " Done.");
        assertEquals("Novel text after tool-separated replay should still be notified",
                List.of(" Done."), callbackHandler.contentDeltas);
    }

    /**
     * Test that thinking deltas replayed after a full assistant snapshot are skipped.
     */
    @Test
    public void handleThinkingDelta_skipsChunkedReplayAfterConservativeSync() {
        handler.onMessage("stream_start", "");

        String fullMessage = "{\"type\":\"assistant\",\"message\":{\"content\":["
                + "{\"type\":\"thinking\",\"thinking\":\"Let me think\",\"text\":\"Let me think\"}"
                + "]}}";
        handler.onMessage("assistant", fullMessage);
        callbackHandler.clear();

        handler.onMessage("thinking_delta", "Let ");
        handler.onMessage("thinking_delta", "me ");
        handler.onMessage("thinking_delta", "think");

        assertTrue("Chunked thinking replay should not be notified",
                callbackHandler.thinkingDeltas.isEmpty());

        handler.onMessage("thinking_delta", " more");
        assertEquals("Novel thinking after replay should still be notified",
                List.of(" more"), callbackHandler.thinkingDeltas);
    }

    /**
     * Test that non-duplicate delta is processed normally.
     */
    @Test
    public void handleContentDelta_processesNonDuplicateNormally() {
        // Simulate stream start
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // Send a normal delta "ABC"
        handler.onMessage("content_delta", "ABC");

        // Should notify frontend
        assertEquals("Non-duplicate delta should be notified",
                List.of("ABC"), callbackHandler.contentDeltas);

        callbackHandler.clear();

        // Send another non-duplicate delta "DEF"
        handler.onMessage("content_delta", "DEF");

        // Should notify frontend
        assertEquals("Second non-duplicate delta should be notified",
                List.of("DEF"), callbackHandler.contentDeltas);
    }

    /**
     * Test that thinking delta is processed when not duplicate.
     */
    @Test
    public void handleThinkingDelta_processesNonDuplicateNormally() {
        // Simulate stream start
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // Send a thinking delta directly - handleThinkingDelta sets isThinking internally
        handler.onMessage("thinking_delta", "Let me think");

        // Should notify frontend
        assertEquals("Non-duplicate thinking delta should be notified",
                List.of("Let me think"), callbackHandler.thinkingDeltas);
    }

    @Test
    public void handleThinkingDelta_doesNotPushFullMessageUpdatesDuringStreaming() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("thinking_delta", "first ");
        handler.onMessage("thinking_delta", "second");

        assertEquals("Thinking deltas should still stream through the delta channel",
                List.of("first ", "second"), callbackHandler.thinkingDeltas);
        assertEquals("Full message snapshots during thinking deltas duplicate frontend buffers",
                0, callbackHandler.messageUpdateCount);
    }

    /**
     * Test that syncedContentOffset is reset on stream end.
     */
    @Test
    public void streamEnd_resetsSyncedContentOffset() {
        // Simulate stream start
        handler.onMessage("stream_start", "");

        // Send some content
        handler.onMessage("content_delta", "ABC");

        // End stream
        handler.onMessage("stream_end", "");

        // Start a new stream
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // Send a new delta (should not be dedup'd because offset was reset)
        handler.onMessage("content_delta", "ABC");

        // Should notify frontend (not dedup'd)
        assertEquals("Delta after stream end reset should be notified",
                List.of("ABC"), callbackHandler.contentDeltas);
    }

    /**
     * Test that syncedThinkingOffset is reset on stream end.
     */
    @Test
    public void streamEnd_resetsSyncedThinkingOffset() {
        // Simulate stream start
        handler.onMessage("stream_start", "");

        // Send thinking delta directly - handleThinkingDelta sets isThinking internally
        handler.onMessage("thinking_delta", "Analysis");

        // End stream
        handler.onMessage("stream_end", "");

        // Start a new stream
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // Send the same delta (should not be dedup'd because offset was reset)
        handler.onMessage("thinking_delta", "Analysis");

        // Should notify frontend (not dedup'd because offset was reset)
        assertEquals("Thinking delta after stream end reset should be notified",
                List.of("Analysis"), callbackHandler.thinkingDeltas);
    }

    /**
     * Test that very short delta (single char) matching suffix is dedup'd.
     * This is a known trade-off documented in the code.
     */
    @Test
    public void handleContentDelta_shortDeltaSuffixMatchIsDedupd() {
        // Simulate stream start
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // Simulate conservative sync with content "A"
        String fullMessage = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"A\"}]}}";
        handler.onMessage("assistant", fullMessage);
        callbackHandler.clear();

        // Send delta "A" - matches the suffix of existing content "A"
        handler.onMessage("content_delta", "A");

        // Should be dedup'd (this is the documented trade-off)
        assertTrue("Short delta suffix match should be dedup'd",
                callbackHandler.contentDeltas.isEmpty());
    }

    /**
     * Test that dedup does not trigger when syncedContentOffset is zero.
     */
    @Test
    public void handleContentDelta_noDedupWhenOffsetIsZero() {
        // Simulate stream start (syncedContentOffset is 0)
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        // Send delta "A" - offset is 0, no dedup
        handler.onMessage("content_delta", "A");

        // Should be processed (offset is 0, no dedup)
        assertEquals("First delta should be processed when offset is zero",
                List.of("A"), callbackHandler.contentDeltas);
    }

    @Test
    public void handleContentDelta_doesNotClassifyToolTraceTextWithoutParserSignal() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("content_delta", "Built-in Tool: inspect_asset\n");
        handler.onMessage("content_delta", "Output: screen analysis");

        assertEquals("Message handler should not guess tool trace text from content deltas", List.of("Built-in Tool: inspect_asset\n", "Output: screen analysis"), callbackHandler.contentDeltas);
        assertTrue("Parser-classified thinking_delta is the only route to thinking", callbackHandler.thinkingDeltas.isEmpty());
    }

    @Test
    public void handleThinkingDelta_streamsParserClassifiedToolTraceToThinking() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("thinking_delta", "Built-in Tool: inspect_asset\n");
        handler.onMessage("thinking_delta", "Output: screen analysis");

        assertTrue("Parser-classified tool trace should not stream as chat content",
                callbackHandler.contentDeltas.isEmpty());
        assertEquals("Parser-classified tool trace should stream through thinking", List.of("Built-in Tool: inspect_asset\n", "Output: screen analysis"),
                callbackHandler.thinkingDeltas);
    }

    @Test
    public void handleContentDelta_doesNotRouteOutputWithoutImageContext() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("content_delta", "Output: final answer");

        assertEquals("Normal text should stream as chat content without image context",
                List.of("Output: final answer"), callbackHandler.contentDeltas);
        assertTrue("Normal text should not become thinking without image context",
                callbackHandler.thinkingDeltas.isEmpty());
    }

    @Test
    public void handleContentDelta_doesNotDelayProviderLikePrefixes() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("content_delta", "Z");
        assertEquals("Normal text should not be delayed for provider-specific marker matching",
                List.of("Z"), callbackHandler.contentDeltas);

        handler.onMessage("content_delta", "ebra");

        assertEquals("Non-marker text should be released as normal content",
                List.of("Z", "ebra"), callbackHandler.contentDeltas);
        assertTrue("Non-marker text should not become thinking",
                callbackHandler.thinkingDeltas.isEmpty());
    }

    @Test
    public void messageStartDuringStreamingNotifiesFrontendBlockResetForNewAssistantCard() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("content_delta", "第一段");
        handler.onMessage("message_start", "");
        handler.onMessage("content_delta", "第二段");

        assertEquals("Frontend must be told to open a new streaming assistant card",
                1, callbackHandler.blockResetCount);
        assertEquals(2, state.getMessages().size());
        assertEquals("第一段", state.getMessages().get(0).content);
        assertEquals("第二段", state.getMessages().get(1).content);
    }

    @Test
    public void firstMessageStartDuringStreamingDoesNotCreateEmptyFrontendCard() {
        handler.onMessage("stream_start", "");
        callbackHandler.clear();

        handler.onMessage("message_start", "");
        handler.onMessage("content_delta", "第一段");

        assertEquals(0, callbackHandler.blockResetCount);
        assertEquals(1, state.getMessages().size());
        assertEquals("第一段", state.getMessages().get(0).content);
    }

    @Test
    public void cliToolUseEventIsMergedIntoCurrentAssistantMessageForRealtimeRendering() {
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "现在更新文件：");
        callbackHandler.clear();

        handler.onMessage("tool_use", "{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Edit\",\"input\":{\"file_path\":\"Plant.java\"}}");

        assertEquals(1, state.getMessages().size());
        ClaudeSession.Message message = state.getMessages().get(0);
        assertEquals("现在更新文件：", message.content);
        com.google.gson.JsonArray blocks = message.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("text", blocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("tool_use", blocks.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("tool-1", blocks.get(1).getAsJsonObject().get("id").getAsString());
        assertEquals(1, callbackHandler.messageUpdateCount);
    }

    @Test
    public void onCompleteWithStructuredErrorAddsProviderErrorBlockToAssistantMessage() {
        com.github.claudecodegui.provider.common.SDKResult result = new com.github.claudecodegui.provider.common.SDKResult();
        result.success = false;
        result.error = "当前模型不支持图片识别，或该服务商的 Claude Code 兼容接口不支持图片工具结果。";

        handler.onComplete(result);

        assertFalse("Structured completion error should be added to chat", state.getMessages().isEmpty());
        ClaudeSession.Message last = state.getMessages().get(state.getMessages().size() - 1);
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, last.type);
        assertEquals(result.error, last.content);

        com.google.gson.JsonArray blocks = last.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        com.google.gson.JsonObject errorBlock = blocks.get(blocks.size() - 1).getAsJsonObject();
        assertEquals("provider_error", errorBlock.get("type").getAsString());
        assertEquals("claude", errorBlock.get("provider").getAsString());
        assertEquals(result.error, errorBlock.get("details").getAsString());
    }

    @Test
    public void onErrorAppendsProviderErrorBlockToExistingAssistantMessage() {
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial answer");

        handler.onError("Claude CLI 请求失败，原因：服务暂时不可用 (503)");

        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertEquals(1, state.getMessages().size());
        ClaudeSession.Message message = state.getMessages().get(0);
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, message.type);
        assertTrue(message.content.contains("partial answer"));
        assertTrue(message.content.contains("Claude CLI 请求失败"));

        com.google.gson.JsonArray blocks = message.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("text", blocks.get(0).getAsJsonObject().get("type").getAsString());
        com.google.gson.JsonObject errorBlock = blocks.get(blocks.size() - 1).getAsJsonObject();
        assertEquals("provider_error", errorBlock.get("type").getAsString());
        assertEquals("claude", errorBlock.get("provider").getAsString());
        assertEquals("Claude CLI 请求失败，原因：服务暂时不可用 (503)",
                errorBlock.get("details").getAsString());
    }

    /**
     * Recording callback handler that captures all notifications for testing.
     * Extends CallbackHandler and overrides relevant methods.
     */
    private static class RecordingCallbackHandler extends CallbackHandler {
        final List<String> contentDeltas = new ArrayList<>();
        final List<String> thinkingDeltas = new ArrayList<>();
        int streamStartCount = 0;
        int streamEndCount = 0;
        int messageUpdateCount = 0;
        int blockResetCount = 0;

        void clear() {
            contentDeltas.clear();
            thinkingDeltas.clear();
            messageUpdateCount = 0;
            blockResetCount = 0;
        }

        @Override
        public void notifyContentDelta(String delta) {
            contentDeltas.add(delta);
        }

        @Override
        public void notifyThinkingDelta(String delta) {
            thinkingDeltas.add(delta);
        }

        @Override
        public void notifyMessageUpdate(List<ClaudeSession.Message> messages) {
            messageUpdateCount++;
        }

        @Override
        public void notifyStreamStart() {
            streamStartCount++;
        }

        @Override
        public void notifyStreamEnd() {
            streamEndCount++;
        }

        @Override
        public void notifyBlockReset() {
            blockResetCount++;
        }
    }
}
