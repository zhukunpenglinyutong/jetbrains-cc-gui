package com.github.claudecodegui.session;

import com.github.claudecodegui.session.ClaudeSession.Message;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import org.junit.Before;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for steer fold, undelivered, and capability handling on {@link ClaudeMessageHandler}.
 */
public class ClaudeMessageHandlerSteerTest {

    private RecordingCallbackHandler callbackHandler;
    private SessionState state;
    private ClaudeMessageHandler handler;

    @Before
    public void setUp() {
        callbackHandler = new RecordingCallbackHandler();
        state = new SessionState();
        MessageParser messageParser = new MessageParser();
        MessageMerger messageMerger = new MessageMerger();
        Gson gson = new GsonBuilder().create();
        handler = new ClaudeMessageHandler(
                null,
                state,
                callbackHandler,
                messageParser,
                messageMerger,
                gson
        );
    }

    @Test
    public void foldSplitsCurrentAssistantMessageAndNotifiesFolded() {
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "segment one");

        List<Message> beforeFold = state.getMessages();
        assertEquals(1, beforeFold.size());
        assertEquals(Message.Type.ASSISTANT, beforeFold.get(0).type);
        assertEquals("segment one", beforeFold.get(0).content);

        handler.onMessage("steer_folded",
                "{\"steerId\":\"steer-1\",\"uuid\":\"uuid-1\",\"prompt\":\"do not touch B\"}");

        List<Message> afterFold = state.getMessages();
        assertEquals(2, afterFold.size());
        assertEquals("segment one", afterFold.get(0).content);
        assertEquals(Message.Type.USER, afterFold.get(1).type);
        assertEquals("do not touch B", afterFold.get(1).content);
        assertNotNull(afterFold.get(1).raw);
        assertTrue(afterFold.get(1).raw.get("steered").getAsBoolean());
        assertEquals("steer-1", afterFold.get(1).raw.get("steerId").getAsString());
        assertEquals("steer-1", callbackHandler.lastFoldedSteerId);
        assertEquals("do not touch B", callbackHandler.lastFoldedMessage.content);

        handler.onMessage("content_delta", "segment two");
        List<Message> afterSplit = state.getMessages();
        assertEquals(3, afterSplit.size());
        assertEquals(Message.Type.ASSISTANT, afterSplit.get(0).type);
        assertEquals("segment one", afterSplit.get(0).content);
        assertEquals(Message.Type.USER, afterSplit.get(1).type);
        assertEquals(Message.Type.ASSISTANT, afterSplit.get(2).type);
        assertEquals("segment two", afterSplit.get(2).content);
        assertTrue(afterSplit.get(0) != afterSplit.get(2));
    }

    @Test
    public void undeliveredDoesNotRemoveTranscriptRowsOrChangeLoading() {
        state.setLoading(true);
        handler.onMessage("stream_start", "");
        handler.onMessage("content_delta", "partial");
        int messageCount = state.getMessages().size();

        handler.onMessage("steer_undelivered", "{\"steerId\":\"steer-u\"}");

        assertEquals(messageCount, state.getMessages().size());
        assertEquals("partial", state.getMessages().get(0).content);
        assertEquals("steer-u", callbackHandler.lastSteerId);
        assertEquals("undelivered", callbackHandler.lastSteerStatus);
        assertNull(callbackHandler.lastSteerReason);
        assertTrue(state.isLoading());
    }

    @Test
    public void capabilitiesPersistOnSessionStateUntilClearMessages() {
        handler.onMessage("capabilities", "{\"steer\":true}");
        assertTrue(state.isSteerCapable());
        assertTrue(callbackHandler.lastSteerCapable);

        state.setSessionId("mid-turn-session-id");
        assertTrue(state.isSteerCapable());

        state.clearMessages();
        assertFalse(state.isSteerCapable());
        assertTrue(state.getMessages().isEmpty());
    }

    private static class RecordingCallbackHandler extends CallbackHandler {
        String lastFoldedSteerId;
        Message lastFoldedMessage;
        String lastSteerId;
        String lastSteerStatus;
        String lastSteerReason;
        Boolean lastSteerCapable;

        @Override
        public void notifyMessageUpdate(List<Message> messages) {
        }

        @Override
        public void notifySteerFolded(String steerId, Message message) {
            lastFoldedSteerId = steerId;
            lastFoldedMessage = message;
        }

        @Override
        public void notifySteerResult(String steerId, String status, String reason) {
            lastSteerId = steerId;
            lastSteerStatus = status;
            lastSteerReason = reason;
        }

        @Override
        public void notifyProviderCapabilities(boolean steer) {
            lastSteerCapable = steer;
        }
    }
}
