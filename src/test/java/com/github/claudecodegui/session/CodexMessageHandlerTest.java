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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for translating Codex bridge events into provider-neutral session state.
 */
public class CodexMessageHandlerTest {
    /** Errors belong to the submitted client identity even when a later user is already present. */
    @Test
    public void startupErrorKeepsTheSubmittingClientIdentity() {
        SessionState state = new SessionState();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler(), "submitted-client", completion);
        JsonObject laterUser = new JsonObject();
        laterUser.addProperty("clientMessageId", "later-client");
        state.addMessage(new Message(Message.Type.USER, "Later visible input", laterUser));

        handler.onError("thread has an active writer");

        Message error = state.getMessages().get(state.getMessages().size() - 1);
        assertEquals(Message.Type.ERROR, error.type);
        assertTrue("startup error must carry its own submission identity", error.raw != null);
        assertEquals("submitted-client", error.raw.get("clientMessageId").getAsString());
        assertEquals("thread has an active writer", error.content);
        assertTrue("startup errors must also release the remote turn", completion.isCompletedExceptionally());
    }

    /** Normalizes native and legacy image sources before replacing the visible user content. */
    @Test
    public void keepsNativeImageOnlyUserSnapshots() {
        for (String image : List.of("{\"type\":\"image\",\"url\":\"data:image/png;base64,fixture\"}",
                "{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,fixture\"}",
                "{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"media_type\":\"image/png\",\"data\":\"fixture\"}}")) {
            SessionState state = new SessionState();
            CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
            handler.onMessage("user", "{\"codexItemId\":\"picture\",\"codexSnapshot\":true,\"message\":{\"content\":[" + image + "]}}");
            assertEquals(1, state.getMessages().size());
            var block = state.getMessages().get(0).raw.getAsJsonObject("message").getAsJsonArray("content").get(0).getAsJsonObject();
            assertEquals("image", block.get("type").getAsString());
            assertEquals("data:image/png;base64,fixture", block.get("src").getAsString());
        }
    }
    /** Updates the original compaction boundary when its turn identity arrives late. */
    @Test
    public void promotesCompactionTurnIdentityWithoutDuplicatingTheBoundary() {
        SessionState state = new SessionState();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        handler.onMessage("assistant", """
                {"codexItemId":"cmp","codexThreadId":"t","codexTurnId":null,"uuid":"stable-cmp","codexSnapshot":true,"isCompactSummary":true,"message":{"content":[{"type":"text","text":""}]}}
                """);
        handler.onMessage("assistant", """
                {"codexItemId":"cmp","codexThreadId":"t","codexTurnId":"turn","uuid":"stable-cmp","codexSnapshot":true,"isCompactSummary":true,"summarizeMetadata":{"native":true,"status":"completed"},"message":{"content":[{"type":"text","text":""}]}}
                """);
        assertEquals(1, state.getMessages().size());
        assertEquals("turn", state.getMessages().get(0).raw.get("codexTurnId").getAsString());
        assertTrue(state.getMessages().get(0).raw.get("isCompactSummary").getAsBoolean());
    }

    @Test
    public void nativeStreamingSnapshotsReplaceEachItemInPlace() {
        SessionState state = new SessionState();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        handler.onMessage("stream_start", "");
        handler.onMessage("assistant", "{\"codexItemId\":\"one\",\"codexSnapshot\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"a\"}]}}");
        handler.onMessage("assistant", "{\"codexItemId\":\"two\",\"codexSnapshot\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"b\"}]}}");
        handler.onMessage("assistant", "{\"codexItemId\":\"one\",\"codexSnapshot\":true,\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"ab\"}]}}");
        assertEquals(2, state.getMessages().size());
        assertEquals("ab", state.getMessages().get(0).content);
        assertEquals("b", state.getMessages().get(1).content);
    }

    @Test
    public void finalMessageCompletesTurnBeforeProcessExitAndOutsideSessionLock() {
        SessionState state = new SessionState();
        state.beginTurn();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler(), "submitted-client", completion);
        AtomicInteger replies = new AtomicInteger();
        CompletableFuture<Void> reply = completion.thenRun(() -> {
            assertFalse(Thread.holdsLock(state.getMessageStateLock()));
            assertFalse(state.isBusy());
            assertFalse(state.isLoading());
            assertEquals("Context compacted", state.getMessages().get(state.getMessages().size() - 1).content);
            replies.incrementAndGet();
        });

        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "Context compacted");
        handler.onMessage("stream_end", "");
        assertFalse(completion.isDone());
        handler.onMessage("message_end", "");
        reply.join();
        assertEquals(1, replies.get());

        // Cleanup can finish much later; it must not change the successful result or reply twice.
        handler.onError("Process cleanup timed out");
        handler.onComplete(new SDKResult());
        handler.onMessage("message_end", "");
        assertEquals(1, replies.get());
        assertEquals(null, state.getError());
    }

    @Test
    public void streamEndWaitsForFallbackTextOrErrorInsteadOfReportingSuccessEarly() {
        SessionState state = new SessionState();
        state.beginTurn();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler(), completion);
        handler.onMessage("stream_start", "");
        handler.onMessage("stream_end", "");
        assertFalse(completion.isDone());
        handler.onMessage("assistant", "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\","
                + "\"content\":[{\"type\":\"text\",\"text\":\"No text response\"}]}}");
        handler.onMessage("message_end", "");
        assertTrue(completion.isDone());
        assertFalse(completion.isCompletedExceptionally());
        assertEquals("No text response", state.getMessages().get(0).content);

        state.beginTurn();
        CompletableFuture<Void> failed = new CompletableFuture<>();
        CodexMessageHandler failingHandler = new CodexMessageHandler(state, new CallbackHandler(), failed);
        failingHandler.onMessage("stream_start", "");
        failingHandler.onMessage("stream_end", "");
        failingHandler.onError("Turn failed");
        assertTrue(failed.isCompletedExceptionally());
        assertEquals("Turn failed", state.getError());
    }

    @Test
    public void successfulMessageEndWithoutStreamEndClearsBusyState() {
        SessionState state = new SessionState();
        state.beginTurn();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler(), completion);
        handler.onMessage("stream_start", "");
        handler.onMessage("message_end", "");
        assertTrue(completion.isDone());
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
    }

    @Test
    public void processCompletionStillFinishesTurnsWithoutMessageEnd() {
        SessionState state = new SessionState();
        state.beginTurn();
        CompletableFuture<Void> completion = new CompletableFuture<>();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler(), completion);
        handler.onMessage("stream_start", "");
        handler.onComplete(new SDKResult());
        assertTrue(completion.isDone());
        assertFalse(state.isBusy());
    }

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        int streamStartCount = 0;
        int streamEndCount = 0;
        int stateChangeCount = 0;
        int messageUpdateCount = 0;
        boolean lastLoading = false;
        boolean lastBusy = false;
        String lastStateError;
        final List<String> contentDeltas = new ArrayList<>();
        final List<String> thinkingDeltas = new ArrayList<>();
        final List<Message> lastMessages = new ArrayList<>();
        // Records the relative order of stream-end vs message-update callbacks so a
        // test can assert stream-end fires BEFORE the error snapshot is pushed.
        final List<String> callOrder = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<Message> messages) {
            messageUpdateCount++;
            callOrder.add("messageUpdate");
            lastMessages.clear();
            lastMessages.addAll(messages);
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
            stateChangeCount++;
            lastBusy = busy;
            lastLoading = loading;
            this.lastStateError = error;
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
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
    public void previousProcessCannotClearBusyStateAfterNextSendStarts() {
        SessionState state = new SessionState();
        CallbackHandler callbacks = new CallbackHandler();
        RecordingCallback recorded = new RecordingCallback();
        callbacks.setCallback(recorded);
        state.beginTurn();
        CodexMessageHandler previous = new CodexMessageHandler(state, callbacks);
        previous.onMessage("stream_start", "");
        previous.onMessage("stream_end", "");

        // The UI permits a send at stream_end, before the old process exits.
        state.beginTurn();
        previous.onComplete(new SDKResult());
        assertTrue(state.isBusy());
        assertTrue(state.isLoading());
        assertEquals(1, recorded.stateChangeCount);

        CodexMessageHandler current = new CodexMessageHandler(state, callbacks);
        current.onMessage("stream_start", "");
        current.onMessage("content_delta", "current answer");
        int updates = recorded.messageUpdateCount;
        previous.onMessage("content_delta", "stale answer");
        previous.onMessage("stream_end", "");
        previous.onError("old process exited");
        previous.onComplete(new SDKResult());

        assertTrue(state.isBusy());
        assertTrue(state.isLoading());
        assertEquals(null, state.getError());
        assertEquals(updates, recorded.messageUpdateCount);
        assertEquals(List.of("current answer"), recorded.contentDeltas);
        assertEquals(1, recorded.streamEndCount);
        current.onMessage("stream_end", "");
        current.onComplete(new SDKResult());
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertEquals(2, recorded.streamEndCount);
    }

    @Test
    public void replacedSessionIgnoresOldProviderCallbacks() {
        SessionState state = new SessionState();
        state.beginTurn();
        CallbackHandler callbacks = new CallbackHandler();
        RecordingCallback recorded = new RecordingCallback();
        callbacks.setCallback(recorded);
        CodexMessageHandler previous = new CodexMessageHandler(state, callbacks);
        state.rotateRuntimeSessionEpoch();

        previous.onMessage("session_id", "old-session");
        previous.onMessage("content_delta", "old answer");
        previous.onError("old error");
        previous.onComplete(new SDKResult());

        assertEquals(null, state.getSessionId());
        assertEquals(null, state.getError());
        assertTrue(state.isBusy());
        assertTrue(state.isLoading());
        assertEquals(0, recorded.stateChangeCount);
        assertEquals(0, recorded.messageUpdateCount);
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
    public void nativeUserMessageClientIdReplacesOptimisticMessage() {
        SessionState state = new SessionState();
        Message optimistic = new Message(Message.Type.USER, "same prompt");
        JsonObject optimisticRaw = new JsonObject();
        optimisticRaw.addProperty("clientMessageId", "cm-1");
        optimistic.raw = optimisticRaw;
        state.addMessage(optimistic);

        CallbackHandler callbackHandler = new CallbackHandler();
        callbackHandler.setCallback(new RecordingCallback());
        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"clientMessageId\":\"cm-1\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"same prompt\"}]}}");

        assertEquals(1, state.getMessages().size());
        assertEquals("cm-1", state.getMessages().get(0).raw.get("clientMessageId").getAsString());
        assertEquals("same prompt", state.getMessages().get(0).content);
    }

    @Test
    public void repeatedNativeItemSnapshotsUpsertOneMessage() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        callbackHandler.setCallback(new RecordingCallback());

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("assistant", "{\"codexItemId\":\"item-1\","
                + "\"codexAuthoritative\":false,\"message\":{\"content\":["
                + "{\"type\":\"text\",\"text\":\"partial\"}]}}");
        handler.onMessage("assistant", "{\"codexItemId\":\"item-1\","
                + "\"codexAuthoritative\":true,\"message\":{\"content\":["
                + "{\"type\":\"text\",\"text\":\"complete\"}]}}");
        handler.onMessage("assistant", "{\"codexItemId\":\"item-1\","
                + "\"codexAuthoritative\":true,\"message\":{\"content\":["
                + "{\"type\":\"text\",\"text\":\"complete\"}]}}");

        assertEquals(1, state.getMessages().size());
        assertEquals("complete", state.getMessages().get(0).content);
        assertEquals("item-1", state.getMessages().get(0).raw.get("codexItemId").getAsString());
    }

    @Test
    public void nativeUserConfirmationKeepsTheSubmittedImageForDisplay() {
        SessionState state = new SessionState();
        Message optimistic = new Message(Message.Type.USER, "inspect");
        optimistic.raw = com.google.gson.JsonParser.parseString("""
                {"clientMessageId":"image-client","message":{"content":[
                {"type":"image","source":{"type":"base64","data":"fixture-image"}},
                {"type":"text","text":"inspect"}]}}
                """).getAsJsonObject();
        state.addMessage(optimistic);
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        handler.onMessage("user", """
                {"clientMessageId":"image-client","codexItemId":"native-image",
                "message":{"content":[{"type":"localImage","path":"image.png"},
                {"type":"text","text":"inspect"}]}}
                """);
        assertEquals(1, state.getMessages().size());
        assertTrue(state.getMessages().get(0).raw.toString().contains("fixture-image"));
        assertEquals(2, state.getMessages().get(0).raw.getAsJsonObject("message").getAsJsonArray("content").size());
    }

    @Test
    public void equalPromptsWithDifferentClientIdsRemainSeparate() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        callbackHandler.setCallback(new RecordingCallback());

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"clientMessageId\":\"cm-1\",\"codexItemId\":\"u-1\","
                + "\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"same\"}]}}");
        handler.onMessage("user", "{\"clientMessageId\":\"cm-2\",\"codexItemId\":\"u-2\","
                + "\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"same\"}]}}");

        assertEquals(2, state.getMessages().size());
        assertEquals("cm-1", state.getMessages().get(0).raw.get("clientMessageId").getAsString());
        assertEquals("cm-2", state.getMessages().get(1).raw.get("clientMessageId").getAsString());
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
    public void startupFailureEndsTheOptimisticFrontendStreamBeforeItsErrorSnapshot() {
        // The frontend starts waiting before thread/start or thread/resume can fail.
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onError("thread fixture already has an active writer");

        assertEquals(1, callback.streamEndCount);
        assertTrue(callback.callOrder.indexOf("streamEnd") < callback.callOrder.lastIndexOf("messageUpdate"));
        assertEquals(Message.Type.ERROR,
                callback.lastMessages.get(callback.lastMessages.size() - 1).type);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
    }

    /** Native controls keep the failure in the transcript without requesting a second status toast. */
    @Test
    public void controlFailureKeepsItsErrorMessageButOmitsTheStatusError() {
        for (boolean control : List.of(false, true)) {
            SessionState state = new SessionState();
            state.setBusy(true);
            state.setLoading(true);
            CallbackHandler callbacks = new CallbackHandler();
            RecordingCallback callback = new RecordingCallback();
            callbacks.setCallback(callback);
            CodexMessageHandler handler = control ? new CodexMessageHandler(state, callbacks, false)
                    : new CodexMessageHandler(state, callbacks);
            String error = "thread fixture already has an active writer";
            handler.onError(error);
            assertEquals(error, state.getError());
            assertEquals(error, callback.lastMessages.get(0).content);
            assertEquals(1, callback.streamEndCount);
            assertEquals(1, callback.stateChangeCount);
            assertEquals(control ? null : error, callback.lastStateError);
            assertFalse(callback.lastBusy);
            assertFalse(callback.lastLoading);
        }
    }
}
