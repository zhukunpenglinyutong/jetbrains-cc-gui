package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.time.Instant;
import java.util.List;
import java.util.stream.Collectors;

/** Recovers actual patch inputs and outcomes from completed transcript items. */
final class CodexRecordedFileChange {
    private CodexRecordedFileChange() { }

    static List<JsonObject> readMessages(JsonObject record) {
        if (!"event_msg".equals(HistoryMessageInjector.getStringProperty(record, "type"))) {
            return List.of();
        }
        JsonObject payload = object(record, "payload");
        JsonObject item = object(payload, "item");
        String id = HistoryMessageInjector.getStringProperty(item, "id");
        if (!"item_completed".equals(HistoryMessageInjector.getStringProperty(payload, "type"))
                || !"FileChange".equals(HistoryMessageInjector.getStringProperty(item, "type")) || id == null) {
            return List.of();
        }
        String status = HistoryMessageInjector.getStringProperty(item, "status");
        JsonObject input = new JsonObject();
        input.add("changes", readChanges(item.get("changes")));
        input.addProperty("status", status == null ? "unknown" : status);
        JsonObject tool = new JsonObject();
        tool.addProperty("type", "tool_use");
        tool.addProperty("id", id);
        tool.addProperty("name", "file_change");
        tool.add("input", input);
        JsonObject use = message(record, payload, id, "assistant", tool);
        if (!List.of("completed", "failed", "declined", "interrupted").contains(status == null ? "" : status)) {
            return List.of(use);
        }
        JsonObject result = new JsonObject();
        result.addProperty("type", "tool_result");
        result.addProperty("tool_use_id", id);
        result.addProperty("is_error", !"completed".equals(status));
        String stdout = HistoryMessageInjector.getStringProperty(item, "stdout");
        String stderr = HistoryMessageInjector.getStringProperty(item, "stderr");
        result.addProperty("content", (stdout == null ? "" : stdout)
                + (stderr == null || stderr.isEmpty() ? "" : (stdout == null || stdout.isEmpty() ? "" : "\n") + stderr));
        return List.of(use, message(record, payload, id + ":result", "user", result));
    }

    private static JsonElement readChanges(JsonElement source) {
        if (source == null || !source.isJsonObject()) {
            return source == null ? new JsonArray() : source.deepCopy();
        }
        JsonArray changes = new JsonArray();
        for (var entry : source.getAsJsonObject().entrySet()) {
            if (!entry.getValue().isJsonObject()) {
                return source.deepCopy();
            }
            JsonObject patch = entry.getValue().getAsJsonObject();
            String type = HistoryMessageInjector.getStringProperty(patch, "type");
            if (!List.of("add", "update", "delete").contains(type == null ? "" : type)) {
                return source.deepCopy();
            }
            JsonObject change = new JsonObject();
            change.addProperty("path", entry.getKey());
            JsonObject kind = new JsonObject();
            kind.addProperty("type", type);
            String movePath = HistoryMessageInjector.getStringProperty(patch, "move_path");
            if (movePath != null) {
                kind.addProperty("movePath", movePath);
            }
            change.add("kind", kind);
            String diff = HistoryMessageInjector.getStringProperty(patch, "unified_diff");
            String content = HistoryMessageInjector.getStringProperty(patch, "content");
            if (content != null && ("add".equals(type) || "delete".equals(type))) {
                change.addProperty("content", content);
                String prefix = "add".equals(type) ? "+" : "-";
                diff = content.lines().map(line -> prefix + line).collect(Collectors.joining("\n"));
            }
            change.addProperty("diff", diff == null ? "" : diff);
            changes.add(change);
        }
        return changes;
    }

    static JsonObject message(JsonObject record, JsonObject payload, String id, String role, JsonObject block) {
        JsonObject raw = new JsonObject();
        raw.addProperty("codexItemId", id);
        String thread = HistoryMessageInjector.getStringProperty(payload, "thread_id");
        String turn = HistoryMessageInjector.getStringProperty(payload, "turn_id");
        raw.addProperty("codexThreadId", thread);
        raw.addProperty("codexTurnId", turn);
        raw.addProperty("uuid", "codex:" + thread + ":" + turn + ":" + id);
        raw.addProperty("codexAuthoritative", true);
        JsonArray blocks = new JsonArray();
        blocks.add(block);
        raw.add("content", blocks);
        JsonObject message = new JsonObject();
        message.addProperty("type", role);
        message.addProperty("content", "assistant".equals(role) ? "Tool: " + block.get("name").getAsString() : "[tool_result]");
        message.add("raw", raw);
        String timestamp = HistoryMessageInjector.getStringProperty(record, "timestamp");
        JsonElement completed = payload.get("completed_at_ms");
        if (timestamp == null && completed != null && completed.isJsonPrimitive() && completed.getAsJsonPrimitive().isNumber()) {
            timestamp = Instant.ofEpochMilli(completed.getAsLong()).toString();
        }
        if (timestamp != null) {
            message.addProperty("timestamp", timestamp);
        }
        return message;
    }

    private static JsonObject object(JsonObject parent, String field) {
        JsonElement value = parent == null ? null : parent.get(field);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }
}
