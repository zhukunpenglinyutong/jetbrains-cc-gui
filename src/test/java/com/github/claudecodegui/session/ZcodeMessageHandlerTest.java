package com.github.claudecodegui.session;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ZcodeMessageHandlerTest {

    private static final class RecordingCallback implements ClaudeSession.SessionCallback {
        int messageUpdates;

        @Override public void onMessageUpdate(List<Message> messages) {
            messageUpdates++;
        }

        @Override public void onStateChange(boolean busy, boolean loading, String error) {}
        @Override public void onSessionIdReceived(String sessionId) {}
        @Override public void onPermissionRequested(PermissionRequest request) {}
        @Override public void onThinkingStatusChanged(boolean isThinking) {}
        @Override public void onSlashCommandsReceived(List<String> slashCommands) {}
        @Override public void onNodeLog(String log) {}
        @Override public void onSummaryReceived(String summary) {}
        @Override public void onStreamStart() {}
        @Override public void onStreamEnd() {}
        @Override public void onContentDelta(String delta) {}
        @Override public void onThinkingDelta(String delta) {}
    }

    private static ZcodeMessageHandler newHandler(SessionState state, RecordingCallback recorded) {
        CallbackHandler callbacks = new CallbackHandler();
        callbacks.setCallback(recorded);
        return new ZcodeMessageHandler(state, callbacks);
    }

    @Test
    public void previousTurnCallbacksCannotTouchTheNextTurn() {
        SessionState state = new SessionState();
        state.beginTurn();
        RecordingCallback recorded = new RecordingCallback();
        ZcodeMessageHandler previous = newHandler(state, recorded);
        previous.onMessage("stream_start", "");

        state.beginTurn();
        ZcodeMessageHandler current = newHandler(state, recorded);
        current.onMessage("stream_start", "");
        int updates = recorded.messageUpdates;

        previous.onMessage("content_delta", "stale answer");
        previous.onError("old agent exited");
        previous.onComplete(new SDKResult());

        assertTrue(state.isBusy());
        assertTrue(state.isLoading());
        assertNull(state.getError());
        assertEquals(updates, recorded.messageUpdates);
        assertFalse(state.getMessages().stream().anyMatch(m -> m.type == Message.Type.ERROR));
    }

    @Test
    public void replacedSessionIgnoresOldZcodeCallbacks() {
        SessionState state = new SessionState();
        state.beginTurn();
        ZcodeMessageHandler previous = newHandler(state, new RecordingCallback());
        state.rotateRuntimeSessionEpoch();
        state.beginTurn();

        previous.onMessage("session_id", "old-session");
        previous.onError("old error");
        previous.onComplete(new SDKResult());

        assertNull(state.getSessionId());
        assertNull(state.getError());
        assertTrue(state.isBusy());
    }
}
