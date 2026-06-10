package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.permission.PermissionRequest;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

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
        final List<Boolean> thinkingStatusChanges = new ArrayList<>();
        final List<Message> lastMessages = new ArrayList<>();

        @Override
        public void onMessageUpdate(List<Message> messages) {
            messageUpdateCount++;
            lastMessages.clear();
            lastMessages.addAll(messages);
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
            stateChangeCount++;
            lastBusy = busy;
            lastLoading = loading;
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
        }

        @Override
        public void onPermissionRequested(PermissionRequest request) {
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
            thinkingStatusChanges.add(isThinking);
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
        assertTrue(callback.messageUpdateCount >= 1);
        assertEquals("done", callback.lastMessages.get(callback.lastMessages.size() - 1).content);
    }

    @Test
    public void interruptedCompletionAddsAssistantNoticeInsteadOfError() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");

        SDKResult result = SDKResult.error("__I18N__:chat.requestInterrupted");
        result.interrupted = true;
        handler.onComplete(result);

        assertEquals(1, callback.streamStartCount);
        assertEquals(1, callback.streamEndCount);
        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertEquals(ClaudeSession.SessionCallback.QueueDisplayState.COMPLETED, state.getQueueDisplayState());
        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals(Message.Type.ASSISTANT, message.type);
        assertEquals("__I18N__:chat.requestInterrupted", message.content);
        assertEquals(1, callback.messageUpdateCount);
    }

    @Test
    public void onErrorAddsProviderErrorBlockToAssistantMessage() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial answer");

        handler.onError("Codex CLI 请求失败，原因：服务暂时不可用 (503)");

        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertEquals(1, callback.streamEndCount);
        assertEquals(1, state.getMessages().size());

        Message message = state.getMessages().get(0);
        assertEquals(Message.Type.ASSISTANT, message.type);
        assertTrue(message.content.contains("partial answer"));
        assertTrue(message.content.contains("Codex CLI 请求失败"));
        assertNotNull(message.raw);

        com.google.gson.JsonArray blocks = message.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("text", blocks.get(0).getAsJsonObject().get("type").getAsString());
        com.google.gson.JsonObject errorBlock = blocks.get(blocks.size() - 1).getAsJsonObject();
        assertEquals("provider_error", errorBlock.get("type").getAsString());
        assertEquals("codex", errorBlock.get("provider").getAsString());
        assertEquals("Codex CLI 请求失败，原因：服务暂时不可用 (503)",
                errorBlock.get("details").getAsString());
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
    public void thinkingStartSignalActivatesThinkingStatus() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking", "");
        handler.onMessage("thinking_delta", "analyzing...");

        assertTrue("Should have thinking status change to true",
                callback.thinkingStatusChanges.contains(true));
        assertEquals(List.of("analyzing..."), callback.thinkingDeltas);
    }

    @Test
    public void thinkingStatusResetsOnContentDelta() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking", "");
        handler.onMessage("thinking_delta", "thinking...");
        handler.onMessage("content_delta", "result");

        assertTrue("Should have thinking=true", callback.thinkingStatusChanges.contains(true));
        assertTrue("Should have thinking=false after content delta",
                callback.thinkingStatusChanges.contains(false));
    }

    @Test
    public void thinkingStatusResetsOnStreamEnd() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking", "");
        handler.onMessage("thinking_delta", "pondering");
        handler.onMessage("stream_end", "");

        assertTrue("Should have thinking=true", callback.thinkingStatusChanges.contains(true));
        assertTrue("Should have thinking=false after stream end",
                callback.thinkingStatusChanges.contains(false));
    }

    @Test
    public void streamingAssistantMessageWithoutToolUseDoesNotPushMessageUpdate() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        int updatesBefore = callback.messageUpdateCount;

        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "hello");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}");

        // content_delta during streaming does NOT push messageUpdate
        // assistant with text-only also does NOT push messageUpdate during streaming
        assertEquals("Text-only assistant during streaming should not push messageUpdate",
                updatesBefore, callback.messageUpdateCount);
    }

    @Test
    public void streamingAssistantMessageWithToolUsePushesMessageUpdate() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");

        int updatesBefore = callback.messageUpdateCount;
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{}}]}}");

        assertTrue("Tool-use assistant during streaming should push messageUpdate",
                callback.messageUpdateCount > updatesBefore);
    }

    @Test
    public void streamingContentDeltaIsPreservedInRawBeforeCliToolUseSnapshot() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "明白了，预警判断应该跟设备挂钩，不是跟植物关联。");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"mcp__iot__history\",\"input\":{}}]}}");

        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals("明白了，预警判断应该跟设备挂钩，不是跟植物关联。", message.content);
        assertNotNull(message.raw);

        com.google.gson.JsonArray blocks = message.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(2, blocks.size());
        assertEquals("text", blocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("明白了，预警判断应该跟设备挂钩，不是跟植物关联。",
                blocks.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("tool_use", blocks.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("tool-1", blocks.get(1).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void directToolUseEventIsMergedIntoCurrentAssistantMessage() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "准备编辑文件：");
        int updatesBefore = callback.messageUpdateCount;

        handler.onMessage("tool_use", "{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"Edit\",\"input\":{\"file_path\":\"Plant.java\"}}");

        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals("准备编辑文件：", message.content);

        com.google.gson.JsonArray blocks = message.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals(2, blocks.size());
        assertEquals("text", blocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("tool_use", blocks.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("tool-1", blocks.get(1).getAsJsonObject().get("id").getAsString());
        assertTrue(callback.messageUpdateCount > updatesBefore);
    }

    @Test
    public void directToolResultEventAddsSyntheticUserToolResultMessage() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("tool_result", "{\"type\":\"tool_result\",\"tool_use_id\":\"tool-1\",\"content\":\"done\",\"is_error\":false}");

        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals(Message.Type.USER, message.type);
        assertEquals("[tool_result]", message.content);

        com.google.gson.JsonArray blocks = message.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals(1, blocks.size());
        assertEquals("tool_result", blocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("tool-1", blocks.get(0).getAsJsonObject().get("tool_use_id").getAsString());
        assertEquals(1, callback.messageUpdateCount);
    }

    @Test
    public void blockResetSplitsCodexCliSegmentsLikeClaudeCli() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("thinking", "");
        handler.onMessage("thinking_delta", "先分析");
        handler.onMessage("content_delta", "准备读取。");
        handler.onMessage("block_reset", "");
        handler.onMessage("tool_use", "{\"type\":\"tool_use\",\"id\":\"read-1\",\"name\":\"Read\",\"input\":{\"file_path\":\"WeatherCard.vue\"}}");
        handler.onMessage("block_reset", "");
        handler.onMessage("thinking", "");
        handler.onMessage("thinking_delta", "再分析");
        handler.onMessage("content_delta", "准备测试。");
        handler.onMessage("block_reset", "");
        handler.onMessage("tool_use", "{\"type\":\"tool_use\",\"id\":\"bash-1\",\"name\":\"Bash\",\"input\":{\"command\":\"vitest run\"}}");

        assertEquals(4, state.getMessages().size());
        assertEquals("准备读取。", state.getMessages().get(0).content);
        assertEquals("", state.getMessages().get(1).content);
        assertEquals("准备测试。", state.getMessages().get(2).content);
        assertEquals("", state.getMessages().get(3).content);

        com.google.gson.JsonArray firstBlocks = state.getMessages().get(0).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("thinking", firstBlocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("先分析", firstBlocks.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("text", firstBlocks.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("准备读取。", firstBlocks.get(1).getAsJsonObject().get("text").getAsString());

        com.google.gson.JsonArray firstToolBlocks = state.getMessages().get(1).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals(1, firstToolBlocks.size());
        assertEquals("tool_use", firstToolBlocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("read-1", firstToolBlocks.get(0).getAsJsonObject().get("id").getAsString());

        com.google.gson.JsonArray secondBlocks = state.getMessages().get(2).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals("thinking", secondBlocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("再分析", secondBlocks.get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("text", secondBlocks.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("准备测试。", secondBlocks.get(1).getAsJsonObject().get("text").getAsString());

        com.google.gson.JsonArray secondToolBlocks = state.getMessages().get(3).raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");
        assertEquals(1, secondToolBlocks.size());
        assertEquals("tool_use", secondToolBlocks.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("bash-1", secondToolBlocks.get(0).getAsJsonObject().get("id").getAsString());
    }

    @Test
    public void streamingDeduplicationPreventsDuplicateContent() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "hello");
        // Assistant message with longer text triggers conservative sync
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello world\"}]}}");

        // Snapshot text is not visible until it arrives through the delta channel.
        // If the CLI replays a cumulative delta, only the already-visible prefix is consumed.
        handler.onMessage("content_delta", "hello world");
        assertEquals(List.of("hello", " world"), callback.contentDeltas);
        assertEquals("hello world", state.getMessages().get(0).content);
    }

    @Test
    public void streamingTextSnapshotDoesNotAdvanceVisibleContentBeyondDeltas() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "hello");
        handler.onMessage("assistant", "{\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hello world\"}]}}");

        assertEquals("Only streamed delta should be visible before the matching delta arrives",
                "hello", state.getMessages().get(0).content);
        assertEquals(List.of("hello"), callback.contentDeltas);

        handler.onMessage("content_delta", " world");

        assertEquals("hello world", state.getMessages().get(0).content);
        assertEquals(List.of("hello", " world"), callback.contentDeltas);
    }

    @Test
    public void userMessageWithImagePreservesImageBlockInRawContent() {
        SessionState state = new SessionState();
        CallbackHandler callbackHandler = new CallbackHandler();
        RecordingCallback callback = new RecordingCallback();
        callbackHandler.setCallback(callback);

        CodexMessageHandler handler = new CodexMessageHandler(state, callbackHandler);
        handler.onMessage("user", "{\"message\":{\"content\":[{\"type\":\"image\",\"src\":\"cc-gui-attachment://thumb\",\"previewSrc\":\"cc-gui-attachment://full\",\"thumbnailSrc\":\"cc-gui-attachment://thumb\",\"sourceKind\":\"resource_url\"},{\"type\":\"text\",\"text\":\"请看这张图\"}]}}");

        Message lastMessage = callback.lastMessages.get(callback.lastMessages.size() - 1);
        assertEquals(Message.Type.USER, lastMessage.type);
        assertEquals("请看这张图", lastMessage.content);
        assertNotNull(lastMessage.raw);

        com.google.gson.JsonArray content = lastMessage.raw
                .getAsJsonObject("message")
                .getAsJsonArray("content");

        assertEquals(2, content.size());
        assertEquals("image", content.get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("text", content.get(1).getAsJsonObject().get("type").getAsString());
        assertEquals("请看这张图", content.get(1).getAsJsonObject().get("text").getAsString());
    }
}
