package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.util.List;

/** Preserves evaluated dynamic-tool arguments and typed native result blocks. */
final class CodexRecordedDynamicToolCall {
    private CodexRecordedDynamicToolCall() { }

    static List<JsonObject> readMessages(JsonObject record) {
        JsonObject payload = object(record, "payload");
        JsonObject item = object(payload, "item");
        String id = HistoryMessageInjector.getStringProperty(item, "id");
        String tool = HistoryMessageInjector.getStringProperty(item, "tool");
        if (!"event_msg".equals(HistoryMessageInjector.getStringProperty(record, "type"))
                || !"item_completed".equals(HistoryMessageInjector.getStringProperty(payload, "type"))
                || !"DynamicToolCall".equals(HistoryMessageInjector.getStringProperty(item, "type")) || id == null || tool == null) {
            return List.of();
        }
        String namespace = HistoryMessageInjector.getStringProperty(item, "namespace");
        JsonElement arguments = item.get("arguments");
        JsonObject input = arguments != null && arguments.isJsonObject()
                ? arguments.getAsJsonObject().deepCopy() : new JsonObject();
        if (arguments == null || !arguments.isJsonObject()) {
            // Keep non-object arguments readable under the same key as the live projection.
            input.add("patch", arguments == null || arguments.isJsonNull() ? new JsonPrimitive("") : arguments.deepCopy());
        }
        JsonObject use = new JsonObject();
        use.addProperty("type", "tool_use");
        use.addProperty("id", id);
        use.addProperty("name", namespace == null || namespace.isBlank() ? tool : namespace + "." + tool);
        use.add("input", input);
        JsonObject message = CodexRecordedFileChange.message(record, payload, id, "assistant", use);
        String status = HistoryMessageInjector.getStringProperty(item, "status");
        if (!List.of("completed", "failed", "interrupted").contains(status == null ? "" : status)) {
            return List.of(message);
        }
        JsonArray content = new JsonArray();
        JsonElement entries = item.has("content_items") ? item.get("content_items") : item.get("contentItems");
        if (entries != null && entries.isJsonArray()) {
            for (JsonElement entry : entries.getAsJsonArray()) {
                JsonObject block = entry.isJsonObject() ? entry.getAsJsonObject().deepCopy() : null;
                String type = HistoryMessageInjector.getStringProperty(block, "type");
                if ("inputText".equals(type) || "input_text".equals(type)) {
                    block.addProperty("type", "text");
                } else if ("inputImage".equals(type) || "input_image".equals(type)) {
                    JsonObject source = new JsonObject();
                    source.addProperty("type", "url");
                    source.addProperty("url", HistoryMessageInjector.getStringProperty(block, block.has("image_url") ? "image_url" : "imageUrl"));
                    block.addProperty("type", "image");
                    block.add("source", source);
                }
                content.add(block == null ? entry.deepCopy() : block);
            }
        }
        String error = HistoryMessageInjector.getStringProperty(item, "error");
        if (error != null && !error.isBlank()) {
            JsonObject failure = new JsonObject();
            failure.addProperty("type", "text");
            failure.addProperty("text", error);
            content.add(failure);
        }
        JsonObject result = new JsonObject();
        result.addProperty("type", "tool_result");
        result.addProperty("tool_use_id", id);
        result.addProperty("is_error", !"completed".equals(status) || item.has("success") && item.get("success").isJsonPrimitive()
                && item.get("success").getAsJsonPrimitive().isBoolean() && !item.get("success").getAsBoolean());
        result.add("content", content);
        return List.of(message, CodexRecordedFileChange.message(record, payload, id + ":result", "user", result));
    }

    private static JsonObject object(JsonObject parent, String key) {
        JsonElement value = parent == null ? null : parent.get(key);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }
}
