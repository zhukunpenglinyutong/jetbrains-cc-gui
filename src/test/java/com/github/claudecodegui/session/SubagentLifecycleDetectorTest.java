package com.github.claudecodegui.session;

import com.google.gson.Gson;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertFalse;

public class SubagentLifecycleDetectorTest {
    private final Gson gson = new Gson();

    @Test
    public void detectsClaudeTaskStartAndCompletion() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        List<SubagentLifecycleEvent> starts = detector.handleAssistant("claude", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"task-1","name":"Task","input":{}}]}}
                """, com.google.gson.JsonObject.class));
        assertEquals(1, starts.size());
        assertEquals(SubagentLifecycleEvent.Kind.STARTED, starts.get(0).kind());

        List<SubagentLifecycleEvent> completions = detector.handleUser("claude", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"task-1","content":"done"}]}}
                """, com.google.gson.JsonObject.class));
        assertEquals(1, completions.size());
        assertEquals(SubagentLifecycleEvent.Kind.COMPLETED, completions.get(0).kind());
        assertEquals("task-1", completions.get(0).parentToolUseId());
    }

    @Test
    public void detectsCodexSpawnResolveAndWaitCompletion() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        List<SubagentLifecycleEvent> starts = detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"spawn-1","name":"spawn_agent","input":{}}]}}
                """, com.google.gson.JsonObject.class));
        assertEquals(1, starts.size());

        List<SubagentLifecycleEvent> resolved = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"spawn-1","content":"{\\"agent_id\\":\\"agent-1\\"}"}]}}
                """, com.google.gson.JsonObject.class));
        assertEquals(SubagentLifecycleEvent.Kind.SPAWN_RESOLVED, resolved.get(0).kind());
        assertEquals("agent-1", resolved.get(0).agentHandle());

        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"wait-1","name":"wait_agent","input":{"target":"agent-1"}}]}}
                """, com.google.gson.JsonObject.class));
        List<SubagentLifecycleEvent> completed = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"wait-1","content":"done"}]}}
                """, com.google.gson.JsonObject.class));
        assertEquals(1, completed.size());
        assertEquals(SubagentLifecycleEvent.Kind.COMPLETED, completed.get(0).kind());
        assertEquals("agent-1", completed.get(0).agentHandle());
    }


    @Test
    public void emitsCancelledForErroredStartedLifecycleTool() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("claude", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"task-1","name":"Task","input":{}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> events = detector.handleUser("claude", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"task-1","is_error":true,"content":"failed"}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, events.size());
        assertEquals(SubagentLifecycleEvent.Kind.CANCELLED, events.get(0).kind());
        assertEquals("task-1", events.get(0).parentToolUseId());
    }

    @Test
    public void doesNotRestartCompletedToolUseWhenMergedRawIsReprocessed() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        com.google.gson.JsonObject assistant = gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"task-1","name":"Task","input":{}}]}}
                """, com.google.gson.JsonObject.class);

        assertFalse(detector.handleAssistant("claude", assistant).isEmpty());
        assertFalse(detector.handleUser("claude", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"task-1","content":"done"}]}}
                """, com.google.gson.JsonObject.class)).isEmpty());

        assertTrue(detector.handleAssistant("claude", assistant).isEmpty());
    }

    @Test
    public void startsCodexScopeForResumeAgent() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        List<SubagentLifecycleEvent> events = detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"resume-1","name":"resume_agent","input":{"target":"agent-1"}}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, events.size());
        assertEquals(SubagentLifecycleEvent.Kind.STARTED, events.get(0).kind());
        assertEquals("agent-1", events.get(0).agentHandle());
    }

    @Test
    public void ignoresErroredClaudeTaskResult() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("claude", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"task-1","name":"Task","input":{}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> completions = detector.handleUser("claude", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"task-1","is_error":true,"content":"failed"}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, completions.size());
        assertEquals(SubagentLifecycleEvent.Kind.CANCELLED, completions.get(0).kind());
    }

    @Test
    public void ignoresErroredCodexLifecycleResults() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"spawn-1","name":"spawn_agent","input":{}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> resolved = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"spawn-1","is_error":true,"content":"spawn failed"}]}}
                """, com.google.gson.JsonObject.class));
        assertEquals(1, resolved.size());
        assertEquals(SubagentLifecycleEvent.Kind.CANCELLED, resolved.get(0).kind());

        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"wait-1","name":"wait_agent","input":{"target":"agent-1"}}]}}
                """, com.google.gson.JsonObject.class));
        List<SubagentLifecycleEvent> completed = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"wait-1","is_error":true,"content":"timeout agent-1"}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, completed.size());
        assertEquals(SubagentLifecycleEvent.Kind.CANCELLED, completed.get(0).kind());
    }


    @Test
    public void cancelsErroredSendInputLifecycleResult() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"send-1","name":"send_input","input":{"target":"agent-1"}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> events = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"send-1","is_error":true,"content":"send failed"}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, events.size());
        assertEquals(SubagentLifecycleEvent.Kind.CANCELLED, events.get(0).kind());
        assertEquals("agent-1", events.get(0).agentHandle());
    }


    @Test
    public void waitAgentSingleTargetArrayCompletesThatHandle() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"wait-1","name":"wait_agent","input":{"targets":["agent-1"]}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> events = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"wait-1","content":"done"}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, events.size());
        assertEquals(SubagentLifecycleEvent.Kind.COMPLETED, events.get(0).kind());
        assertEquals("agent-1", events.get(0).agentHandle());
    }

    @Test
    public void waitAgentMultipleTargetsUsesResultHandleOnly() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"wait-1","name":"wait_agent","input":{"targets":["agent-1","agent-2"]}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> events = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"wait-1","content":"{\\"agent_id\\":\\"agent-2\\"}"}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, events.size());
        assertEquals(SubagentLifecycleEvent.Kind.COMPLETED, events.get(0).kind());
        assertEquals("agent-2", events.get(0).agentHandle());
    }

    @Test
    public void waitAgentMultipleTargetsWithoutResultHandleCompletesAllTargets() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"wait-1","name":"wait_agent","input":{"targets":["agent-1","agent-2"]}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> events = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"wait-1","content":"{\\"targets\\":[\\"agent-1\\",\\"agent-2\\"]}"}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(2, events.size());
        assertEquals(SubagentLifecycleEvent.Kind.COMPLETED, events.get(0).kind());
        assertEquals("agent-1", events.get(0).agentHandle());
        assertEquals("agent-2", events.get(1).agentHandle());
    }

    @Test
    public void resolvesCodexSpawnAgentFromPlainTextPath() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"spawn-plain","name":"spawn_agent","input":{}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> events = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"spawn-plain","content":"/tmp/codex-agent-abc.md"}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, events.size());
        assertEquals(SubagentLifecycleEvent.Kind.SPAWN_RESOLVED, events.get(0).kind());
        assertEquals("/tmp/codex-agent-abc.md", events.get(0).agentHandle());
    }


    @Test
    public void spawnAgentPlainTextErrorCancelsUnresolvedScope() {
        SubagentLifecycleDetector detector = new SubagentLifecycleDetector();
        detector.handleAssistant("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_use","id":"spawn-invalid","name":"spawn_agent","input":{}}]}}
                """, com.google.gson.JsonObject.class));

        List<SubagentLifecycleEvent> events = detector.handleUser("codex", gson.fromJson("""
                {"message":{"content":[{"type":"tool_result","tool_use_id":"spawn-invalid","content":"Full-history forked agents inherit the parent agent type, model, and reasoning effort; omit agent_type, model, and reasoning_effort."}]}}
                """, com.google.gson.JsonObject.class));

        assertEquals(1, events.size());
        assertEquals(SubagentLifecycleEvent.Kind.CANCELLED, events.get(0).kind());
        assertEquals("spawn-invalid", events.get(0).parentToolUseId());
        assertEquals(null, events.get(0).agentHandle());
    }

}
