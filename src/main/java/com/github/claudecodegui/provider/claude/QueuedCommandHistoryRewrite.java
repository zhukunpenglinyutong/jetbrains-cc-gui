package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * Rewrites Claude JSONL {@code queued_command} attachments that carry a user
 * prompt (steer / fold) into user messages, matching {@code session-service.js}.
 */
final class QueuedCommandHistoryRewrite {

    private QueuedCommandHistoryRewrite() {
    }

    /**
     * If {@code row} is a prompt/user-prompt queued_command attachment, return a
     * steered user message object; otherwise return {@code row} unchanged.
     *
     * @param row one JSONL object
     * @return rewritten or original row; {@code null} when {@code row} is null
     */
    static JsonObject rewrite(JsonObject row) {
        if (row == null) {
            return null;
        }
        if (!row.has("type") || row.get("type").isJsonNull()
                || !"attachment".equals(row.get("type").getAsString())) {
            return row;
        }
        if (!row.has("attachment") || !row.get("attachment").isJsonObject()) {
            return row;
        }
        JsonObject attachment = row.getAsJsonObject("attachment");
        if (!attachment.has("type") || attachment.get("type").isJsonNull()
                || !"queued_command".equals(attachment.get("type").getAsString())) {
            return row;
        }
        if (!attachment.has("commandMode") || attachment.get("commandMode").isJsonNull()) {
            return row;
        }
        String commandMode = attachment.get("commandMode").getAsString();
        if (!"prompt".equals(commandMode) && !"user-prompt".equals(commandMode)) {
            return row;
        }
        JsonObject rewritten = new JsonObject();
        rewritten.addProperty("type", "user");
        rewritten.addProperty("steered", true);
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonElement prompt = attachment.has("prompt") ? attachment.get("prompt") : null;
        if (prompt != null && !prompt.isJsonNull()) {
            message.add("content", prompt);
        } else {
            message.addProperty("content", "");
        }
        rewritten.add("message", message);
        if (row.has("uuid")) {
            rewritten.add("uuid", row.get("uuid"));
        }
        if (row.has("parentUuid")) {
            rewritten.add("parentUuid", row.get("parentUuid"));
        }
        if (row.has("timestamp")) {
            rewritten.add("timestamp", row.get("timestamp"));
        }
        return rewritten;
    }
}
