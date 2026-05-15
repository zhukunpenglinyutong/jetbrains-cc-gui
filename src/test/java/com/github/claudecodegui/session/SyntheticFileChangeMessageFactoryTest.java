package com.github.claudecodegui.session;

import com.github.claudecodegui.util.EditOperationBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class SyntheticFileChangeMessageFactoryTest {

    @Test
    public void buildsHiddenAssistantAndUserMessagesWithMetadata() {
        EditOperationBuilder.Operation operation = new EditOperationBuilder.Operation(
                "edit", "/tmp/File.java", "old", "new", false, 3, 3, true, "hash"
        );
        SubagentEditScopeTracker.ScopeDescriptor scope = new SubagentEditScopeTracker.ScopeDescriptor(
                "scope-1", "claude", "task-1", "agent-a", 7
        );

        List<ClaudeSession.Message> messages = SyntheticFileChangeMessageFactory.build(scope, List.of(operation));

        assertEquals(2, messages.size());
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, messages.get(0).type);
        assertEquals("", messages.get(0).content);
        assertTrue(messages.get(0).raw.get("isMeta").getAsBoolean());

        JsonArray toolUses = messages.get(0).raw.getAsJsonObject("message").getAsJsonArray("content");
        JsonObject toolUse = toolUses.get(0).getAsJsonObject();
        assertEquals("edit", toolUse.get("name").getAsString());
        JsonObject input = toolUse.getAsJsonObject("input");
        assertEquals("subagent", input.get("source").getAsString());
        assertEquals("scope-1", input.get("scope_id").getAsString());
        assertEquals("agent-a", input.get("agent_handle").getAsString());
        assertEquals(7, input.get("edit_sequence").getAsInt());
        assertNotNull(input.get("operation_id").getAsString());

        JsonArray toolResults = messages.get(1).raw.getAsJsonObject("message").getAsJsonArray("content");
        assertEquals(toolUse.get("id").getAsString(), toolResults.get(0).getAsJsonObject().get("tool_use_id").getAsString());
    }
}
