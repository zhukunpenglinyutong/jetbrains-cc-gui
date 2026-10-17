package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Exercises persisted generated images through the conversation's history conversion. */
public class CodexRecordedImageGenerationTest {
    /** Keeps both native and extension PNG receipts visible without duplicating image data in input. */
    @Test
    public void restoresNativeAndExtensionImageResults() {
        for (String type : List.of("ImageGeneration", "imageGeneration", "Extension")) {
            JsonObject item = JsonParser.parseString("""
                    {"type":"ImageGeneration","id":"image","status":"completed","revisedPrompt":"A blue square",
                     "transparentBackground":false,"result":"cG5n","savedPath":"/tmp/image.png","failure":null}
                    """).getAsJsonObject();
            item.addProperty("type", type);
            if ("Extension".equals(type)) {
                item.addProperty("kind", "image_gen.generation");
            } else if ("ImageGeneration".equals(type)) {
                item.add("revised_prompt", item.remove("revisedPrompt"));
                item.add("saved_path", item.remove("savedPath"));
            }
            List<JsonObject> messages = readMessages(item);
            assertEquals(2, messages.size());
            JsonObject tool = block(messages.get(0));
            assertEquals("imageGeneration", tool.get("name").getAsString());
            assertEquals(JsonParser.parseString("""
                    {"revisedPrompt":"A blue square","transparentBackground":false,"path":"/tmp/image.png"}
                    """), tool.get("input"));
            JsonObject result = block(messages.get(1));
            assertEquals("image", result.get("tool_use_id").getAsString());
            assertFalse(result.get("is_error").getAsBoolean());
            assertEquals(JsonParser.parseString("""
                    [{"type":"image","source":{"type":"base64","media_type":"image/png","data":"cG5n"}},
                     {"type":"text","text":"/tmp/image.png"}]
                    """), result.get("content"));
            assertEquals("thread", messages.get(0).getAsJsonObject("raw").get("codexThreadId").getAsString());
            assertEquals("turn", messages.get(1).getAsJsonObject("raw").get("codexTurnId").getAsString());
            assertEquals("1970-01-01T00:00:01Z", messages.get(0).get("timestamp").getAsString());
        }
    }

    /** Uses native failure details and preserves an unfinished image's pending state. */
    @Test
    public void restoresFailuresWithoutCompletingRunningImages() {
        JsonObject item = JsonParser.parseString("""
                {"type":"Extension","kind":"image_gen.generation","id":"image","status":"failed","result":"",
                 "failure":{"type":"usageLimitExceeded","limitId":"image-generation","resetsAt":1000}}
                """).getAsJsonObject();
        for (String status : List.of("failed", "interrupted", "declined")) {
            item.addProperty("status", status);
            List<JsonObject> messages = readMessages(item);
            assertEquals(2, messages.size());
            JsonObject result = block(messages.get(1));
            assertTrue(result.get("is_error").getAsBoolean());
            assertEquals(item.get("failure").toString(), result.getAsJsonArray("content").get(0)
                    .getAsJsonObject().get("text").getAsString());
        }
        item.addProperty("status", "in_progress");
        assertEquals(1, readMessages(item).size());
    }

    /** Uses the native abort's turn identity without closing another thread or completed image. */
    @Test
    public void closesOnlyTheMatchingStartedImageWhenTheTurnWasAborted() {
        JsonArray records = JsonParser.parseString("""
                [{"type":"session_meta","payload":{"id":"root"}},
                 {"type":"event_msg","payload":{"type":"task_started","turn_id":"stopped-turn"}},
                 {"type":"event_msg","payload":{"type":"item_started","thread_id":"root","turn_id":"stopped-turn",
                  "item":{"type":"Extension","kind":"image_gen.generation","id":"image","status":"in_progress","result":""}}},
                 {"type":"event_msg","payload":{"type":"item_started","thread_id":"root","turn_id":"other-turn",
                  "item":{"type":"Extension","kind":"image_gen.generation","id":"other-image","status":"in_progress","result":""}}},
                 {"type":"event_msg","payload":{"type":"item_started","thread_id":"child","turn_id":"stopped-turn",
                  "item":{"type":"Extension","kind":"image_gen.generation","id":"image","status":"in_progress","result":""}}},
                 {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"stopped-turn",
                  "item":{"type":"Extension","kind":"image_gen.generation","id":"done","status":"completed","result":"cG5n"}}},
                 {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"stopped-turn","reason":"interrupted","completed_at":3}}]
                """).getAsJsonArray();
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(6, messages.size());
        JsonObject stopped = messages.stream().filter(message -> "image".equals(block(message).has("tool_use_id")
                ? block(message).get("tool_use_id").getAsString() : null)).findFirst().orElseThrow();
        assertTrue(block(stopped).get("is_error").getAsBoolean());
        assertEquals("root", stopped.getAsJsonObject("raw").get("codexThreadId").getAsString());
        assertEquals("stopped-turn", stopped.getAsJsonObject("raw").get("codexTurnId").getAsString());
        assertEquals("1970-01-01T00:00:03Z", stopped.get("timestamp").getAsString());
        assertEquals(2, messages.stream().filter(message -> "tool_result".equals(block(message).get("type").getAsString())).count());
        assertTrue(messages.stream().filter(message -> "done".equals(block(message).has("tool_use_id")
                ? block(message).get("tool_use_id").getAsString() : null))
                .noneMatch(message -> block(message).get("is_error").getAsBoolean()));
    }

