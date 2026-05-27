package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cli.common.CliErrorFormatter;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeCliStreamParserTest {

    private static final String UNSUPPORTED_IMAGE_MESSAGE_KEY = "__I18N__:aiBridge.unsupportedImageVision";

    @Test
    public void assistantToolUseEmitsToolUseEvent() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        String line = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"README.md\"}}]}}";

        parser.parseLine(line, callback, new SDKResult(), new StringBuilder(), new AtomicBoolean(false), false);

        assertEquals("tool_use", callback.events.get(0).type);
    }

    @Test
    public void thinkingDeltaStillEmitsWhenSuppressFlagIsTrue() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();

        parser.parseLine(
                "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"thinking\"}}}",
                callback,
                new SDKResult(),
                new StringBuilder(),
                new AtomicBoolean(false),
                true
        );
        parser.parseLine(
                "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"plan\"}}}",
                callback,
                new SDKResult(),
                new StringBuilder(),
                new AtomicBoolean(false),
                true
        );

        assertTrue(callback.events.stream().anyMatch(event -> "thinking".equals(event.type)));
        assertTrue(callback.events.stream().anyMatch(event -> "thinking_delta".equals(event.type) && "plan".equals(event.content)));
    }

    private static String textDelta(String text) {
        return "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":" + new Gson().toJson(text) + "}}}";
    }

    @Test
    public void toolTraceTextAroundServerToolUseEmitsThinkingDeltaNotContentDelta() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();

        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine(textDelta("**Built-in Tool: inspect_asset**\nInput:\n```json\n{}\n```\n*Executing on server...*"), callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\"}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"server_tool_use\",\"name\":\"inspect_asset\"}}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine(textDelta("**Output:** inspected data"), callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\"}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine(textDelta("Final answer based on the tool result."), callback, result, assistantContent, new AtomicBoolean(false), false);

        assertEquals(List.of("**Built-in Tool: inspect_asset**\nInput:\n```json\n{}\n```\n*Executing on server...*", "**Output:** inspected data"), callback.contentsOfType("thinking_delta"));
        assertEquals(List.of("Final answer based on the tool result."), callback.contentsOfType("content_delta"));
        assertEquals("Final answer based on the tool result.", assistantContent.toString());
        assertFalse(callback.contentsOfType("content_delta").stream().anyMatch(text -> text.contains("Built-in Tool")));
    }

    @Test
    public void outputLabelWithoutToolContextRemainsContentDelta() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}", callback, new SDKResult(), assistantContent, new AtomicBoolean(false), false);
        parser.parseLine(textDelta("Output: final answer"), callback, new SDKResult(), assistantContent, new AtomicBoolean(false), false);

        assertEquals(List.of("Output: final answer"), callback.contentsOfType("content_delta"));
        assertTrue(callback.contentsOfType("thinking_delta").isEmpty());
        assertEquals("Output: final answer", assistantContent.toString());
    }

    @Test
    public void markdownBoldTextStreamsAsContentWithoutWaitingForBlockStop() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        StringBuilder assistantContent = new StringBuilder();

        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}", callback, new SDKResult(), assistantContent, new AtomicBoolean(false), false);
        parser.parseLine(textDelta("**Summary:** normal answer"), callback, new SDKResult(), assistantContent, new AtomicBoolean(false), false);

        assertEquals(List.of("**Summary:** normal answer"), callback.contentsOfType("content_delta"));
        assertTrue(callback.contentsOfType("thinking_delta").isEmpty());
        assertEquals("**Summary:** normal answer", assistantContent.toString());
    }

    @Test
    public void outputLabelAfterToolTraceBlockCanStillBeFinalContent() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();

        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine(textDelta("Built-in Tool: inspect_asset\nExecuting on server"), callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\"}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"server_tool_use\",\"name\":\"inspect_asset\"}}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine(textDelta("Output: internal result"), callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_stop\"}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine("{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}", callback, result, assistantContent, new AtomicBoolean(false), false);
        parser.parseLine(textDelta("Output: final user-facing answer"), callback, result, assistantContent, new AtomicBoolean(false), false);

        assertEquals(List.of("Built-in Tool: inspect_asset\nExecuting on server", "Output: internal result"), callback.contentsOfType("thinking_delta"));
        assertEquals(List.of("Output: final user-facing answer"), callback.contentsOfType("content_delta"));
        assertEquals("Output: final user-facing answer", assistantContent.toString());
    }

    @Test
    public void errorResultDoesNotEmitAssistantContentAndMarksFailure() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();

        String line = "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true," + "\"api_error_status\":429," + "\"result\":\"API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。]\"}";

        parser.parseLine(line, callback, result, assistantContent, new AtomicBoolean(false), false);

        assertTrue(callback.contentsOfType("content").isEmpty());
        assertEquals("", assistantContent.toString());
        assertFalse(result.success);
        assertEquals(CliErrorFormatter.formatError("Claude", "API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。]"), result.error);
    }

    @Test
    public void imageToolResultFollowedByApiErrorReportsUnsupportedVision() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();
        AtomicBoolean hadSendError = new AtomicBoolean(false);

        parser.parseLine(
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"C:/tmp/image.png\"}}]}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"user\",\"message\":{\"content\":[{\"tool_use_id\":\"call_1\",\"type\":\"tool_result\",\"content\":[{\"type\":\"image\",\"source\":{\"type\":\"base64\",\"data\":\"abc\"},\"type\":\"image/png\"}]}]}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"api_error_status\":404,\"result\":\"There's an issue with the selected model (mimo-v2.5-pro). It may not exist or you may not have access to it.\"}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );

        assertFalse(result.success);
        assertTrue(result.error.contains(UNSUPPORTED_IMAGE_MESSAGE_KEY));
        assertTrue(result.error.contains("mimo-v2.5-pro"));
    }

    @Test
    public void imageToolResultWithoutAnyAssistantOutputReportsUnsupportedVision() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();
        AtomicBoolean hadSendError = new AtomicBoolean(false);

        parser.parseLine(
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"C:/tmp/image.png\"}}]}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"user\",\"message\":{\"content\":[{\"tool_use_id\":\"call_1\",\"type\":\"tool_result\",\"content\":[{\"type\":\"image/png\",\"source\":{\"type\":\"base64\",\"data\":\"abc\"}}]}]}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"\"}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );

        assertFalse(result.success);
        assertTrue(result.error.contains(UNSUPPORTED_IMAGE_MESSAGE_KEY));
        assertTrue(result.error.contains("finished without any readable image-analysis output"));
        assertEquals("", assistantContent.toString());
    }

    @Test
    public void imageToolResultWithAssistantOutputDoesNotReportUnsupportedVision() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();
        AtomicBoolean hadSendError = new AtomicBoolean(false);

        parser.parseLine(
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"C:/tmp/image.png\"}}]}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"user\",\"message\":{\"content\":[{\"tool_use_id\":\"call_1\",\"type\":\"tool_result\",\"content\":[{\"type\":\"image/png\",\"source\":{\"type\":\"base64\",\"data\":\"abc\"}}]}]}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                textDelta("我看到了图片中的地图和路线说明。"),
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"\"}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );

        assertTrue(result.success);
        assertEquals("我看到了图片中的地图和路线说明。", result.finalResult);
    }

    @Test
    public void imageToolResultFollowedOnlyByMetaPlanningTextStillReportsUnsupportedVision() {
        ClaudeCliStreamParser parser = new ClaudeCliStreamParser(new Gson());
        RecordingCallback callback = new RecordingCallback();
        SDKResult result = new SDKResult();
        StringBuilder assistantContent = new StringBuilder();
        AtomicBoolean hadSendError = new AtomicBoolean(false);

        parser.parseLine(
                "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"Read\",\"input\":{\"file_path\":\"C:/tmp/image.png\"}}]}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"user\",\"message\":{\"content\":[{\"tool_use_id\":\"call_1\",\"type\":\"tool_result\",\"content\":[{\"type\":\"image/png\",\"source\":{\"type\":\"base64\",\"data\":\"abc\"}}]}]}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"content_block\":{\"type\":\"text\"}}}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                textDelta("The user wants me to read an image file and answer based on its content. Let me use the Read tool to inspect the image."),
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );
        parser.parseLine(
                "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"\"}",
                callback,
                result,
                assistantContent,
                hadSendError,
                false
        );

        assertFalse(result.success);
        assertTrue(result.error.contains(UNSUPPORTED_IMAGE_MESSAGE_KEY));
    }

    private static class RecordingCallback implements MessageCallback {
        private final List<Event> events = new ArrayList<>();

        @Override
        public void onMessage(String type, String content) {
            events.add(new Event(type, content));
        }

        @Override
        public void onError(String error) {
        }

        @Override
        public void onComplete(SDKResult result) {
        }

        private List<String> contentsOfType(String type) {
            return events.stream().filter(event -> type.equals(event.type)).map(Event::content).toList();
        }
    }

    private record Event(String type, String content) {
    }
}
