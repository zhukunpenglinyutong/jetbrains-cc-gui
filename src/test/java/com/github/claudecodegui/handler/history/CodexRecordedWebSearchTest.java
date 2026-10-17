package com.github.claudecodegui.handler.history;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.*;

/** Verifies native web receipts use the same result and status contract as live projection. */
public class CodexRecordedWebSearchTest {
    /** Optional statuses never leave a completed native web action pending. */
    @Test
    public void completedAliasesKeepTheirIdentityAndResultBody() {
        for (String type : List.of("webSearch", "WebSearch", "web_search", "Extension")) {
            JsonObject record = receipt(type);
            JsonObject item = record.getAsJsonObject("payload").getAsJsonObject("item");
            item.addProperty("output", "page body with failed quoted as text");
            var messages = CodexRecordedWebSearch.readMessages(record);
            assertEquals(2, messages.size());
            assertEquals("native-web", block(messages.get(0)).get("id").getAsString());
            assertEquals("native-web", block(messages.get(1)).get("tool_use_id").getAsString());
            assertEquals("page body with failed quoted as text", block(messages.get(1)).get("content").getAsString());
            assertFalse(block(messages.get(1)).get("is_error").getAsBoolean());
        }
    }

    /** Error details and explicit terminal statuses survive history loading. */
    @Test
    public void failedReceiptsKeepTheNativeExplanation() {
        for (String status : List.of("failed", "declined", "interrupted")) {
            JsonObject record = receipt("Extension");
            JsonObject item = record.getAsJsonObject("payload").getAsJsonObject("item");
            item.addProperty("status", status);
            item.add("error", JsonParser.parseString("{\"message\":\"native web error\"}"));
            var result = block(CodexRecordedWebSearch.readMessages(record).get(1));
            assertEquals("native web error", result.get("content").getAsString());
            assertTrue(result.get("is_error").getAsBoolean());
        }
        JsonObject pending = receipt("webSearch");
        pending.getAsJsonObject("payload").getAsJsonObject("item").addProperty("status", "inProgress");
        assertEquals(1, CodexRecordedWebSearch.readMessages(pending).size());
    }

    /** Only complete native web receipts, including empty results, belong to this adapter. */
    @Test
    public void ignoresUnrelatedOrMalformedReceipts() {
        assertTrue(CodexRecordedWebSearch.readMessages(null).isEmpty());
        assertTrue(CodexRecordedWebSearch.readMessages(new JsonObject()).isEmpty());
        JsonObject record = receipt("Extension");
        JsonObject item = record.getAsJsonObject("payload").getAsJsonObject("item");
        item.addProperty("kind", "unrelated.extension");
        assertTrue(CodexRecordedWebSearch.readMessages(record).isEmpty());
        item.addProperty("kind", "web.search");
        item.remove("results");
        assertEquals("", block(CodexRecordedWebSearch.readMessages(record).get(1)).get("content").getAsString());
        item.remove("id");
        assertTrue(CodexRecordedWebSearch.readMessages(record).isEmpty());
        record = receipt("webSearch");
        record.getAsJsonObject("payload").addProperty("type", "item_started");
        assertTrue(CodexRecordedWebSearch.readMessages(record).isEmpty());
    }

    private static JsonObject receipt(String type) {
        JsonObject record = JsonParser.parseString("""
                {"type":"event_msg","payload":{"type":"item_completed","thread_id":"root","turn_id":"turn",
                "item":{"type":"Extension","kind":"web.search","id":"native-web","query":"fixture",
                "action":{"type":"openPage","url":"https://example.com"},"results":[]}}}
                """).getAsJsonObject();
        record.getAsJsonObject("payload").getAsJsonObject("item").addProperty("type", type);
        return record;
    }

    private static JsonObject block(JsonObject message) {
        return message.getAsJsonObject("raw").getAsJsonArray("content").get(0).getAsJsonObject();
    }
}
