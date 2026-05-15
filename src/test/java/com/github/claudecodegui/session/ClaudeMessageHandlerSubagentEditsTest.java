package com.github.claudecodegui.session;

import com.github.claudecodegui.util.FileSnapshotUtil;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.junit.Before;
import org.junit.Test;

import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ClaudeMessageHandlerSubagentEditsTest {
    private SessionState state;
    private RecordingCallbackHandler callbackHandler;
    private SubagentEditScopeTracker tracker;
    private ClaudeMessageHandler handler;

    @Before
    public void setUp() {
        state = new SessionState();
        callbackHandler = new RecordingCallbackHandler();
        tracker = new SubagentEditScopeTracker(null, new EditOperationRegistry());
        Gson gson = new GsonBuilder().create();
        handler = new ClaudeMessageHandler(
                null,
                state,
                callbackHandler,
                new MessageParser(),
                new MessageMerger(),
                gson,
                new SubagentLifecycleDetector(),
                tracker
        );
    }

    @Test
    public void taskCompletionAppendsSyntheticEditMessages() {
        handler.onMessage("assistant", """
                {"type":"assistant","message":{"content":[{"type":"tool_use","id":"task-1","name":"Task","input":{}}]}}
                """);
        tracker.recordBeforeSnapshot("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "old\n", 4, 1L, "h1"));
        tracker.recordAfterSnapshotForTest(Map.of("/tmp/File.java", new FileSnapshotUtil.FileSnapshot("/tmp/File.java", true, false, "new\n", 4, 2L, "h2")));

        handler.onMessage("user", """
                {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"task-1","content":"done"}]}}
                """);

        assertEquals(4, state.getMessages().size());
        assertEquals(ClaudeSession.Message.Type.ASSISTANT, state.getMessages().get(2).type);
        assertTrue(state.getMessages().get(2).raw.get("isMeta").getAsBoolean());
    }

    private static class RecordingCallbackHandler extends CallbackHandler {
        int messageUpdateCount = 0;

        @Override
        public void notifyMessageUpdate(java.util.List<ClaudeSession.Message> messages) {
            messageUpdateCount++;
        }
    }
}
