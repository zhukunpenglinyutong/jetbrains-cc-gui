package com.github.claudecodegui.session;

import com.github.claudecodegui.util.EditOperationBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Builds hidden synthetic edit/write messages consumable by the existing Edits pipeline. */
public final class SyntheticFileChangeMessageFactory {

    private SyntheticFileChangeMessageFactory() {
    }

    public static List<ClaudeSession.Message> build(
            SubagentEditScopeTracker.ScopeDescriptor scope,
            List<EditOperationBuilder.Operation> operations
    ) {
        if (operations == null || operations.isEmpty()) {
            return List.of();
        }

        JsonArray toolUses = new JsonArray();
        JsonArray toolResults = new JsonArray();
        int index = 0;
        for (EditOperationBuilder.Operation operation : operations) {
            String toolUseId = "subagent_" + operation.toolName() + "_" + scope.scopeId() + "_" + scope.editSequence() + "_" + index;
            String operationId = scope.scopeId() + ":" + scope.editSequence() + ":" + index + ":"
                    + UUID.nameUUIDFromBytes((operation.filePath() + operation.oldString() + operation.newString()).getBytes(StandardCharsets.UTF_8));

            JsonObject input = new JsonObject();
            input.addProperty("file_path", operation.filePath());
            input.addProperty("old_string", operation.oldString());
            input.addProperty("new_string", operation.newString());
            input.addProperty("oldString", operation.oldString());
            input.addProperty("newString", operation.newString());
            input.addProperty("replace_all", operation.replaceAll());
            input.addProperty("replaceAll", operation.replaceAll());
            input.addProperty("start_line", operation.lineStart());
            input.addProperty("end_line", operation.lineEnd());
            input.addProperty("source", "subagent");
            input.addProperty("scope_id", scope.scopeId());
            input.addProperty("parent_tool_use_id", scope.parentToolUseId());
            input.addProperty("operation_id", operationId);
            input.addProperty("safe_to_rollback", operation.safeToRollback());
            input.addProperty("edit_sequence", scope.editSequence());
            input.addProperty("existed_before", !"write".equals(operation.toolName()));
            input.addProperty("expected_after_content_hash", operation.expectedAfterContentHash());
            input.addProperty("expectedAfterContentHash", operation.expectedAfterContentHash());
            if (scope.agentHandle() != null) {
                input.addProperty("agent_handle", scope.agentHandle());
            }
            if ("write".equals(operation.toolName())) {
                input.addProperty("content", operation.newString());
            }

            JsonObject toolUse = new JsonObject();
            toolUse.addProperty("type", "tool_use");
            toolUse.addProperty("id", toolUseId);
            toolUse.addProperty("name", operation.toolName());
            toolUse.add("input", input);
            toolUses.add(toolUse);

            JsonObject toolResult = new JsonObject();
            toolResult.addProperty("type", "tool_result");
            toolResult.addProperty("tool_use_id", toolUseId);
            toolResult.addProperty("is_error", false);
            toolResult.addProperty("content", "Sub-agent edit captured");
            toolResults.add(toolResult);
            index++;
        }

        List<ClaudeSession.Message> messages = new ArrayList<>();
        messages.add(new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "", rawMessage("assistant", toolUses)));
        messages.add(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "", rawMessage("user", toolResults)));
        return messages;
    }

    private static JsonObject rawMessage(String role, JsonArray content) {
        JsonObject message = new JsonObject();
        message.addProperty("role", role);
        message.add("content", content);

        JsonObject raw = new JsonObject();
        raw.addProperty("type", role);
        raw.addProperty("isMeta", true);
        raw.add("message", message);
        return raw;
    }
}