    /** Replaces a pending image with its real completion before a later abort. */
    @Test
    public void preservesCompletedImagesAfterStartedSnapshotsAndLaterAbort() {
        JsonArray records = JsonParser.parseString("""
                [{"type":"session_meta","payload":{"id":"root"}},
                 {"type":"event_msg","payload":{"type":"item_started","thread_id":"root","turn_id":"turn",
                  "item":{"type":"ImageGeneration","id":"image","status":"in_progress","result":""}}},
                 {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                  "item":{"type":"ImageGeneration","id":"image","status":"completed","revised_prompt":"A square",
                   "saved_path":"/tmp/image.png","result":"cG5n"}}},
                 {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn","reason":"interrupted"}}]
                """).getAsJsonArray();
        List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
        assertEquals(3, messages.size());
        assertEquals(messages.get(0).getAsJsonObject("raw").get("uuid"), messages.get(1).getAsJsonObject("raw").get("uuid"));
        assertEquals("/tmp/image.png", block(messages.get(1)).getAsJsonObject("input").get("path").getAsString());
        assertFalse(block(messages.get(2)).get("is_error").getAsBoolean());
        assertEquals("image", block(messages.get(2)).getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
    }

    /** Falls back to the native current turn only when a task-started event identifies it. */
    @Test
    public void usesTheNativeCurrentTurnForAnAbortWithoutATurnId() {
        for (boolean started : List.of(true, false)) {
            JsonArray records = JsonParser.parseString("""
                    [{"type":"session_meta","payload":{"id":"root"}},
                     {"type":"event_msg","payload":{"type":"item_started","thread_id":"root","turn_id":"turn",
                      "item":{"type":"Extension","kind":"image_gen.generation","id":"image","status":"in_progress","result":""}}},
                     {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":null,"reason":"interrupted"}}]
                    """).getAsJsonArray();
            if (started) {
                JsonArray withStart = new JsonArray();
                withStart.add(records.get(0));
                withStart.add(JsonParser.parseString("""
                        {"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}
                        """));
                withStart.add(records.get(1));
                withStart.add(records.get(2));
                records = withStart;
            }
            List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
            assertEquals(started ? 2 : 1, messages.size());
            assertEquals("tool_use", block(messages.get(0)).get("type").getAsString());
            if (started) {
                assertTrue(block(messages.get(1)).get("is_error").getAsBoolean());
            }
        }
    }

    /** Does not borrow a completed task as the current turn of a later idle abort. */
    @Test
    public void forgetsTheCurrentTurnAfterNativeTaskCompletion() {
        for (String type : List.of("task_complete", "turn_complete")) {
            JsonArray records = JsonParser.parseString("""
                    [{"type":"session_meta","payload":{"id":"root"}},
                     {"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}},
                     {"type":"event_msg","payload":{"type":"item_started","thread_id":"root","turn_id":"turn",
                      "item":{"type":"Extension","kind":"image_gen.generation","id":"image","status":"in_progress","result":""}}}]
                    """).getAsJsonArray();
            JsonObject complete = JsonParser.parseString("""
                    {"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn","last_agent_message":null}}
                    """).getAsJsonObject();
            complete.getAsJsonObject("payload").addProperty("type", type);
            records.add(complete);
            records.add(JsonParser.parseString("""
                    {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":null,"reason":"interrupted"}}
                    """));
            List<JsonObject> messages = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
            assertEquals(1, messages.size());
            assertEquals("tool_use", block(messages.get(0)).get("type").getAsString());
            records.add(JsonParser.parseString("""
                    {"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn","reason":"interrupted"}}
                    """));
            List<JsonObject> explicit = HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
            assertEquals(2, explicit.size());
            assertTrue(block(explicit.get(1)).get("is_error").getAsBoolean());
        }
    }

    private static List<JsonObject> readMessages(JsonObject item) {
        JsonObject record = JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                 "completed_at_ms":1000}}
                """).getAsJsonObject();
        record.getAsJsonObject("payload").add("item", item);
        JsonArray records = new JsonArray();
        records.add(record);
        return HistoryMessageInjector.convertCodexMessagesToFrontendBatch(records);
    }

    private static JsonObject block(JsonObject message) {
        return message.getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
    }
}
