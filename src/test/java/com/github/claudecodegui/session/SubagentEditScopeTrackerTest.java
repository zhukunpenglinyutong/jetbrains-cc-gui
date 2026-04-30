package com.github.claudecodegui.session;

import com.github.claudecodegui.util.FileSnapshotUtil;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class SubagentEditScopeTrackerTest {

    @Test
    public void completeScopeBuildsSyntheticMessagesForManualDelta() {
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        tracker.startScope("claude", "task-1", null);
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "old\n", 4, 1L, "h1"));
        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "new\n", 4, 2L, "h2")));

        List<ClaudeSession.Message> messages = tracker.completeByParentToolUseId("task-1", "token-1");

        assertEquals(2, messages.size());
        assertTrue(messages.get(0).raw.getAsJsonObject("message").getAsJsonArray("content").size() > 0);
    }

    @Test
    public void completeScopeIsIdempotentForSameToken() {
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        tracker.startScope("claude", "task-1", null);
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "old", 3, 1L, "h1"));
        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "new", 3, 2L, "h2")));

        assertEquals(2, tracker.completeByParentToolUseId("task-1", "token-1").size());
        assertTrue(tracker.completeByParentToolUseId("task-1", "token-1").isEmpty());
    }

    @Test
    public void completeScopeIgnoresUnrecordedAfterOnlyPaths() {
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        tracker.startScope("claude", "task-1", null);
        tracker.recordBeforeSnapshot("/tmp/Tracked.java", new FileSnapshotUtil.FileSnapshot("/tmp/Tracked.java", true, false, "old", 3, 1L, "h1"));
        tracker.recordAfterSnapshotForTest(Map.of(
                "/tmp/Tracked.java", new FileSnapshotUtil.FileSnapshot("/tmp/Tracked.java", true, false, "new", 3, 2L, "h2"),
                "/tmp/Untracked.java", new FileSnapshotUtil.FileSnapshot("/tmp/Untracked.java", true, false, "created elsewhere", 17, 2L, "h3")
        ));

        List<ClaudeSession.Message> messages = tracker.completeByParentToolUseId("task-1", "token-1");
        String raw = messages.get(0).raw.toString();

        assertTrue(raw.contains("Tracked.java"));
        assertTrue(!raw.contains("Untracked.java"));
    }

    @Test
    public void completeScopeFinalizesOnlyOnceAcrossDifferentTokens() {
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        tracker.startScope("codex", "spawn-1", "agent-1");
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "old", 3, 1L, "h1"));
        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "new", 3, 2L, "h2")));

        assertEquals(2, tracker.completeByAgentHandle("agent-1", "wait-1").size());

        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "newer", 5, 3L, "h3")));
        assertTrue(tracker.completeByAgentHandle("agent-1", "close-1").isEmpty());
        assertTrue(tracker.completeByParentToolUseId("spawn-1", "wait-2").isEmpty());
    }


    @Test
    public void cancelledScopeDoesNotFinalizeOrConflictWithLaterScope() {
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        tracker.startScope("claude", "task-1", null);
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "old", 3, 1L, "h1"));
        tracker.cancelByParentToolUseId("task-1");
        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "new", 3, 2L, "h2")));

        assertTrue(tracker.completeByParentToolUseId("task-1", "token-1").isEmpty());

        tracker.startScope("claude", "task-2", null);
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "new", 3, 2L, "h2"));
        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "newer", 5, 3L, "h3")));

        assertEquals(2, tracker.completeByParentToolUseId("task-2", "token-2").size());
    }

    @Test
    public void highPriorityOperationOnSamePathDoesNotSuppressDifferentSubagentHunk() {
        EditOperationRegistry registry = new EditOperationRegistry();
        registry.register(new com.github.claudecodegui.util.EditOperationBuilder.Operation(
                "edit", "/tmp/File.java", "alpha", "beta", false, 1, 1, true
        ), "codex_session_patch", null, 1L);
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, registry);
        tracker.startScope("claude", "task-1", null);
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "one\ntwo\n", 8, 1L, "h1"));
        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "one\nthree\n", 10, 2L, "h2")));

        assertEquals(2, tracker.completeByParentToolUseId("task-1", "token-1").size());
    }


    @Test
    public void deletedFileProducesVisibleUnsafeOperation() {
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        tracker.startScope("claude", "task-delete", null);
        tracker.recordBeforeSnapshot("/tmp/DeleteMe.java", new FileSnapshotUtil.FileSnapshot("/tmp/DeleteMe.java", true, false, "old content", 11, 1L, "h1"));
        tracker.recordAfterSnapshotForTest(Map.of());

        List<ClaudeSession.Message> messages = tracker.completeByParentToolUseId("task-delete", "token-delete");

        assertEquals(2, messages.size());
        String raw = messages.get(0).raw.toString();
        assertTrue(raw.contains("DeleteMe.java"));
        assertTrue(raw.contains("safe_to_rollback\":false"));
    }


    @Test
    public void overlappingScopesFailClosedForAmbiguousVfsEvents() {
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        tracker.startScope("codex", "spawn-1", "agent-1");
        tracker.recordVfsBeforePathForTest("/tmp/A.java", new FileSnapshotUtil.FileSnapshot("/tmp/A.java", true, false, "a1", 2, 1L, "a1"));
        tracker.startScope("codex", "spawn-2", "agent-2");
        tracker.recordVfsBeforePathForTest("/tmp/B.java", new FileSnapshotUtil.FileSnapshot("/tmp/B.java", true, false, "b1", 2, 1L, "b1"));
        tracker.recordAfterSnapshotForTest(Map.of(
                "/tmp/A.java", new FileSnapshotUtil.FileSnapshot("/tmp/A.java", true, false, "a2", 2, 2L, "a2"),
                "/tmp/B.java", new FileSnapshotUtil.FileSnapshot("/tmp/B.java", true, false, "b2", 2, 2L, "b2")
        ));

        assertEquals(2, tracker.completeByAgentHandle("agent-1", "wait-1").size());
        assertTrue(tracker.completeByAgentHandle("agent-2", "wait-2").isEmpty());

        SubagentEditScopeTracker ambiguous = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        ambiguous.startScope("codex", "spawn-3", "agent-3");
        ambiguous.startScope("codex", "spawn-4", "agent-4");
        ambiguous.recordVfsBeforePathForTest("/tmp/FirstTouch.java", new FileSnapshotUtil.FileSnapshot("/tmp/FirstTouch.java", true, false, "s1", 2, 1L, "s1"));
        ambiguous.recordAfterSnapshotForTest(Map.of(
                "/tmp/FirstTouch.java", new FileSnapshotUtil.FileSnapshot("/tmp/FirstTouch.java", true, false, "s2", 2, 2L, "s2")
        ));

        assertTrue(ambiguous.completeByAgentHandle("agent-3", "wait-3").isEmpty());
        assertTrue(ambiguous.completeByAgentHandle("agent-4", "wait-4").isEmpty());
    }



    @Test
    public void externalOperationConflictsActiveScopeOnSamePath() {
        SubagentEditScopeTracker tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        tracker.startScope("codex", "spawn-1", "agent-1");
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "old", 3, 1L, "h1"));

        tracker.registerExternalOperations(toolUseRaw("tool-main", "/tmp/File.java", "old", "main change", "codex_session_patch"));
        tracker.recordAfterSnapshotForTest(Map.of(
                "/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "subagent change", 15, 2L, "h2")
        ));

        assertTrue(tracker.completeByAgentHandle("agent-1", "wait-1").isEmpty());
    }

    private static JsonObject toolUseRaw(String id, String filePath, String oldString, String newString, String source) {
        JsonObject raw = new JsonObject();
        JsonObject message = new JsonObject();
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        JsonObject input = new JsonObject();
        input.addProperty("file_path", filePath);
        input.addProperty("old_string", oldString);
        input.addProperty("new_string", newString);
        input.addProperty("source", source);
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", "edit");
        block.add("input", input);
        content.add(block);
        message.add("content", content);
        raw.add("message", message);
        return raw;
    }

}
