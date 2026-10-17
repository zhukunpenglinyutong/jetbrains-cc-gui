package com.github.claudecodegui.handler.history;

import com.google.gson.JsonObject;

import java.util.List;

/** Restores terminal image views from rollout events without inventing a pending call. */
final class CodexRecordedImageView {
    private CodexRecordedImageView() { }

    static List<JsonObject> readMessages(JsonObject record) {
        if (!"event_msg".equals(HistoryMessageInjector.getStringProperty(record, "type"))) {
            return List.of();
        }
        JsonObject payload = record.has("payload") && record.get("payload").isJsonObject() ? record.getAsJsonObject("payload") : null;
        JsonObject item = payload != null && payload.has("item") && payload.get("item").isJsonObject() ? payload.getAsJsonObject("item") : null;
        String id = HistoryMessageInjector.getStringProperty(item, "id");
        if (!"item_completed".equals(HistoryMessageInjector.getStringProperty(payload, "type"))
                || !"ImageView".equals(HistoryMessageInjector.getStringProperty(item, "type")) || id == null) {
            return List.of();
        }
        JsonObject input = new JsonObject();
        input.addProperty("path", HistoryMessageInjector.getStringProperty(item, "path"));
        JsonObject use = new JsonObject();
        use.addProperty("type", "tool_use");
        use.addProperty("id", id);
        use.addProperty("name", "imageView");
        use.add("input", input);
        JsonObject result = new JsonObject();
        result.addProperty("type", "tool_result");
        result.addProperty("tool_use_id", id);
        String status = HistoryMessageInjector.getStringProperty(item, "status");
        result.addProperty("is_error", List.of("failed", "declined", "interrupted").contains(status == null ? "" : status));
        result.addProperty("content", "");
        return List.of(CodexRecordedFileChange.message(record, payload, id, "assistant", use),
                CodexRecordedFileChange.message(record, payload, id + ":result", "user", result));
    }
}
