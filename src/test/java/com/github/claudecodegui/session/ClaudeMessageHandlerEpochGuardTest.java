package com.github.claudecodegui.session;

import com.google.gson.Gson;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ClaudeMessageHandlerEpochGuardTest {

    @Test
    public void ignoresCallbacksFromStaleRuntimeEpoch() {
        SessionState state = new SessionState();
        RecordingCallbackHandler callbackHandler = new RecordingCallbackHandler();
        ClaudeMessageHandler handler = new ClaudeMessageHandler(
                null,
                state,
                callbackHandler,
                new MessageParser(),
                new MessageMerger(),
                new Gson(),
                state.getRuntimeSessionEpoch()
        );

        state.rotateRuntimeSessionEpoch();

        handler.onMessage("content_delta", "stale");
        handler.onQueueDisplayStateChanged(ClaudeSession.SessionCallback.QueueDisplayState.PROCESSING, 0);
        handler.onError("stale error");
        handler.onComplete(new com.github.claudecodegui.provider.common.SDKResult());

        assertTrue(callbackHandler.contentDeltas.isEmpty());
        assertEquals(0, callbackHandler.queueUpdates);
        assertTrue(state.getMessages().isEmpty());
        assertEquals(ClaudeSession.SessionCallback.QueueDisplayState.NONE, state.getQueueDisplayState());
    }

    private static class RecordingCallbackHandler extends CallbackHandler {
        final List<String> contentDeltas = new ArrayList<>();
        int queueUpdates = 0;

        @Override
        public void notifyContentDelta(String delta) {
            contentDeltas.add(delta);
        }

        @Override
        public void notifyQueueDisplayStateChanged(ClaudeSession.SessionCallback.QueueDisplayState state, int aheadCount) {
            queueUpdates++;
        }
    }
}
