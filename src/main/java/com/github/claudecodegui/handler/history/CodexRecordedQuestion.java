package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/** Restores async questions from evaluated receipts and older function-call records. */
final class CodexRecordedQuestion {
    private CodexRecordedQuestion() { }

    static JsonObject readMessage(JsonObject record) {
        JsonObject payload = object(record, "payload");
        JsonObject item = object(payload, "item");
        String id;
        JsonElement source;
        if ("event_msg".equals(text(record, "type")) && "item_completed".equals(text(payload, "type"))
                && "AgentMessage".equals(text(item, "type")) && "async".equals(text(item, "delivery"))) {
            id = text(item, "id");
            source = item.get("questions");
        } else if ("response_item".equals(text(record, "type")) && "function_call".equals(text(payload, "type"))
                && "request_user_input_async".equals(text(payload, "name"))) {
            id = text(payload, "call_id");
            try {
                JsonElement arguments = JsonParser.parseString(text(payload, "arguments"));
                source = arguments.isJsonObject() ? arguments.getAsJsonObject().get("questions") : null;
            } catch (RuntimeException ignored) {
                return null;
            }
        } else {
            return null;
        }
        if (id == null || source == null || !source.isJsonArray()) {
            return null;
        }
        JsonArray questions = new JsonArray();
        for (int index = 0; index < source.getAsJsonArray().size(); index++) {
            JsonElement entry = source.getAsJsonArray().get(index);
            if (!entry.isJsonObject()) {
                continue;
            }
            JsonObject value = entry.getAsJsonObject();
            String title = text(value, "title");
            if (title == null || title.isBlank()) {
                continue;
            }
            JsonObject question = new JsonObject();
            question.addProperty("id", "question-" + (index + 1));
            question.addProperty("header", "");
            question.addProperty("question", title);
            question.addProperty("multiSelect", false);
            JsonArray options = new JsonArray();
            JsonElement choices = value.get("options");
            if (choices != null && choices.isJsonArray()) {
                for (JsonElement choice : choices.getAsJsonArray()) {
                    if (choice.isJsonPrimitive() && choice.getAsJsonPrimitive().isString() && !choice.getAsString().isBlank()) {
                        JsonObject option = new JsonObject();
                        option.addProperty("label", choice.getAsString());
                        option.addProperty("description", "");
                        options.add(option);
                    }
                }
            }
            question.add("options", options);
            questions.add(question);
        }
        if (questions.isEmpty()) {
            return null;
        }
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", "codex_user_input");
        JsonObject input = new JsonObject();
        input.add("questions", questions);
        block.add("input", input);
        JsonObject message = CodexRecordedFileChange.message(record, payload, id, "assistant", block);
        message.getAsJsonObject("raw").addProperty("codexItemType", "agentMessage");
        return message;
    }

    private static String text(JsonObject value, String key) {
        return HistoryMessageInjector.getStringProperty(value, key);
    }

    private static JsonObject object(JsonObject parent, String key) {
        JsonElement value = parent == null ? null : parent.get(key);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }
}
