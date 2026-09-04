package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.permission.PermissionRequest;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for translating Codex bridge events into provider-neutral session state.
 */
public class CodexMessageHandlerTest {

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        int streamStartCount = 0;
        int streamEndCount = 0;
        int stateChangeCount = 0;
        int messageUpdateCount = 0;
        boolean lastLoading = false;
        boolean lastBusy = false;
        final List<String> contentDeltas = new ArrayList<>();
        final List<String> thinkingDeltas = new ArrayList<>();
        final List<Message> lastMessages = new ArrayList<>();
        // Story 1.3: records the conversation ids notified through the session
        // callback so the session_id hop can be asserted end to end.
        final List<String> sessionIds = new ArrayList<>();
        // Records the relative order of stream-end vs message-update callbacks so a
        // test can assert stream-end fires BEFORE the error snapshot is pushed.
        final List<String> callOrder = new ArrayList<>();
        // Story 1.9: records the context-ring notifications (used, max) so the
        // [USAGE]-marker path can be asserted end to end.
        final List<int[]> usageUpdates = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<Message> messages) {
            messageUpdateCount++;
            callOrder.add("messageUpdate");
            lastMessages.clear();
            lastMessages.addAll(messages);
        }

        @Override
        public void onUsageUpdate(int usedTokens, int maxTokens) {
            usageUpdates.add(new int[]{usedTokens, maxTokens});
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
            stateChangeCount++;
            lastBusy = busy;
            lastLoading = loading;
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
            sessionIds.add(sessionId);
        }

        @Override
        public void onPermissionRequested(PermissionRequest request) {
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
        }

        @Override
        public void onSlashCommandsReceived(List<String> slashCommands) {
        }

        @Override
        public void onNodeLog(String log) {
        }

        @Override
        public void onSummaryReceived(String summary) {
        }

        @Override
        public void onStreamStart() {
            streamStartCount++;
        }

        @Override
        public void onStreamEnd() {
            streamEndCount++;
            callOrder.add("streamEnd");
        }

        @Override
        public void onContentDelta(String delta) {
            contentDeltas.add(delta);
        }

        @Override
        public void onThinkingDelta(String delta) {
            thinkingDeltas.add(delta);
        }
    }

    @Test
    public void streamMarkersDriveStandardStreamingLifecycle() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "done");
        handler.onMessage("stream_end", "");

        assertEquals(1, callback.streamStartCount);
        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertTrue(callback.messageUpdateCount >= 2);
        assertEquals("done", callback.lastMessages.get(callback.lastMessages.size() - 1).content);
    }

    @Test
    public void contentDeltaIsForwardedToFrontendStreamingCallback() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "hello");
        handler.onMessage("content_delta", " world");

        assertEquals(List.of("hello", " world"), callback.contentDeltas);
        assertEquals("hello world", state.getMessages().get(0).content);
    }

    @Test
    public void sessionIdEventStoresConversationIdOnTheSessionSlotAndNotifies() {
        // Story 1.3 Task 1: the bridge's "session_id" event (gemini: the
        // conversation UUID emitted with [SESSION_ID]) must land on the single
        // session-id slot — the next send reads it back and resumes the
        // conversation via --conversation — and reach the webview through the
        // session callback. (Duplicate suppression lives in
        // SessionCallbackAdapter, pinned by
        // SessionCallbackAdapterStreamEndTest.duplicateSessionIdsAreForwardedOnlyOnce.)
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("session_id", "d5451c2b-751a-4248-9d75-47344e4bc885");

        assertEquals("d5451c2b-751a-4248-9d75-47344e4bc885", state.getSessionId());
        assertEquals(List.of("d5451c2b-751a-4248-9d75-47344e4bc885"), callback.sessionIds);
    }

    @Test
    public void blankSessionIdEventIsIgnored() {
        // A blank id would wipe a known conversation id off the slot and make
        // the next send start a new conversation — never forward it.
        SessionState state = new SessionState();
        state.setSessionId("existing-conversation-id");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("session_id", "  ");

        assertEquals("existing-conversation-id", state.getSessionId());
        assertTrue(callback.sessionIds.isEmpty());
    }

    @Test
    public void finalAssistantMessageReusesStreamingPlaceholderInsteadOfAppendingDuplicate() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "收到，测试正常。");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"收到，测试正常。\"}]}}");

        assertEquals(1, state.getMessages().size());
        assertEquals("收到，测试正常。", state.getMessages().get(0).content);
        assertTrue(state.getMessages().get(0).raw != null);
    }

    @Test
    public void thinkingDeltaIsForwardedAndPreservedWhenFinalTextSnapshotArrives() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking_delta", "先分析");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\"先分析\",\"text\":\"先分析\"}]}}");
        handler.onMessage("content_delta", "结论");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"结论\"}]}}");

        assertEquals(List.of("先分析"), callback.thinkingDeltas);
        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals("结论", message.content);
        var blocks = message.raw.getAsJsonObject("message").getAsJsonArray("content");
        assertEquals("thinking", blocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("先分析", blocks.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("text", blocks.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("结论", blocks.get(1).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void userMessageStripsCodexInjectedInstructionsFromContentAndRawBlocks() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\","
                + "\"text\":\"<agents-instructions>\\n# AGENTS.md instructions\\n"
                + "<INSTRUCTIONS>中文回复</INSTRUCTIONS>\\n</agents-instructions>\\n\\n测试通讯\"}]}}");

        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals("测试通讯", message.content);
        assertEquals("测试通讯", message.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content")
                .get(0)
                .getAsJsonObject()
                .get("text")
                .getAsString());
    }

    @Test
    public void userMessageWithOnlyCodexInjectedInstructionsIsFiltered() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"<agents-instructions>\\n# AGENTS.md instructions\\n</agents-instructions>\"}]}}");

        assertEquals(0, state.getMessages().size());
        assertEquals(0, callback.messageUpdateCount);
    }

    @Test
    public void userMessageWithOnlySkillMetadataIsFiltered() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\","
                + "\"text\":\"<skill>\\n<name>autopilot</name>\\n<path>/tmp/SKILL.md</path>\\n</skill>\"}]}}");

        assertEquals(0, state.getMessages().size());
        assertEquals(0, callback.messageUpdateCount);
    }

    @Test
    public void userMessageStripsCodexImagePlaceholderFromContentAndRawBlocks() throws Exception {
        Path imagePath = Files.createTempFile("codex-live-image", ".png");
        Files.write(imagePath, "png-bytes".getBytes(StandardCharsets.UTF_8));
        SessionState state = new SessionState();

        try {
            CallbackHandler callbackHandler = new CallbackHandler();
            RecordingCallback callback = new RecordingCallback();
            callbackHandler.setCallback(callback);

            CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", "<image name=[Image #1] path=\"" + imagePath
                    + "\">\n</image>\n\n测试通讯");
            JsonArray inputBlocks = new JsonArray();
            inputBlocks.add(textBlock);
            JsonObject inputMessage = new JsonObject();
            inputMessage.addProperty("role", "user");
            inputMessage.add("content", inputBlocks);
            JsonObject payload = new JsonObject();
            payload.add("message", inputMessage);
            handler.onMessage("user", payload.toString());

            assertEquals(1, state.getMessages().size());
            Message message = state.getMessages().get(0);
            assertEquals("测试通讯", message.content);
            JsonArray contentBlocks = message.raw
                    .getAsJsonObject("message")
                    .getAsJsonArray("content");
            assertEquals(2, contentBlocks.size());
            assertEquals("image", contentBlocks.get(0).getAsJsonObject().get("type").getAsString());
            assertTrue(contentBlocks.get(0).getAsJsonObject().get("src").getAsString().startsWith("data:image/png;base64,"));
            assertEquals("测试通讯", contentBlocks.get(1).getAsJsonObject().get("text").getAsString());
        } finally {
            Files.deleteIfExists(imagePath);
        }
    }

    @Test
    public void onCompleteFinalizesStreamingTurnWhenStreamEndIsMissing() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial");
        handler.onComplete(new SDKResult());

        assertEquals(1, callback.streamStartCount);
        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertFalse(callback.lastBusy);
        assertFalse(callback.lastLoading);
    }

    @Test
    public void streamEndFinalizesTurnEvenWhenStreamStartIsMissing() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("stream_end", "");

        assertEquals(0, callback.streamStartCount);
        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertFalse(callback.lastBusy);
        assertFalse(callback.lastLoading);
    }

    @Test
    public void onCompleteWithoutStreamingOnlyClearsState() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onComplete(new SDKResult());

        assertEquals(0, callback.streamStartCount);
        assertEquals(0, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertFalse(callback.lastBusy);
        assertFalse(callback.lastLoading);
    }

    /**
     * Verifies that result usage remains available for per-turn accounting without
     * being promoted to an untrusted current-context snapshot.
     */
    @Test
    public void resultMessageStampsNormalizedTurnUsageOnLastAssistant() {
        SessionState state = new SessionState();
        state.setModel("gpt-5.1");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        // ai-bridge Claude-compatible usage: input_tokens INCLUDE cached tokens (OpenAI convention)
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":37000,\"output_tokens\":353,"
                + "\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":36310}}");

        Message message = state.getMessages().get(0);
        assertFalse(message.raw.has("usage"));
        // turnUsage is normalized to the Claude schema: input excludes cache
        var turnUsage = message.raw.getAsJsonObject("turnUsage");
        assertEquals(690, turnUsage.get("input_tokens").getAsInt());
        assertEquals(36310, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(0, turnUsage.get("cache_creation_input_tokens").getAsInt());
        assertEquals(353, turnUsage.get("output_tokens").getAsInt());
        assertEquals(0.00893125, message.raw.get("turnCostUsd").getAsDouble(), 0.0000001);
    }

    @Test
    public void resultMessageAcceptsCodexCachedInputTokenAlias() {
        SessionState state = new SessionState();
        state.setModel("gpt-5.1");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":37000,\"output_tokens\":353,\"cached_input_tokens\":36310}}");

        Message message = state.getMessages().get(0);
        var turnUsage = message.raw.getAsJsonObject("turnUsage");
        assertEquals(690, turnUsage.get("input_tokens").getAsInt());
        assertEquals(36310, turnUsage.get("cache_read_input_tokens").getAsInt());
        assertEquals(0.00893125, message.raw.get("turnCostUsd").getAsDouble(), 0.0000001);
    }

    @Test
    public void resultMessageDoesNotStampTurnCostWhenModelHasNoPricing() {
        SessionState state = new SessionState();
        state.setModel("custom-codex-without-pricing");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":1200,\"output_tokens\":456}}");

        Message message = state.getMessages().get(0);
        assertTrue(message.raw.has("turnUsage"));
        assertFalse(message.raw.has("turnCostUsd"));
    }

    /**
     * Verifies session-cumulative token_count data is never reused as the active
     * context snapshot when last_token_usage is unavailable.
     */
    @Test
    public void tokenCountEventIgnoresCumulativeUsageWithoutLastUsage() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"total_token_usage\":{\"input_tokens\":500000,\"output_tokens\":9000,\"cached_input_tokens\":480000}}}}");

        Message message = state.getMessages().get(0);
        assertFalse(message.raw.has("usage"));
        assertFalse(message.raw.has("turnUsage"));
    }

    /**
     * Verifies that last_token_usage supplies the current-context numerator and
     * preserves the provider-reported context-window denominator.
     */
    @Test
    public void tokenCountEventUsesLastTurnUsageForContextStatus() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"total_token_usage\":{\"input_tokens\":311400,\"output_tokens\":9000,\"cached_input_tokens\":280000},"
                + "\"last_token_usage\":{\"input_tokens\":180000,\"output_tokens\":2400,\"cached_input_tokens\":160000}"
                + ",\"model_context_window\":258400}}}");

        Message message = state.getMessages().get(0);
        assertEquals(180000, message.raw.getAsJsonObject("usage").get("input_tokens").getAsInt());
        assertEquals(2400, message.raw.getAsJsonObject("usage").get("output_tokens").getAsInt());
        assertEquals(160000, message.raw.getAsJsonObject("usage").get("cache_read_input_tokens").getAsInt());
        assertEquals(258400, message.raw.getAsJsonObject("usage").get("model_context_window").getAsInt());
        assertFalse(message.raw.has("turnUsage"));
    }

    /**
     * Verifies that a trusted token_count context snapshot survives the later result
     * message while result usage remains confined to turn accounting.
     */
    @Test
    public void resultUsageDoesNotReplaceCurrentTokenCountUsage() {
        SessionState state = new SessionState();

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"total_token_usage\":{\"input_tokens\":13007800,\"output_tokens\":9000,\"cached_input_tokens\":12000000},"
                + "\"last_token_usage\":{\"input_tokens\":180000,\"output_tokens\":2400,\"cached_input_tokens\":160000}"
                + "}}}");
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":13007800,\"output_tokens\":9000,\"cached_input_tokens\":12000000}}}");

        Message message = state.getMessages().get(0);
        assertEquals(180000, message.raw.getAsJsonObject("usage").get("input_tokens").getAsInt());
        assertEquals(2400, message.raw.getAsJsonObject("usage").get("output_tokens").getAsInt());
    }

    /**
     * Verifies that token_count arriving before the assistant is retained and attached
     * when the result later provides the per-turn accounting payload.
     */
    @Test
    public void tokenCountBeforeAssistantIsAppliedWhenResultArrives() {
        SessionState state = new SessionState();
        state.setModel("gpt-5.1");

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("event_msg", "{\"payload\":{\"type\":\"token_count\",\"info\":{"
                + "\"last_token_usage\":{\"input_tokens\":49060,\"output_tokens\":231,"
                + "\"cached_input_tokens\":46848},\"model_context_window\":258400}}}");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}");
        handler.onMessage("result", "{\"type\":\"result\",\"subtype\":\"usage\",\"usage\":{"
                + "\"input_tokens\":53383,\"output_tokens\":69,\"cached_input_tokens\":48896}}");

        Message message = state.getMessages().get(0);
        JsonObject contextUsage = message.raw.getAsJsonObject("usage");
        assertEquals(49060, contextUsage.get("input_tokens").getAsInt());
        assertEquals(231, contextUsage.get("output_tokens").getAsInt());
        assertEquals(258400, contextUsage.get("model_context_window").getAsInt());
        assertEquals(4487, message.raw.getAsJsonObject("turnUsage").get("input_tokens").getAsInt());
        assertEquals(48896, message.raw.getAsJsonObject("turnUsage").get("cache_read_input_tokens").getAsInt());
        assertEquals(69, message.raw.getAsJsonObject("turnUsage").get("output_tokens").getAsInt());
    }

    @Test
    public void messageEndDoesNotDuplicateStreamEndAfterNormalCompletion() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "answer");
        handler.onMessage("stream_end", "");
        handler.onMessage("message_end", "");

        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
    }

    @Test
    public void onErrorSignalsStreamEndBeforeErrorSnapshotWhileStreaming() {
        // Regression (PR #1421 symmetric fix): the webview's onStreamEnd cancels any
        // pending updateMessages rAF. If onError pushes the error snapshot BEFORE
        // stream-end, that cancellation drops it and the "API request failed" bubble
        // never renders. On a streaming turn, stream-end must fire first.
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial");

        handler.onError("API request failed");

        assertEquals(1, callback.streamEndCount);
        int streamEndIdx = callback.callOrder.indexOf("streamEnd");
        int lastUpdateIdx = callback.callOrder.lastIndexOf("messageUpdate");
        assertTrue("stream-end must precede the error-snapshot message update",
                streamEndIdx >= 0 && streamEndIdx < lastUpdateIdx);
        assertEquals(Message.Type.ERROR,
                callback.lastMessages.get(callback.lastMessages.size() - 1).type);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
    }

    @Test
    public void onErrorWithoutActiveStreamPushesErrorWithoutStreamEnd() {
        // A non-streaming Codex turn maps to the webview's 'minimal' stream-end mode,
        // which would only cancel pending updates without buying any dangling-tool
        // cleanup — so onError intentionally does NOT emit stream-end here. The error
        // snapshot is pushed directly and renders on its own.
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onError("API request failed");

        assertEquals(0, callback.streamEndCount);
        assertEquals(Message.Type.ERROR,
                callback.lastMessages.get(callback.lastMessages.size() - 1).type);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
    }

    // -----------------------------------------------------------------------
    // Story 1.9 — token usage accounting (AC1–AC4).
    //
    // The gemini CLI bridge delivers turn usage through the shared [USAGE]
    // marker (MarkerCliBridge → onMessage("usage", <canonical json>)). The
    // canonical wire shape is the claude emitUsageTag shape every consumer
    // already reads (TokenUsageUtils, the webview footer's turnUsage reader):
    // input_tokens / output_tokens / cache_creation_input_tokens /
    // cache_read_input_tokens, plus an additive thinking_tokens.
    //
    // Gemini follows TokenUsageUtils' "others" profile: input_tokens is
    // reported cache-exclusive and stays VERBATIM in turnUsage — the codex
    // buildTurnUsage convention (input includes cache → subtract cacheRead)
    // must NOT be applied. thinking_tokens passes through for display but is
    // excluded from the context-ring math (input + cache_creation + cache_read).

    private static final String GEMINI_CANONICAL_USAGE =
            "{\"input_tokens\":18814,\"output_tokens\":208,\"cache_read_input_tokens\":0,\"thinking_tokens\":207}";

    private Message lastAssistantMessage(CodexMessageHandler handler, SessionState state) {
        List<Message> messages = state.getMessages();
        for (int i = messages.size() - 1; i >= 0; i--) {
            if (messages.get(i).type == Message.Type.ASSISTANT) {
                return messages.get(i);
            }
        }
        return null;
    }

    @Test
    public void usageMarkerStampsCanonicalUsageTurnUsageAndContextRing() {
        SessionState state = new SessionState();
        state.setModel("gemini-3.6-flash-medium");
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Answer.");
        handler.onMessage("usage", GEMINI_CANONICAL_USAGE);
        handler.onMessage("stream_end", "");

        Message assistant = lastAssistantMessage(handler, state);
        assertTrue("usage must stamp the current assistant message", assistant != null && assistant.raw != null);

        // message.usage carries the canonical object verbatim (thinking included).
        assertTrue("message.usage must be stamped", assistant.raw.has("message"));
        JsonObject messageUsage = assistant.raw.getAsJsonObject("message").getAsJsonObject("usage");
        assertEquals(18814, messageUsage.get("input_tokens").getAsInt());
        assertEquals(208, messageUsage.get("output_tokens").getAsInt());
        assertEquals(207, messageUsage.get("thinking_tokens").getAsInt());

        // Root turnUsage records the reported figures verbatim — gemini's
        // input is cache-exclusive ("others" profile), no codex subtraction.
        assertTrue("root turnUsage must be stamped for the per-turn footer",
                assistant.raw.has("turnUsage"));
        JsonObject turnUsage = assistant.raw.getAsJsonObject("turnUsage");
        assertEquals(18814, turnUsage.get("input_tokens").getAsInt());
        assertEquals(208, turnUsage.get("output_tokens").getAsInt());
        assertEquals(207, turnUsage.get("thinking_tokens").getAsInt());

        // Unknown model → cost is null → turnCostUsd is never fabricated.
        assertFalse("turnCostUsd must stay absent for unknown models",
                assistant.raw.has("turnCostUsd"));

        // Context ring: one notification, used = input + cache sums (thinking
        // excluded), max = the model's registered context limit.
        assertEquals(1, callback.usageUpdates.size());
        assertEquals(18814, callback.usageUpdates.get(0)[0]);
        int expectedMax = com.github.claudecodegui.handler.provider.ModelProviderHandler
                .getModelContextLimit(state.getModel());
        assertEquals(expectedMax, callback.usageUpdates.get(0)[1]);
    }

    @Test
    public void usageMarkerThinkingStaysOutOfContextRingMath() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Answer.");
        handler.onMessage("usage",
                "{\"input_tokens\":100,\"cache_creation_input_tokens\":30,"
                        + "\"cache_read_input_tokens\":500,\"output_tokens\":40,\"thinking_tokens\":207}");
        handler.onMessage("stream_end", "");

        Message assistant = lastAssistantMessage(handler, state);
        assertTrue(assistant != null && assistant.raw != null && assistant.raw.has("turnUsage"));
        assertEquals("input_tokens stays verbatim — no codex input-includes-cache subtraction",
                100, assistant.raw.getAsJsonObject("turnUsage").get("input_tokens").getAsInt());
        assertEquals("thinking passes through to the stored usage",
                207, assistant.raw.getAsJsonObject("turnUsage").get("thinking_tokens").getAsInt());

        // Ring math = input + cache_creation + cache_read (630), thinking NOT added.
        assertEquals(1, callback.usageUpdates.size());
        assertEquals(630, callback.usageUpdates.get(0)[0]);
    }

    @Test
    public void twoTurnsRecordExactlyTheirReportedFigures() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        // Turn 1 — reported: in 100 / out 20 / thinking 5.
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "one");
        handler.onMessage("usage",
                "{\"input_tokens\":100,\"output_tokens\":20,\"thinking_tokens\":5}");
        handler.onMessage("stream_end", "");
        // Turn 2 — reported: in 200 / out 30 / thinking 7.
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "two");
        handler.onMessage("usage",
                "{\"input_tokens\":200,\"output_tokens\":30,\"thinking_tokens\":7}");
        handler.onMessage("stream_end", "");

        List<Message> assistants = new ArrayList<>();
        for (Message m : state.getMessages()) {
            if (m.type == Message.Type.ASSISTANT && m.raw != null && m.raw.has("turnUsage")) {
                assistants.add(m);
            }
        }
        assertEquals("each reported turn stamps exactly its own message", 2, assistants.size());
        JsonObject first = assistants.get(0).raw.getAsJsonObject("turnUsage");
        JsonObject second = assistants.get(1).raw.getAsJsonObject("turnUsage");
        assertEquals(100, first.get("input_tokens").getAsInt());
        assertEquals(20, first.get("output_tokens").getAsInt());
        assertEquals(200, second.get("input_tokens").getAsInt());
        assertEquals(30, second.get("output_tokens").getAsInt());

        // Session totals (AC2) aggregate exactly the reported turns — no
        // cumulative bleed, no invented figures: 100+200 in / 20+30 out.
        int totalIn = first.get("input_tokens").getAsInt() + second.get("input_tokens").getAsInt();
        int totalOut = first.get("output_tokens").getAsInt() + second.get("output_tokens").getAsInt();
        assertEquals(300, totalIn);
        assertEquals(50, totalOut);
    }

    @Test
    public void usageMarkerWithAllZeroFiguresStampsNothing() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Answer.");
        handler.onMessage("usage",
                "{\"input_tokens\":0,\"output_tokens\":0,\"cache_read_input_tokens\":0,\"thinking_tokens\":0}");
        handler.onMessage("stream_end", "");

        assertTrue("a fabricated free turn must not be recorded", callback.usageUpdates.isEmpty());
        for (Message m : state.getMessages()) {
            assertFalse("no turnUsage may be stamped from an all-zero payload",
                    m.raw != null && m.raw.has("turnUsage"));
        }
    }

    @Test
    public void standardTurnWithoutUsageLeavesUsageUntouched() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "plain turn");
        handler.onMessage("stream_end", "");

        assertTrue(callback.usageUpdates.isEmpty());
        for (Message m : state.getMessages()) {
            assertFalse("no usage must appear when the provider reports none",
                    m.raw != null && (m.raw.has("turnUsage") || m.raw.has("turnCostUsd")));
        }
    }
}
