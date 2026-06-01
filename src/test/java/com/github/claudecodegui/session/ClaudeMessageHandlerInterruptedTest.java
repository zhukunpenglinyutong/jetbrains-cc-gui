package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession.Message;
import com.google.gson.Gson;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

public class ClaudeMessageHandlerInterruptedTest {

    @Test
    public void interruptedCompletionAddsAssistantNoticeInsteadOfError() {
        SessionState state = new SessionState();
        state.setBusy(true);
        state.setLoading(true);

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

        handler.onMessage("stream_start", "");

        SDKResult result = SDKResult.error("__I18N__:chat.requestInterrupted");
        result.interrupted = true;
        handler.onComplete(result);

        assertFalse(state.isBusy());
        assertFalse(state.isLoading());
        assertNull(state.getError());
        assertEquals(ClaudeSession.SessionCallback.QueueDisplayState.COMPLETED, state.getQueueDisplayState());
        assertEquals(1, state.getMessages().size());
        Message message = state.getMessages().get(0);
        assertEquals(Message.Type.ASSISTANT, message.type);
        assertEquals("__I18N__:chat.requestInterrupted", message.content);
        assertEquals(1, callbackHandler.streamEndCalls);
        assertEquals(1, callbackHandler.messageUpdates.size());
    }

    private static class RecordingCallbackHandler extends CallbackHandler {
        final List<List<Message>> messageUpdates = new ArrayList<>();
        int streamEndCalls = 0;

        @Override
        public void notifyMessageUpdate(List<Message> messages) {
            messageUpdates.add(new ArrayList<>(messages));
        }

        @Override
        public void notifyStreamEnd() {
            streamEndCalls++;
        }
    }
}
