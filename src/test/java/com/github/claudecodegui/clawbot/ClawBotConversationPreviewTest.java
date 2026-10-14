package com.github.claudecodegui.clawbot;

import com.github.claudecodegui.session.ClaudeSession.Message;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.CallbackHandler;
import com.github.claudecodegui.session.CodexMessageHandler;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClawBotConversationPreviewTest {

    @Test
    public void latePreviousCompletionDoesNotReportActiveTurnAsIdle() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.getState().beginTurn();
        CodexMessageHandler previous = new CodexMessageHandler(session.getState(), new CallbackHandler());
        previous.onMessage("stream_start", "");
        previous.onMessage("stream_end", "");

        session.getState().beginTurn();
        session.getState().addMessage(new Message(Message.Type.USER, "current question"));
        CodexMessageHandler current = new CodexMessageHandler(session.getState(), new CallbackHandler());
        current.onMessage("stream_start", "");
        current.onMessage("content_delta", "working on it");
        previous.onComplete(new SDKResult());

        String preview = ClawBotConversationPreview.capture(session);
        assertTrue(preview.contains("处理中"));
        assertTrue(preview.contains("当前回复片段"));
        assertFalse(preview.contains("当前空闲"));

        current.onMessage("stream_end", "");
        assertTrue(ClawBotConversationPreview.capture(session).contains("当前空闲"));
    }

    @Test
    public void pendingQuestionIsNeverPairedWithPreviousAnswer() {
        String result = ClawBotConversationPreview.format(List.of(
                new Message(Message.Type.USER, "old question"),
                new Message(Message.Type.ASSISTANT, "old answer"),
                new Message(Message.Type.USER, "current question")), true);
        assertTrue(result.contains("current question"));
        assertTrue(result.contains("处理中"));
        assertTrue(result.contains("暂无可预览的回复"));
        assertFalse(result.contains("old answer"));
    }

    @Test
    public void includesLatestPublicAnswerAndSkipsToolResult() {
        Message tool = new Message(Message.Type.USER, "[tool_result]",
                JsonParser.parseString("{\"content\":[{\"type\":\"tool_result\",\"content\":\"secret\"}]}").getAsJsonObject());
        String result = ClawBotConversationPreview.format(List.of(
                new Message(Message.Type.USER, "question"), tool,
                new Message(Message.Type.ASSISTANT, "answer")), false);
        assertTrue(result.contains("question"));
        assertTrue(result.contains("answer"));
        assertTrue(result.contains("当前空闲"));
        assertFalse(result.contains("secret"));
        assertFalse(result.contains("tool_result"));
    }

    @Test
    public void neverIncludesThinkingBlocksOrSystemMessages() {
        Message assistant = new Message(Message.Type.ASSISTANT, "private reasoning",
                JsonParser.parseString("{\"message\":{\"content\":[{\"type\":\"thinking\",\"thinking\":\"private reasoning\"},"
                        + "{\"type\":\"text\",\"text\":\"public answer\"}]}}").getAsJsonObject());
        String result = ClawBotConversationPreview.format(List.of(
                new Message(Message.Type.SYSTEM, "private system instructions"),
                new Message(Message.Type.USER, "question"), assistant), false);
        assertTrue(result.contains("public answer"));
        assertFalse(result.contains("private"));
    }

    @Test
    public void emptyMemoryDoesNotPretendToLoadHistory() {
        assertTrue(ClawBotConversationPreview.format(List.of(), false).contains("未读取磁盘历史"));
        assertTrue(ClawBotConversationPreview.format(List.of(new Message(Message.Type.ASSISTANT, "orphan answer")), false)
                .contains("没有可预览"));
    }

    @Test
    public void boundsQuestionAndAnswerWithoutSplittingUnicodeOrLeakingControls() {
        String result = ClawBotConversationPreview.format(List.of(
                new Message(Message.Type.USER, "q".repeat(799) + "😀tail"),
                new Message(Message.Type.ASSISTANT, "answer\u0000" + "a".repeat(5000))), false);
        assertTrue(result.length() < 1800);
        assertFalse(result.contains("\u0000"));
        assertFalse(result.contains("\uD83D"));
        assertTrue(result.contains("…"));
    }
}
