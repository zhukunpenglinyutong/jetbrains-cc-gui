package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ClaudeCliStreamParserTest {

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
    }

    private record Event(String type, String content) {
    }
}
