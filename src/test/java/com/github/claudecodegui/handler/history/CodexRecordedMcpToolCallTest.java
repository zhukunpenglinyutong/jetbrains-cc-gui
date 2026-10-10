package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;

/** Exercises persisted MCP receipts through their actual display projection. */
public class CodexRecordedMcpToolCallTest {
    /** Keeps MCP image blocks visible after loading the recorded conversation. */
    @Test
    public void preservesTextImagesAndStructuredResults() {
        JsonObject record = JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"thread","turn_id":"turn",
                  "item":{"type":"McpToolCall","id":"capture","tool":"capture","server":"fixture","status":"completed",
                    "result":{"content":[{"type":"text","text":"Captured fixture"},
                      {"type":"image","mimeType":"image/png","data":"aW1hZ2U="}],"structuredContent":{"width":80}}}}}
                """).getAsJsonObject();
        List<JsonObject> messages = CodexRecordedMcpToolCall.readMessages(record);
        JsonObject result = messages.get(1).getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        JsonArray blocks = result.getAsJsonArray("content");
        assertEquals(3, blocks.size());
        assertEquals("Captured fixture", blocks.get(0).getAsJsonObject().get("text").getAsString());
        assertEquals(JsonParser.parseString("""
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"aW1hZ2U="}}
                """), blocks.get(1));
        assertEquals("{\"width\":80}", blocks.get(2).getAsJsonObject().get("text").getAsString());
        assertEquals(false, result.get("is_error").getAsBoolean());
    }

    /** Keeps non-image MCP blocks and older raw receipts readable without manufacturing images. */
    @Test
    public void preservesOtherBlocksRawResultsAndNativeFailures() {
        JsonObject record = JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","item":{
                  "type":"McpToolCall","id":"resource","tool":"read","status":"completed"}}}
                """).getAsJsonObject();
        JsonObject item = record.getAsJsonObject("payload").getAsJsonObject("item");
        for (String output : List.of("null", "\"legacy receipt\"", "{\"queued\":true}",
                "{\"content\":[{\"type\":\"resource\",\"resource\":{\"uri\":\"fixture://sample\"}},"
                        + "{\"type\":\"image\",\"data\":\"missing mime\"}],\"structuredContent\":null}")) {
            item.add("result", JsonParser.parseString(output));
            JsonObject result = CodexRecordedMcpToolCall.readMessages(record).get(1)
                    .getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
            if (item.get("result").isJsonObject() && item.getAsJsonObject("result").has("content")) {
                assertEquals(item.getAsJsonObject("result").get("content"), result.get("content"));
            } else {
                assertEquals("null".equals(output) ? "" : "\"legacy receipt\"".equals(output)
                        ? "legacy receipt" : output, result.get("content").getAsString());
            }
        }
        item.addProperty("status", "failed");
        item.add("error", JsonParser.parseString("{\"message\":\"fixture failure\"}"));
        JsonObject failed = CodexRecordedMcpToolCall.readMessages(record).get(1)
                .getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals(true, failed.get("is_error").getAsBoolean());
        assertEquals("{\"message\":\"fixture failure\"}", failed.get("content").getAsString());
        item.addProperty("status", "inProgress");
        assertEquals(1, CodexRecordedMcpToolCall.readMessages(record).size());
    }
}
