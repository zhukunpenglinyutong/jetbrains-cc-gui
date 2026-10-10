package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import java.util.List;

/** Restores MCP calls from evaluated native receipts without interpreting wrapper source. */
final class CodexRecordedMcpToolCall {
    private CodexRecordedMcpToolCall() { }

    static List<JsonObject> readMessages(JsonObject record) {
        JsonObject payload = object(record, "payload");
        JsonObject item = object(payload, "item");
        String id = HistoryMessageInjector.getStringProperty(item, "id");
        String tool = HistoryMessageInjector.getStringProperty(item, "tool");
        if (!"event_msg".equals(HistoryMessageInjector.getStringProperty(record, "type"))
                || !"item_completed".equals(HistoryMessageInjector.getStringProperty(payload, "type"))
                || !"McpToolCall".equals(HistoryMessageInjector.getStringProperty(item, "type")) || id == null || tool == null) {
            return List.of();
        }
        JsonObject input = new JsonObject();
        input.addProperty("server", HistoryMessageInjector.getStringProperty(item, "server"));
        input.add("arguments", item.has("arguments") ? item.get("arguments").deepCopy() : new JsonObject());
        JsonObject use = new JsonObject();
        use.addProperty("type", "tool_use");
        use.addProperty("id", id);
        use.addProperty("name", tool);
        use.add("input", input);
        JsonObject message = CodexRecordedFileChange.message(record, payload, id, "assistant", use);
        String status = HistoryMessageInjector.getStringProperty(item, "status");
        if (!List.of("completed", "failed", "declined", "interrupted").contains(status == null ? "" : status)) {
            return List.of(message);
        }
        JsonElement output = item.get("result");
        JsonElement error = item.get("error");
        JsonObject result = new JsonObject();
        result.addProperty("type", "tool_result");
        result.addProperty("tool_use_id", id);
        result.addProperty("is_error", !"completed".equals(status) || error != null && !error.isJsonNull()
                || output != null && output.isJsonObject() && output.getAsJsonObject().has("isError")
                && output.getAsJsonObject().get("isError").isJsonPrimitive()
                && output.getAsJsonObject().get("isError").getAsBoolean());
        result.add("content", error != null && !error.isJsonNull() ? new JsonPrimitive(error.toString()) : projectResult(output));
        return List.of(message, CodexRecordedFileChange.message(record, payload, id + ":result", "user", result));
    }

    private static JsonElement projectResult(JsonElement output) {
        JsonObject result = output != null && output.isJsonObject() ? output.getAsJsonObject() : null;
        JsonElement content = result == null ? null : result.get("content");
        if (content == null || !content.isJsonArray()) {
            return new JsonPrimitive(output == null || output.isJsonNull() ? ""
                    : output.isJsonPrimitive() ? output.getAsString() : output.toString());
        }
        JsonArray blocks = new JsonArray();
        for (JsonElement entry : content.getAsJsonArray()) {
            JsonObject block = entry.isJsonObject() ? entry.getAsJsonObject() : null;
            String data = HistoryMessageInjector.getStringProperty(block, "data");
            String mimeType = HistoryMessageInjector.getStringProperty(block, "mimeType");
            if ("image".equals(HistoryMessageInjector.getStringProperty(block, "type")) && data != null && mimeType != null) {
                // The shared card reads Claude image sources rather than raw MCP fields.
                JsonObject image = new JsonObject();
                JsonObject source = new JsonObject();
                source.addProperty("type", "base64");
                source.addProperty("media_type", mimeType);
                source.addProperty("data", data);
                image.addProperty("type", "image");
                image.add("source", source);
                blocks.add(image);
            } else {
                blocks.add(entry.deepCopy());
            }
        }
        JsonElement structured = result.get("structuredContent");
        if (structured != null && !structured.isJsonNull()) {
            JsonObject text = new JsonObject();
            text.addProperty("type", "text");
            text.addProperty("text", structured.toString());
            blocks.add(text);
        }
        return blocks;
    }

    private static JsonObject object(JsonObject parent, String field) {
        JsonElement value = parent == null ? null : parent.get(field);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }
}
