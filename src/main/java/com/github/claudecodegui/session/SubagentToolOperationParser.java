package com.github.claudecodegui.session;

import com.github.claudecodegui.util.EditOperationBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;

final class SubagentToolOperationParser {

    private SubagentToolOperationParser() {
    }

    static List<ParsedToolOperation> toolOperations(JsonObject raw) {
        List<ParsedToolOperation> operations = new ArrayList<>();
        for (JsonObject block : contentBlocks(raw)) {
            if (!isToolUse(block) || !block.has("input") || !block.get("input").isJsonObject()) {
                continue;
            }
            JsonObject input = block.getAsJsonObject("input");
            EditOperationBuilder.Operation operation = operationFromToolInput(block, input);
            if (operation == null) {
                continue;
            }
            operations.add(new ParsedToolOperation(
                    operation,
                    getString(input, "source"),
                    getString(input, "scope_id"),
                    getLong(input, "edit_sequence"),
                    getString(block, "id")
            ));
        }
        return operations;
    }

    static List<String> successfulToolResultIds(JsonObject raw) {
        List<String> ids = new ArrayList<>();
        for (JsonObject block : contentBlocks(raw)) {
            if (!"tool_result".equals(getString(block, "type")) || isErroredToolResult(block)) {
                continue;
            }
            String toolUseId = getString(block, "tool_use_id");
            if (toolUseId != null) {
                ids.add(toolUseId);
            }
        }
        return ids;
    }

    private static List<JsonObject> contentBlocks(JsonObject raw) {
        if (raw == null || !raw.has("message") || !raw.get("message").isJsonObject()) {
            return List.of();
        }
        JsonObject message = raw.getAsJsonObject("message");
        if (!message.has("content") || !message.get("content").isJsonArray()) {
            return List.of();
        }
        JsonArray content = message.getAsJsonArray("content");
        List<JsonObject> blocks = new ArrayList<>();
        for (JsonElement element : content) {
            if (element.isJsonObject()) {
                blocks.add(element.getAsJsonObject());
            }
        }
        return blocks;
    }

    private static boolean isErroredToolResult(JsonObject block) {
        if (block == null || !block.has("is_error") || block.get("is_error").isJsonNull()) {
            return false;
        }
        try {
            return block.get("is_error").getAsBoolean();
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isToolUse(JsonObject block) {
        return "tool_use".equals(getString(block, "type"));
    }

    private static EditOperationBuilder.Operation operationFromToolInput(JsonObject block, JsonObject input) {
        String toolName = getString(block, "name");
        if (toolName == null) {
            return null;
        }
        String normalizedToolName = toolName.toLowerCase(java.util.Locale.ROOT);
        if (!normalizedToolName.equals("edit") && !normalizedToolName.equals("write")
                && !normalizedToolName.equals("edit_file") && !normalizedToolName.equals("write_file")) {
            return null;
        }
        String filePath = firstNonBlank(getString(input, "file_path"), getString(input, "filePath"), getString(input, "path"));
        if (filePath == null) {
            return null;
        }
        String oldString = firstNonBlank(getString(input, "old_string"), getString(input, "oldString"));
        String newString = firstNonBlank(getString(input, "new_string"), getString(input, "newString"), getString(input, "content"));
        boolean replaceAll = getBoolean(input, "replace_all") || getBoolean(input, "replaceAll");
        int lineStart = getInt(input, "start_line", getInt(input, "lineStart", 1));
        int lineEnd = getInt(input, "end_line", getInt(input, "lineEnd", lineStart));
        boolean safeToRollback = !input.has("safe_to_rollback") || !input.get("safe_to_rollback").isJsonPrimitive()
                || input.get("safe_to_rollback").getAsBoolean();
        String operationToolName = normalizedToolName.contains("write") ? "write" : "edit";
        return new EditOperationBuilder.Operation(
                operationToolName,
                filePath,
                oldString != null ? oldString : "",
                newString != null ? newString : "",
                replaceAll,
                lineStart,
                lineEnd,
                safeToRollback,
                firstNonBlank(getString(input, "expected_after_content_hash"), getString(input, "expectedAfterContentHash"))
        );
    }

    private static String getString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        try {
            return object.get(key).getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    private static boolean getBoolean(JsonObject object, String key) {
        return object != null && object.has(key) && !object.get(key).isJsonNull() && object.get(key).getAsBoolean();
    }

    private static int getInt(JsonObject object, String key, int fallback) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return fallback;
        }
        try {
            return object.get(key).getAsInt();
        } catch (Exception e) {
            return fallback;
        }
    }

    private static long getLong(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return 0L;
        }
        try {
            return object.get(key).getAsLong();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    record ParsedToolOperation(
            EditOperationBuilder.Operation operation,
            String source,
            String scopeId,
            long editSequence,
            String toolUseId
    ) {
    }
}
