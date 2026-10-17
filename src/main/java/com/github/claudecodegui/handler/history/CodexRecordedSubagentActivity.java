package com.github.claudecodegui.handler.history;

import com.google.gson.JsonObject;

import java.util.List;

/** Restores child identity and lifecycle without treating a launch receipt as completion. */
final class CodexRecordedSubagentActivity {
    private CodexRecordedSubagentActivity() { }

    static List<JsonObject> readMessages(JsonObject record) {
        if (!"event_msg".equals(HistoryMessageInjector.getStringProperty(record, "type"))) {
            return List.of();
        }
        JsonObject payload = record.has("payload") && record.get("payload").isJsonObject() ? record.getAsJsonObject("payload") : null;
        JsonObject item = payload != null && payload.has("item") && payload.get("item").isJsonObject() ? payload.getAsJsonObject("item") : null;
        String type = HistoryMessageInjector.getStringProperty(item, "type");
        String id = HistoryMessageInjector.getStringProperty(item, "id");
        if (!List.of("item_started", "item_completed").contains(HistoryMessageInjector.getStringProperty(payload, "type") == null
                ? "" : HistoryMessageInjector.getStringProperty(payload, "type"))
                || !List.of("SubAgentActivity", "subAgentActivity", "sub_agent_activity").contains(type == null ? "" : type) || id == null) {
            return List.of();
        }
        JsonObject input = new JsonObject();
        input.addProperty("toolUseId", id);
        input.addProperty("kind", HistoryMessageInjector.getStringProperty(item, "kind"));
        input.addProperty("agentThreadId", first(item, "agent_thread_id", "agentThreadId"));
        input.addProperty("agentPath", first(item, "agent_path", "agentPath"));
        JsonObject use = new JsonObject();
        use.addProperty("type", "tool_use");
        // Activity ids can equal their launch call ids. Keep both snapshots independently.
        use.addProperty("id", id + "-activity");
        use.addProperty("name", "subAgentActivity");
        use.add("input", input);
        JsonObject message = CodexRecordedFileChange.message(record, payload, id + "-activity", "assistant", use);
        message.getAsJsonObject("raw").addProperty("codexItemType", "subAgentActivity");
        return List.of(message);
    }

    private static String first(JsonObject item, String snakeCase, String camelCase) {
        String value = HistoryMessageInjector.getStringProperty(item, snakeCase);
        return value == null ? HistoryMessageInjector.getStringProperty(item, camelCase) : value;
    }
}
