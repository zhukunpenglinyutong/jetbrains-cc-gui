package com.github.claudecodegui.handler.history;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.List;

/** Restores terminal web receipts without requiring an optional status or a separate user-result row. */
final class CodexRecordedWebSearch {
    private CodexRecordedWebSearch() { }

    static boolean isWebItem(JsonObject item) {
        String type = HistoryMessageInjector.getStringProperty(item, "type");
        return List.of("webSearch", "WebSearch", "web_search").contains(type == null ? "" : type)
                || "Extension".equals(type) && "web.search".equals(HistoryMessageInjector.getStringProperty(item, "kind"));
    }

    static List<JsonObject> readMessages(JsonObject record) {
        JsonObject payload = record != null && record.has("payload") && record.get("payload").isJsonObject()
                ? record.getAsJsonObject("payload") : null;
        JsonObject item = payload != null && payload.has("item") && payload.get("item").isJsonObject()
                ? payload.getAsJsonObject("item") : null;
        String id = HistoryMessageInjector.getStringProperty(item, "id");
        if (!"event_msg".equals(HistoryMessageInjector.getStringProperty(record, "type"))
                || !"item_completed".equals(HistoryMessageInjector.getStringProperty(payload, "type")) || !isWebItem(item) || id == null) {
            return List.of();
        }
        JsonObject input = new JsonObject();
        for (String field : List.of("query", "action", "results")) {
            if (item.has(field)) {
                input.add(field, item.get(field).deepCopy());
            }
        }
        JsonObject use = new JsonObject();
        use.addProperty("type", "tool_use");
        use.addProperty("id", id);
        use.addProperty("name", "webSearch");
        use.add("input", input);
        String status = HistoryMessageInjector.getStringProperty(item, "status");
        JsonObject call = CodexRecordedFileChange.message(record, payload, id, "assistant", use);
        if (status != null && !status.isEmpty() && !List.of("completed", "failed", "declined", "interrupted").contains(status)) {
            return List.of(call);
        }
        JsonObject result = new JsonObject();
        result.addProperty("type", "tool_result");
        result.addProperty("tool_use_id", id);
        result.addProperty("is_error", List.of("failed", "declined", "interrupted").contains(status == null ? "" : status));
        String error = item.has("error") && item.get("error").isJsonObject()
                ? HistoryMessageInjector.getStringProperty(item.getAsJsonObject("error"), "message") : null;
        JsonElement body = item.has("output") && !item.get("output").isJsonNull() ? item.get("output") : item.get("results");
        result.addProperty("content", error != null ? error : body == null || body.isJsonNull() ? ""
                : body.isJsonPrimitive() && body.getAsJsonPrimitive().isString() ? body.getAsString() : body.toString());
        return List.of(call,
                CodexRecordedFileChange.message(record, payload, id + ":result", "user", result));
    }
}
