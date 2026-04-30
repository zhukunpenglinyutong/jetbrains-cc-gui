package com.github.claudecodegui.session;

import com.github.claudecodegui.util.FileSnapshotUtil;
import org.junit.Before;
import org.junit.Test;

import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class CodexMessageHandlerSubagentEditsTest {
    private SessionState state;
    private RecordingCallbackHandler callbackHandler;
    private SubagentEditScopeTracker tracker;
    private CodexMessageHandler handler;

    @Before
    public void setUp() {
        state = new SessionState();
        callbackHandler = new RecordingCallbackHandler();
        tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        handler = new CodexMessageHandler(state, callbackHandler, new SubagentLifecycleDetector(), tracker);
    }

    @Test
    public void waitAgentCompletionAppendsSyntheticEditMessages() {
        handler.onMessage("assistant", """
                {"type":"assistant","message":{"content":[{"type":"tool_use","id":"spawn-1","name":"spawn_agent","input":{}}]}}
                """);
        handler.onMessage("user", """
                {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"spawn-1","content":"{\\"agent_id\\":\\"agent-1\\"}"}]}}
                """);
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "old", 3, 1L, "h1"));
        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "new", 3, 2L, "h2")));
        handler.onMessage("assistant", """
                {"type":"assistant","message":{"content":[{"type":"tool_use","id":"wait-1","name":"wait_agent","input":{"target":"agent-1"}}]}}
                """);

        handler.onMessage("user", """
                {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"wait-1","content":"done"}]}}
                """);

        assertEquals(6, state.getMessages().size());
        assertTrue(state.getMessages().get(4).raw.get("isMeta").getAsBoolean());
    }

    private static class RecordingCallbackHandler extends CallbackHandler {
        @Override
        public void notifyMessageUpdate(java.util.List<ClaudeSession.Message> messages) {
        }
    }
}
