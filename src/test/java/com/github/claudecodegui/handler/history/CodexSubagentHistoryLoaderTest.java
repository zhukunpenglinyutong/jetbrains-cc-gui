package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodexSubagentHistoryLoaderTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void loadsChildByParentActivityAndSkipsForkedParentTurn() throws Exception {
        Path sessionsDir = temporaryFolder.newFolder("sessions").toPath();
        String parentId = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
        String childId = "019fb0fe-c344-7da0-9d10-20659f884100";
        writeRollout(sessionsDir.resolve("rollout-parent-" + parentId + ".jsonl"),
                event("sub_agent_activity", "event_id", "call-123",
                        "agent_thread_id", childId, "agent_path", "/root/audit_ui"));
        writeRollout(sessionsDir.resolve("rollout-child-" + childId + ".jsonl"),
                event("task_started", "turn_id", "forked-turn"),
                turnContext("forked-turn"),
                sessionMeta(childId, parentId, "/root/audit_ui"),
                event("task_started", "turn_id", "child-turn"),
                responseMessage("assistant", "child output"),
                turnContext("child-turn"),
                event("task_complete", "turn_id", "child-turn"));

        CodexSubagentHistoryLoader.Result result =
                new CodexSubagentHistoryLoader(sessionsDir).load(parentId, "call-123", "audit_ui");

        assertEquals(childId, result.agentThreadId());
        assertEquals("/root/audit_ui", result.agentPath());
        assertTrue(result.completed());
        assertEquals("completed", result.status());
        assertTrue(result.messages().toString().contains("child output"));
        assertFalse(result.messages().toString().contains("forked-turn"));
    }

    @Test
    public void resolvesActivityRecordedAfterFormerLineLimit() throws Exception {
        Path sessionsDir = temporaryFolder.newFolder("large-sessions").toPath();
        String parentId = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
        String childId = "019fb0fe-c344-7da0-9d10-20659f884100";
        Path parentFile = sessionsDir.resolve("rollout-parent-" + parentId + ".jsonl");
        StringBuilder parentContent = new StringBuilder();
        for (int i = 0; i <= 50_000; i++) {
            parentContent.append(event("noop").toString()).append(System.lineSeparator());
        }
        parentContent.append(event("sub_agent_activity", "event_id", "call-123",
                "agent_thread_id", childId, "agent_path", "/root/audit_ui"));
        Files.writeString(parentFile, parentContent, StandardCharsets.UTF_8);
        StringBuilder childContent = new StringBuilder(parentContent);
        childContent.append(System.lineSeparator())
                .append(sessionMeta(childId, parentId, "/root/audit_ui"))
                .append(System.lineSeparator())
                .append(event("task_started", "turn_id", "child-turn"))
                .append(System.lineSeparator())
                .append(turnContext("child-turn"))
                .append(System.lineSeparator())
                .append(event("task_complete", "turn_id", "child-turn"));
        Files.writeString(sessionsDir.resolve("rollout-child-" + childId + ".jsonl"),
                childContent, StandardCharsets.UTF_8);

        CodexSubagentHistoryLoader.Result result =
                new CodexSubagentHistoryLoader(sessionsDir).load(parentId, "call-123", "audit_ui");

        assertEquals(childId, result.agentThreadId());
        assertTrue(result.completed());
    }

    @Test
    public void reportsRunningUntilMatchingChildTurnCompletes() {
        JsonArray rollout = new JsonArray();
        rollout.add(sessionMeta("child", "parent", "/root/audit_ui"));
        rollout.add(event("task_started", "turn_id", "child-turn"));
        rollout.add(turnContext("child-turn"));

        CodexSubagentHistoryLoader.TurnSlice result =
                CodexSubagentHistoryLoader.extractInitialSubagentTurn(rollout);

        assertEquals("running", result.status());
        assertEquals(2, result.messages().size());
    }

    @Test
    public void reportsAbortedMatchingChildTurnAsError() {
        JsonArray rollout = new JsonArray();
        rollout.add(sessionMeta("child", "parent", "/root/audit_ui"));
        rollout.add(event("task_started", "turn_id", "child-turn"));
        rollout.add(turnContext("child-turn"));
        rollout.add(event("turn_aborted", "turn_id", "child-turn"));

        CodexSubagentHistoryLoader.TurnSlice result =
                CodexSubagentHistoryLoader.extractInitialSubagentTurn(rollout);

        assertEquals("error", result.status());
        assertEquals("Codex subagent turn was aborted", result.error());
    }

    @Test
    public void loadsMultipleStatusesFromOneParentActivityMap() throws Exception {
        Path sessionsDir = temporaryFolder.newFolder("status-sessions").toPath();
        String parentId = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
        String completedChildId = "019fb0fe-c344-7da0-9d10-20659f884100";
        String runningChildId = "019fb0fe-c344-7da0-9d10-20659f884101";
        writeRollout(sessionsDir.resolve("rollout-parent-" + parentId + ".jsonl"),
                event("sub_agent_activity", "event_id", "call-completed",
                        "agent_thread_id", completedChildId, "agent_path", "/root/completed"),
                event("sub_agent_activity", "event_id", "call-running",
                        "agent_thread_id", runningChildId, "agent_path", "/root/running"));
        writeRollout(sessionsDir.resolve("rollout-child-" + completedChildId + ".jsonl"),
                sessionMeta(completedChildId, parentId, "/root/completed"),
                event("task_started", "turn_id", "completed-turn"),
                turnContext("completed-turn"),
                responseMessage("assistant", "large transcript must not be returned"),
                event("task_complete", "turn_id", "completed-turn"));
        writeRollout(sessionsDir.resolve("rollout-child-" + runningChildId + ".jsonl"),
                sessionMeta(runningChildId, parentId, "/root/running"),
                event("task_started", "turn_id", "running-turn"),
                turnContext("running-turn"),
                responseMessage("assistant", "still working"));

        List<CodexSubagentHistoryLoader.StatusResult> results =
                new CodexSubagentHistoryLoader(sessionsDir).loadStatuses(parentId, List.of(
                        new CodexSubagentHistoryLoader.StatusRequest("call-completed", "/root/completed", null),
                        new CodexSubagentHistoryLoader.StatusRequest("call-running", "/root/running", null)
                ));

        assertEquals(2, results.size());
        assertTrue(results.get(0).success());
        assertEquals(completedChildId, results.get(0).agentId());
        assertEquals("completed", results.get(0).status());
        assertTrue(results.get(0).completed());
        assertTrue(results.get(1).success());
        assertEquals(runningChildId, results.get(1).agentId());
        assertEquals("running", results.get(1).status());
        assertFalse(results.get(1).completed());
    }

    @Test
    public void missingActivityRemainsPending() throws Exception {
        Path sessionsDir = temporaryFolder.newFolder("pending-status-sessions").toPath();
        String parentId = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
        writeRollout(sessionsDir.resolve("rollout-parent-" + parentId + ".jsonl"), event("noop"));

        List<CodexSubagentHistoryLoader.StatusResult> results =
                new CodexSubagentHistoryLoader(sessionsDir).loadStatuses(parentId, List.of(
                        new CodexSubagentHistoryLoader.StatusRequest("call-pending", null, null)
                ));

        assertEquals(1, results.size());
        assertFalse(results.get(0).success());
        assertEquals("running", results.get(0).status());
        assertFalse(results.get(0).completed());
        assertEquals("Codex subagent activity not found yet", results.get(0).error());
    }

    @Test
    public void unreadableChildMetadataRemainsPendingInsteadOfPermanentError() throws Exception {
        // Regression test: a child rollout that exists but has no readable
        // session_meta yet (slow disk, file mid-write) must stay retryable.
        // Previously this surfaced as a terminal "does not belong to parent
        // session" error, which the frontend then locked in forever.
        Path sessionsDir = temporaryFolder.newFolder("unreadable-meta-sessions").toPath();
        String parentId = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
        String childId = "019fb0fe-c344-7da0-9d10-20659f884100";
        writeRollout(sessionsDir.resolve("rollout-parent-" + parentId + ".jsonl"), event("noop"));
        writeRollout(sessionsDir.resolve("rollout-child-" + childId + ".jsonl"),
                event("task_started", "turn_id", "child-turn"),
                turnContext("child-turn"));

        List<CodexSubagentHistoryLoader.StatusResult> results =
                new CodexSubagentHistoryLoader(sessionsDir).loadStatuses(parentId, List.of(
                        new CodexSubagentHistoryLoader.StatusRequest(null, null, childId)
                ));

        assertEquals(1, results.size());
        assertFalse(results.get(0).success());
        assertEquals("running", results.get(0).status());
        assertFalse(results.get(0).completed());
    }

    @Test
    public void rejectsAgentPathWithDotDotSegment() throws Exception {
        Path sessionsDir = temporaryFolder.newFolder("traversal-sessions").toPath();
        String parentId = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
        try {
            new CodexSubagentHistoryLoader(sessionsDir).loadStatuses(parentId, List.of(
                    new CodexSubagentHistoryLoader.StatusRequest(null, "/root/../evil", null)
            ));
            org.junit.Assert.fail("Expected IllegalArgumentException for .. agentPath segment");
        } catch (IllegalArgumentException expected) {
            assertEquals("Invalid agentPath", expected.getMessage());
        }
    }

    private static void writeRollout(Path path, JsonObject... records) throws IOException {    String content = String.join(System.lineSeparator(),
                java.util.Arrays.stream(records).map(JsonObject::toString).toList());
        Files.writeString(path, content, StandardCharsets.UTF_8);
    }

    private static JsonObject sessionMeta(String id, String parentId, String agentPath) {
        JsonObject spawn = object("parent_thread_id", parentId, "agent_path", agentPath);
        JsonObject subagent = new JsonObject();
        subagent.add("thread_spawn", spawn);
        JsonObject source = new JsonObject();
        source.add("subagent", subagent);
        JsonObject payload = object("id", id);
        payload.add("source", source);
        return record("session_meta", payload);
    }

    private static JsonObject turnContext(String turnId) {
        return record("turn_context", object("turn_id", turnId));
    }

    private static JsonObject event(String type, String... properties) {
        JsonObject payload = object(properties);
        payload.addProperty("type", type);
        return record("event_msg", payload);
    }

    private static JsonObject responseMessage(String role, String text) {
        JsonObject block = object("type", "output_text", "text", text);
        JsonArray content = new JsonArray();
        content.add(block);
        JsonObject payload = object("type", "message", "role", role);
        payload.add("content", content);
        return record("response_item", payload);
    }

    private static JsonObject record(String type, JsonObject payload) {
        JsonObject record = new JsonObject();
        record.addProperty("type", type);
        record.add("payload", payload);
        return record;
    }

    private static JsonObject object(String... properties) {
        JsonObject object = new JsonObject();
        for (int i = 0; i < properties.length; i += 2) {
            object.addProperty(properties[i], properties[i + 1]);
        }
        return object;
    }
}
