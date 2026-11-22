package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Contract cases for actual backend adapter callbacks; no provider process is started. */
public class SessionExecutionAdapterTest {
    @Test
    public void recoveredCodexIdentityKeepsPendingQuestionsAndFollowingCallbacks() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setSessionId("expired-thread");
        Object owner = state.beginTurn();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler(), null, owner);
        handler.onMessage("codex_runtime_event", "{\"kind\":\"interactionRequested\",\"interactionKey\":\"question\","
                + "\"payload\":{\"method\":\"item/tool/requestUserInput\"}}");
        SessionExecutionState.Snapshot waiting = state.getExecutionSnapshot();

        handler.onMessage("session_id", "recovered-thread");

        assertEquals("recovered-thread", state.getSessionId());
        assertEquals(waiting, state.getExecutionSnapshot());
        assertTrue(state.isCurrentTurn(owner));
        assertTrue(state.isBusy());
        handler.onMessage("codex_runtime_event", "{\"kind\":\"interactionResolved\",\"interactionKey\":\"question\"}");
        handler.onMessage("content_delta", "Recovered reply");
        assertEquals(0, state.getExecutionSnapshot().pendingInteractionCount());
        assertEquals("Recovered reply", state.getMessages().get(0).content);
        handler.onComplete(SDKResult.success("Recovered reply"));
        assertEquals(SessionExecutionState.Outcome.SUCCEEDED, state.getExecutionSnapshot().outcome());
        assertFalse(state.isBusy());
    }

    @Test
    public void claudeStreamEndWaitsForAnExplicitOutcome() {
        SessionState state = new SessionState();
        state.beginTurn();
        ClaudeMessageHandler handler = claude(state);
        handler.onMessage("content_delta", "Reply");
        assertEquals(SessionExecutionState.Phase.RUNNING, state.getExecutionSnapshot().phase());
        handler.onMessage("thinking_delta", "Reasoning");
        assertEquals(SessionExecutionState.Phase.THINKING, state.getExecutionSnapshot().phase());
        handler.onMessage("stream_end", "");
        assertFalse(state.isBusy());
        assertEquals(SessionExecutionState.Phase.UNKNOWN, state.getExecutionSnapshot().phase());
        assertEquals(SessionExecutionState.Outcome.NONE, state.getExecutionSnapshot().outcome());
        handler.onComplete(SDKResult.success("Reply"));
        assertEquals(SessionExecutionState.Outcome.SUCCEEDED, state.getExecutionSnapshot().outcome());
    }

    @Test
    public void claudeResultFlagIsAuthoritativeWithoutUsageOrTextParsing() {
        SessionState state = new SessionState();
        state.beginTurn();
        ClaudeMessageHandler handler = claude(state);
        handler.onMessage("result", "{\"is_error\":true,\"result\":\"Task completed\"}");
        assertEquals(SessionExecutionState.Outcome.FAILED, state.getExecutionSnapshot().outcome());
        SessionExecutionState.Snapshot failed = state.getExecutionSnapshot();
        handler.onComplete(SDKResult.success("Cleanup finished"));
        assertEquals(failed, state.getExecutionSnapshot());

        state.beginTurn();
        handler = claude(state);
        handler.onMessage("result", "{\"is_error\":false,\"result\":\"Contains the word error\"}");
        assertEquals(SessionExecutionState.Outcome.SUCCEEDED, state.getExecutionSnapshot().outcome());
    }

    @Test
    public void codexMessageEndWaitsForNativeProviderOutcome() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.beginTurn();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        handler.onMessage("thinking_delta", "Reasoning");
        assertEquals(SessionExecutionState.Phase.THINKING, state.getExecutionSnapshot().phase());
        handler.onMessage("content_delta", "Reply");
        handler.onMessage("stream_end", "");
        assertEquals(SessionExecutionState.Outcome.NONE, state.getExecutionSnapshot().outcome());
        assertEquals(SessionExecutionState.Phase.UNKNOWN, state.getExecutionSnapshot().phase());
        handler.onMessage("message_end", "");
        assertEquals(SessionExecutionState.Outcome.NONE, state.getExecutionSnapshot().outcome());
        handler.onComplete(SDKResult.success("Native turn completed"));
        SessionExecutionState.Snapshot result = state.getExecutionSnapshot();
        assertEquals(SessionExecutionState.Outcome.SUCCEEDED, result.outcome());
        handler.onError("Cleanup failed");
        handler.onComplete(SDKResult.error("Cleanup failed"));
        handler.onMessage("message_end", "");
        assertEquals(result, state.getExecutionSnapshot());
    }

    @Test
    public void codexFailureAfterStreamEndDoesNotBecomeSuccess() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.beginTurn();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        handler.onMessage("stream_end", "");
        handler.onError("Provider failed");
        assertEquals(SessionExecutionState.Outcome.FAILED, state.getExecutionSnapshot().outcome());
    }

    @Test
    public void codexStopRequiresProofEvenAfterTransportCompletion() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.beginTurn();
        state.getExecutionState().activity(state.getExecutionState().currentTurn(), SessionExecutionState.Phase.STOPPING);
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        handler.onMessage("message_end", "");
        assertEquals(SessionExecutionState.Outcome.NONE, state.getExecutionSnapshot().outcome());
        SDKResult confirmed = SDKResult.error("Process terminated");
        confirmed.cancelled = true;
        handler.onComplete(confirmed);
        assertEquals(SessionExecutionState.Outcome.CANCELLED, state.getExecutionSnapshot().outcome());
    }

    @Test
    public void oldClaudeCallbacksCannotClearOrCompleteTheNextTurn() {
        SessionState state = new SessionState();
        state.beginTurn();
        ClaudeMessageHandler old = claude(state);
        state.beginTurn();
        SessionExecutionState.Snapshot current = state.getExecutionSnapshot();
        old.onMessage("content_delta", "Late old reply");
        old.onMessage("result", "{\"is_error\":false}");
        old.onError("Late old failure");
        old.onComplete(SDKResult.success("Late old success"));
        assertEquals(current, state.getExecutionSnapshot());
        assertTrue(state.isBusy());
        assertTrue(state.isLoading());
        assertTrue(state.getMessages().isEmpty());
        assertEquals(null, state.getError());
    }

    @Test
    public void lateCallbackConstructionKeepsItsOriginalOwner() {
        SessionState state = new SessionState();
        Object oldOwner = state.beginTurn();
        state.beginTurn();
        ClaudeMessageHandler lateClaude = new ClaudeMessageHandler(null, state, new CallbackHandler(),
                new MessageParser(), new MessageMerger(), new Gson(), null, oldOwner);
        CodexMessageHandler lateCodex = new CodexMessageHandler(state, new CallbackHandler(), null, oldOwner);
        SessionExecutionState.Snapshot current = state.getExecutionSnapshot();
        lateClaude.onError("Old failure");
        lateCodex.onMessage("message_end", "");
        lateCodex.onComplete(SDKResult.success("Old reply"));
        assertEquals(current, state.getExecutionSnapshot());
        assertTrue(state.isBusy());
        assertTrue(state.getMessages().isEmpty());
    }

    @Test
    public void deferredOldSendDoesNotReachProviderInitialization() {
        SessionState state = new SessionState();
        Object oldOwner = state.beginTurn();
        state.beginTurn();
        SessionSendService sender = new SessionSendService(null, state, new SessionCallbackFacade(null),
                new MessageParser(), new MessageMerger(), new Gson(), null, null, Map.of(), null);
        SessionExecutionState.Snapshot current = state.getExecutionSnapshot();
        sender.sendMessageToProvider("old-channel", "Old prompt", null, null, null, null,
                null, null, null, null, oldOwner).join();
        assertEquals(current, state.getExecutionSnapshot());
        assertTrue(state.isBusy());
    }

    @Test
    public void rebindingFencesBothProviderAdapters() {
        SessionState state = new SessionState();
        state.setSessionId("original-history");
        state.beginTurn();
        ClaudeMessageHandler claude = claude(state);
        CodexMessageHandler codex = new CodexMessageHandler(state, new CallbackHandler());
        state.setRestoredSessionId("replacement-history");
        SessionExecutionState.Snapshot restored = state.getExecutionSnapshot();
        claude.onMessage("content_delta", "Old reply");
        codex.onComplete(SDKResult.success("Old result"));
        assertEquals(restored, state.getExecutionSnapshot());
        assertEquals(SessionExecutionState.Phase.IDLE, restored.phase());
        assertFalse(state.isBusy());
        assertTrue(state.getMessages().isEmpty());
        state.beginTurn();
        SessionExecutionState.Snapshot current = state.getExecutionSnapshot();
        claude.onMessage("stream_end", "");
        codex.onComplete(SDKResult.success("Old result"));
        assertEquals(current, state.getExecutionSnapshot());
        assertTrue(state.isBusy());
    }

    @Test
    public void snapshotsContainNoConversationOrProviderErrorContent() {
        SessionState state = new SessionState();
        state.beginTurn();
        state.setSummary("PRIVATE_SUMMARY");
        state.setCwd("PRIVATE_WORKING_DIRECTORY");
        state.setSessionId("PRIVATE_PROVIDER_SESSION_ID");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "PRIVATE_PROMPT"));
        state.setError("PRIVATE_PROVIDER_ERROR");
        claude(state).onComplete(SDKResult.error("PRIVATE_PROVIDER_ERROR"));
        String exported = new Gson().toJson(state.getExecutionSnapshot());
        assertFalse(exported.contains("PRIVATE_"));
        assertFalse(exported.contains("turnOwner"));
        assertEquals(SessionExecutionState.Outcome.FAILED, state.getExecutionSnapshot().outcome());
    }

    @Test
    public void nativeInteractionRegistryEventsTrackWaitsWithoutReplayingOldOwners() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.beginTurn();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        String requested = "{\"kind\":\"interactionRequested\",\"interactionKey\":\"question-1\","
                + "\"payload\":{\"method\":\"item/tool/requestUserInput\"}}";
        handler.onMessage("codex_runtime_event", requested);
        handler.onMessage("codex_runtime_event", requested);
        assertEquals(SessionExecutionState.WaitReason.QUESTION, state.getExecutionSnapshot().waitReason());
        assertEquals(1, state.getExecutionSnapshot().pendingInteractionCount());
        handler.onMessage("codex_runtime_event", "{\"kind\":\"interactionResolved\",\"interactionKey\":\"question-1\"}");
        assertEquals(0, state.getExecutionSnapshot().pendingInteractionCount());
        state.beginTurn();
        SessionExecutionState.Snapshot current = state.getExecutionSnapshot();
        handler.onMessage("codex_runtime_event", requested);
        assertEquals(current, state.getExecutionSnapshot());
    }

    @Test
    public void asynchronousNativeQuestionsDoNotMarkARunningTurnAsBlocked() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.beginTurn();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        SessionExecutionState.Snapshot running = state.getExecutionSnapshot();
        handler.onMessage("codex_runtime_event", """
                {"kind":"interactionRequested","interactionKey":"async-question",
                 "payload":{"method":"item/agentMessage/requestUserInput","params":{"isBlocking":false}}}
                """);
        assertEquals(running, state.getExecutionSnapshot());
        handler.onMessage("codex_runtime_event", "{\"kind\":\"interactionResolved\",\"interactionKey\":\"async-question\"}");
        assertEquals(running, state.getExecutionSnapshot());
    }

    private static ClaudeMessageHandler claude(SessionState state) {
        return new ClaudeMessageHandler(null, state, new CallbackHandler(), new MessageParser(), new MessageMerger(), new Gson());
    }

    @Test
    public void malformedNativeEventsCannotInterruptLaterValidInteractions() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setSessionId("thread");
        state.beginTurn();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        String request = "{\"kind\":\"interactionRequested\",\"interactionKey\":\"question\","
                + "\"payload\":{\"method\":\"item/tool/requestUserInput\"}}";
        SessionExecutionState.Snapshot initial = state.getExecutionSnapshot();
        for (String field : new String[]{"kind", "interactionKey", "payload", "method"}) {
            for (String value : new String[]{"null", "{}", "[]", "true", "42", "\"\""}) {
                JsonObject event = JsonParser.parseString(request).getAsJsonObject();
                JsonObject target = "method".equals(field) ? event.getAsJsonObject("payload") : event;
                target.add(field, JsonParser.parseString(value));
                handler.onMessage("codex_runtime_event", event.toString());
                assertEquals(field + "=" + value, initial, state.getExecutionSnapshot());
            }
        }
        for (String invalid : new String[]{"null", "[]", "42", "{", ""}) {
            handler.onMessage("codex_runtime_event", invalid);
        }
        handler.onMessage("codex_runtime_event", request);
        assertEquals(SessionExecutionState.WaitReason.QUESTION, state.getExecutionSnapshot().waitReason());
        handler.onMessage("codex_runtime_event", "{\"kind\":\"interactionResolved\",\"interactionKey\":{}}");
        assertEquals(1, state.getExecutionSnapshot().pendingInteractionCount());
        handler.onMessage("codex_runtime_event", "{\"kind\":\"interactionResolved\",\"interactionKey\":\"question\"}");
        assertEquals(0, state.getExecutionSnapshot().pendingInteractionCount());
    }

    @Test
    public void nativeSettingsIgnoreNonStringFieldsWithoutChangingTheDirectory() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setSessionId("thread");
        state.setCwd("original");
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        for (String value : new String[]{"null", "{}", "[]", "true", "42"}) {
            handler.onMessage("codex_runtime_event", "{\"kind\":\"thread/settings/updated\",\"threadId\":" + value + ",\"payload\":{\"cwd\":\"wrong\"}}");
            handler.onMessage("codex_runtime_event", "{\"kind\":\"thread/settings/updated\",\"threadId\":\"thread\",\"payload\":{\"cwd\":" + value + "}}");
            assertEquals("original", state.getCwd());
        }
        handler.onMessage("codex_runtime_event", "{\"kind\":\"thread/settings/updated\",\"threadId\":\"thread\",\"payload\":{\"cwd\":\"updated\"}}");
        assertEquals("updated", state.getCwd());
    }

    @Test
    public void codexErrorReleasesNativeWaitsWhileStopStillNeedsProof() {
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.beginTurn();
        CodexMessageHandler handler = new CodexMessageHandler(state, new CallbackHandler());
        for (String key : new String[]{"first", "second"}) {
            handler.onMessage("codex_runtime_event", "{\"kind\":\"interactionRequested\",\"interactionKey\":\"" + key
                    + "\",\"payload\":{\"method\":\"item/tool/requestUserInput\"}}");
        }
        SessionExecutionState.Turn turn = state.getExecutionState().currentTurn();
        state.getExecutionState().activity(turn, SessionExecutionState.Phase.STOPPING);
        handler.onError("Transport closed before abort confirmation");
        assertEquals(SessionExecutionState.Phase.UNKNOWN, state.getExecutionSnapshot().phase());
        assertEquals(SessionExecutionState.Outcome.NONE, state.getExecutionSnapshot().outcome());
        assertEquals(0, state.getExecutionSnapshot().pendingInteractionCount());
        SDKResult abort = SDKResult.error("Native abort confirmed");
        abort.cancelled = true;
        handler.onComplete(abort);
        assertEquals(SessionExecutionState.Outcome.CANCELLED, state.getExecutionSnapshot().outcome());
    }

    @Test
    public void processExitSettlesStoppedFailureWithoutInventingCancellation() {
        for (String provider : new String[]{"claude", "codex"}) {
            SessionState state = new SessionState();
            state.setProvider(provider);
            state.beginTurn();
            MessageCallback handler = "codex".equals(provider) ? new CodexMessageHandler(state, new CallbackHandler()) : claude(state);
            state.getExecutionState().activity(state.getExecutionState().currentTurn(), SessionExecutionState.Phase.STOPPING);
            SDKResult exit = SDKResult.error("Process exited without cancellation proof");
            exit.processExited = true;
            handler.onComplete(exit);
            assertEquals(provider, SessionExecutionState.Outcome.FAILED, state.getExecutionSnapshot().outcome());
            assertFalse(state.getExecutionSnapshot().terminalEventId().isEmpty());
            SessionExecutionState.Snapshot terminal = state.getExecutionSnapshot();
            SDKResult late = SDKResult.error("Late cancellation");
            late.cancelled = true;
            handler.onComplete(late);
            assertEquals(terminal, state.getExecutionSnapshot());
        }
    }
}
