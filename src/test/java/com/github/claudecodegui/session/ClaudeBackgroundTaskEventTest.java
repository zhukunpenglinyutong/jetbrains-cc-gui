package com.github.claudecodegui.session;

import com.google.gson.Gson;
import org.junit.Test;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

public class ClaudeBackgroundTaskEventTest {
    @Test
    public void forwardsAuthoritativeWorkflowSnapshotsWithoutStartingAForegroundTurn() {
        List<String> events = new ArrayList<>();
        CallbackHandler callbacks = new CallbackHandler() {
            @Override public void notifyTaskEvent(String event) { events.add(event); }
        };
        SessionState state = new SessionState();
        ClaudeMessageHandler handler = new ClaudeMessageHandler(null, state, callbacks,
                new MessageParser(), new MessageMerger(), new Gson());
        String started = "{\"type\":\"system\",\"subtype\":\"background_tasks_changed\",\"session_id\":\"session-1\","
                + "\"tasks\":[{\"task_id\":\"workflow-1\",\"task_type\":\"local_workflow\",\"parent_task_id\":\"agent-1\"}]}";
        String stopped = "{\"type\":\"system\",\"subtype\":\"background_tasks_changed\",\"session_id\":\"session-1\",\"tasks\":[]}";
        handler.onMessage("system", started);
        handler.onMessage("system", stopped);
        assertEquals(List.of(started, stopped), events);
        assertFalse(state.isBusy());
        assertTrue(state.getMessages().isEmpty());
    }
}
