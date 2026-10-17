package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Restores generated image receipts while keeping image bytes out of tool inputs. */
final class CodexRecordedImageGeneration {
    private CodexRecordedImageGeneration() { }

    static List<JsonObject> readMessages(JsonObject record) {
        JsonObject payload = object(record, "payload");
        JsonObject item = object(payload, "item");
        String id = HistoryMessageInjector.getStringProperty(item, "id");
        String type = HistoryMessageInjector.getStringProperty(item, "type");
        String stage = HistoryMessageInjector.getStringProperty(payload, "type");
        boolean imageGeneration = "ImageGeneration".equals(type) || "imageGeneration".equals(type)
                || "Extension".equals(type) && "image_gen.generation".equals(HistoryMessageInjector.getStringProperty(item, "kind"));
        if (!"event_msg".equals(HistoryMessageInjector.getStringProperty(record, "type"))
                || !List.of("item_started", "item_completed").contains(stage == null ? "" : stage) || !imageGeneration || id == null) {
            return List.of();
        }
        JsonObject input = new JsonObject();
        copyField(input, item, "revisedPrompt", "revisedPrompt", "revised_prompt");
        copyField(input, item, "path", "savedPath", "saved_path");
        copyField(input, item, "transparentBackground", "transparentBackground", null);
        JsonObject use = new JsonObject();
        use.addProperty("type", "tool_use");
        use.addProperty("id", id);
        use.addProperty("name", "imageGeneration");
        use.add("input", input);
        JsonObject call = CodexRecordedFileChange.message(record, payload, id, "assistant", use);
        String status = HistoryMessageInjector.getStringProperty(item, "status");
        if ("item_started".equals(stage) || status != null && !List.of("completed", "failed", "declined", "interrupted").contains(status)) {
            return List.of(call);
        }
        JsonArray content = new JsonArray();
        String data = HistoryMessageInjector.getStringProperty(item, "result");
        if (data != null && !data.isEmpty()) {
            // The existing card can render typed PNG output and navigate its saved path.
            JsonObject image = new JsonObject();
            JsonObject source = new JsonObject();
            source.addProperty("type", "base64");
            source.addProperty("media_type", "image/png");
            source.addProperty("data", data);
            image.addProperty("type", "image");
            image.add("source", source);
            content.add(image);
        }
        String path = HistoryMessageInjector.getStringProperty(input, "path");
        if (path != null && !path.isEmpty()) {
            content.add(textBlock(path));
        }
        JsonElement failure = item.get("failure");
        boolean failed = failure != null && !failure.isJsonNull();
        if (failed) {
            content.add(textBlock(failure.toString()));
        }
        JsonObject result = new JsonObject();
        result.addProperty("type", "tool_result");
        result.addProperty("tool_use_id", id);
        result.addProperty("is_error", failed || List.of("failed", "declined", "interrupted").contains(status == null ? "" : status));
        result.add("content", content);
        return List.of(call, CodexRecordedFileChange.message(record, payload, id + ":result", "user", result));
    }

    private static void copyField(JsonObject target, JsonObject item, String outputField, String field, String legacyField) {
        JsonElement value = item.get(field);
        if ((value == null || value.isJsonNull()) && legacyField != null) {
            value = item.get(legacyField);
        }
        if (value != null && !value.isJsonNull()) {
            target.add(outputField, value.deepCopy());
        }
    }

    private static JsonObject textBlock(String body) {
        JsonObject text = new JsonObject();
        text.addProperty("type", "text");
        text.addProperty("text", body);
        return text;
    }

    private static JsonObject object(JsonObject parent, String field) {
        JsonElement value = parent == null ? null : parent.get(field);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }

    /** Keeps started-only image receipts paired with their native root and turn. */
    static final class Lifecycle {
        private final Map<ImageIdentity, JsonObject> runningImages = new LinkedHashMap<>();
        private String currentTurnId;

        List<JsonObject> accept(JsonObject record, String rootThreadId) {
            JsonObject payload = object(record, "payload");
            String stage = HistoryMessageInjector.getStringProperty(payload, "type");
            if ("event_msg".equals(HistoryMessageInjector.getStringProperty(record, "type"))) {
                if ("task_started".equals(stage) || "turn_started".equals(stage)) {
                    this.currentTurnId = HistoryMessageInjector.getStringProperty(payload, "turn_id");
                } else if (("task_complete".equals(stage) || "turn_complete".equals(stage))
                        && this.currentTurnId != null && this.currentTurnId.equals(HistoryMessageInjector.getStringProperty(payload, "turn_id"))) {
                    this.currentTurnId = null;
                } else if ("turn_aborted".equals(stage)) {
                    return this.closeAbortedImages(record, payload, rootThreadId);
                }
            }
            List<JsonObject> messages = readMessages(record);
            if (messages.isEmpty()) {
                return messages;
            }
            JsonObject item = object(payload, "item");
            ImageIdentity identity = new ImageIdentity(HistoryMessageInjector.getStringProperty(payload, "thread_id"),
                    HistoryMessageInjector.getStringProperty(payload, "turn_id"), HistoryMessageInjector.getStringProperty(item, "id"));
            if (messages.size() == 1 && identity.threadId() != null && identity.turnId() != null) {
                this.runningImages.put(identity, record.deepCopy());
            } else {
                this.runningImages.remove(identity);
            }
            return messages;
        }

        long retainedBytes() {
            return this.runningImages.values().stream().mapToLong(record -> 3L * record.toString().length()).sum();
        }

        private List<JsonObject> closeAbortedImages(JsonObject record, JsonObject payload, String rootThreadId) {
            String turnId = HistoryMessageInjector.getStringProperty(payload, "turn_id");
            if (turnId == null) {
                turnId = this.currentTurnId;
            }
            if (rootThreadId == null || turnId == null) {
                return List.of();
            }
            List<JsonObject> results = new ArrayList<>();
            var images = this.runningImages.entrySet().iterator();
            while (images.hasNext()) {
                var entry = images.next();
                if (!rootThreadId.equals(entry.getKey().threadId()) || !turnId.equals(entry.getKey().turnId())) {
                    continue;
                }
                // An abort supplies the missing terminal without borrowing another image's receipt.
                JsonObject terminal = entry.getValue().deepCopy();
                JsonObject terminalPayload = terminal.getAsJsonObject("payload");
                terminalPayload.addProperty("type", "item_completed");
                terminalPayload.getAsJsonObject("item").addProperty("status", "interrupted");
                terminal.remove("timestamp");
                if (record.has("timestamp")) {
                    terminal.add("timestamp", record.get("timestamp").deepCopy());
                }
                JsonElement completedAt = payload.get("completed_at");
                if (completedAt != null && completedAt.isJsonPrimitive() && completedAt.getAsJsonPrimitive().isNumber()) {
                    terminalPayload.addProperty("completed_at_ms", completedAt.getAsLong() * 1000);
                }
                results.add(readMessages(terminal).get(1));
                images.remove();
            }
            if (turnId.equals(this.currentTurnId)) {
                this.currentTurnId = null;
            }
            return results;
        }

        private record ImageIdentity(String threadId, String turnId, String itemId) { }
    }
}
