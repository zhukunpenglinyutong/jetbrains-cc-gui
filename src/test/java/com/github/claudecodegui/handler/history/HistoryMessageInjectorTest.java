package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class HistoryMessageInjectorTest {

    @Test
    public void attachesTaskCompleteDurationToLatestAssistantInTurn() {
        JsonArray messages = new JsonArray();
        messages.add(taskStarted("turn-1"));
        messages.add(functionCallResponse("call-1", "echo hi"));
        messages.add(assistantMessageResponse("done"));
        messages.add(taskComplete("turn-1", 16_000L));

        List<JsonObject> frontend = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(2, frontend.size());
        assertEquals("assistant", frontend.get(0).get("type").getAsString());
        assertFalse(frontend.get(0).has("durationMs"));

        assertEquals("assistant", frontend.get(1).get("type").getAsString());
        assertTrue(frontend.get(1).has("durationMs"));
        assertEquals(16_000L, frontend.get(1).get("durationMs").getAsLong());
    }

    @Test
    public void fallsBackToLatestAssistantWhenTurnMarkersMissing() {
        JsonArray messages = new JsonArray();
        messages.add(assistantMessageResponse("hello"));
        messages.add(taskComplete(null, 9_500L));

        List<JsonObject> frontend = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(messages);

        assertEquals(1, frontend.size());
        assertTrue(frontend.get(0).has("durationMs"));
        assertEquals(9_500L, frontend.get(0).get("durationMs").getAsLong());
    }

    private static JsonObject taskStarted(String turnId) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "task_started");
        payload.addProperty("turn_id", turnId);

        JsonObject msg = new JsonObject();
        msg.addProperty("type", "event_msg");
        msg.add("payload", payload);
        return msg;
    }

    private static JsonObject taskComplete(String turnId, Long durationMs) {
        JsonObject payload = new JsonObject();
        payload.addProperty("type", "task_complete");
        if (turnId != null) {
            payload.addProperty("turn_id", turnId);
        }
        if (durationMs != null) {
            payload.addProperty("duration_ms", durationMs);
        }

        JsonObject msg = new JsonObject();
        msg.addProperty("type", "event_msg");
        msg.add("payload", payload);
        return msg;
    }

    private static JsonObject assistantMessageResponse(String text) {
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "output_text");
        textBlock.addProperty("text", text);

        JsonArray content = new JsonArray();
        content.add(textBlock);

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "message");
        payload.addProperty("role", "assistant");
        payload.add("content", content);

        JsonObject msg = new JsonObject();
        msg.addProperty("type", "response_item");
        msg.addProperty("timestamp", "2026-05-01T00:00:00Z");
        msg.add("payload", payload);
        return msg;
    }

    private static JsonObject functionCallResponse(String callId, String command) {
        JsonObject args = new JsonObject();
        args.addProperty("command", command);

        JsonObject payload = new JsonObject();
        payload.addProperty("type", "function_call");
        payload.addProperty("name", "shell_command");
        payload.addProperty("call_id", callId);
        payload.addProperty("arguments", args.toString());

        JsonObject msg = new JsonObject();
        msg.addProperty("type", "response_item");
        msg.addProperty("timestamp", "2026-05-01T00:00:01Z");
        msg.add("payload", payload);
        return msg;
    }
}

