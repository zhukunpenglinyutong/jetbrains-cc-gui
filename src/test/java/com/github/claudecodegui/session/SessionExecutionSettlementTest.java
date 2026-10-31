package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.github.claudecodegui.provider.zcode.ZcodeSDKBridge;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Every provider route and control wait must leave a settled turn once its operation is over. */
public class SessionExecutionSettlementTest {
    @Test
    public void grokResultSettlesItsTurn() {
        SessionState state = new SessionState();
        state.setProvider("grok");
        Object owner = state.beginTurn();
        SessionSendService sender = sender(state, new ResultGrokBridge(SDKResult.success("Grok reply")), null);

        sender.sendMessageToProvider("grok-channel", "Hello", null, null, "", null,
                null, null, null, null, owner).join();

        assertSettled(state, SessionExecutionState.Outcome.SUCCEEDED);
    }

    @Test
    public void zcodeFailureSettlesItsTurn() {
        SessionState state = new SessionState();
        state.setProvider("zcode");
        Object owner = state.beginTurn();
        SessionSendService sender = sender(state, null, new ResultZcodeBridge(SDKResult.error("ZCode failed")));

        sender.sendMessageToProvider("zcode-channel", "Hello", null, null, "", null,
                null, null, null, null, owner).join();

        assertSettled(state, SessionExecutionState.Outcome.FAILED);
    }

    @Test
    public void stoppedGrokRequestSettlesAsCancelled() {
        SessionState state = new SessionState();
        state.setProvider("grok");
        Object owner = state.beginTurn();
        state.getExecutionState().activity(state.getExecutionState().currentTurn(), SessionExecutionState.Phase.STOPPING);
        SDKResult stopped = SDKResult.error("User interrupted");
        stopped.cancelled = true;
        SessionSendService sender = sender(state, new ResultGrokBridge(stopped), null);

        sender.sendMessageToProvider("grok-channel", "Hello", null, null, "", null,
                null, null, null, null, owner).join();

        assertSettled(state, SessionExecutionState.Outcome.CANCELLED);
    }

    @Test
    public void cliProviderResultSettlesWithoutItsCallback() {
        SessionState state = new SessionState();
        state.setProvider("kimi");
        Object owner = state.beginTurn();
        state.getExecutionState().activity(state.getExecutionState().currentTurn(), SessionExecutionState.Phase.STOPPING);
        SDKResult stopped = SDKResult.error("User interrupted");
        stopped.cancelled = true;
        SessionSendService sender = new SessionSendService(null, state, new SessionCallbackFacade(null),
                new MessageParser(), new MessageMerger(), new Gson(), null, null,
                Map.of("kimi", new ResultCliBridge(stopped)), new SessionContextService(null), null, null);

        sender.sendMessageToProvider("kimi-channel", "Hello", null, null, "", null,
                null, null, null, null, owner).join();

        assertSettled(state, SessionExecutionState.Outcome.CANCELLED);
    }

    @Test
    public void rejectedCodexControlDoesNotLeaveALiveTurn() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        assertTrue(session.setCodexControlWaiting(true));

        // Early rejections (runtime inactive, thread owned elsewhere, daemon unavailable) never call back.
        assertTrue(session.setCodexControlWaiting(false));

        assertFalse(session.getState().isBusy());
        assertSettled(session.getState(), SessionExecutionState.Outcome.FAILED);
    }

    @Test
    public void stoppedRejectedCodexControlStillSettles() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        assertTrue(session.setCodexControlWaiting(true));
        SessionState state = session.getState();
        state.getExecutionState().activity(state.getExecutionState().currentTurn(), SessionExecutionState.Phase.STOPPING);

        assertTrue(session.setCodexControlWaiting(false));

        assertSettled(state, SessionExecutionState.Outcome.FAILED);
    }

    @Test
    public void stoppedCodexControlFailureSettlesWhenTheOperationEnds() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        assertTrue(session.setCodexControlWaiting(true));
        SessionState state = session.getState();
        MessageCallback control = session.createCodexControlCallback();
        state.getExecutionState().activity(state.getExecutionState().currentTurn(), SessionExecutionState.Phase.STOPPING);

        control.onError("Compaction failed");
        assertTrue(state.getExecutionState().hasLiveTurn());
        assertTrue(session.setCodexControlWaiting(false));

        assertSettled(state, SessionExecutionState.Outcome.FAILED);
    }

    @Test
    public void completedCodexControlKeepsItsProviderOutcome() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        assertTrue(session.setCodexControlWaiting(true));
        MessageCallback control = session.createCodexControlCallback();

        control.onComplete(SDKResult.success("Compacted"));
        assertTrue(session.setCodexControlWaiting(false));

        assertSettled(session.getState(), SessionExecutionState.Outcome.SUCCEEDED);
    }

    private static void assertSettled(SessionState state, SessionExecutionState.Outcome outcome) {
        SessionExecutionState.Snapshot snapshot = state.getExecutionSnapshot();
        assertEquals(outcome, snapshot.outcome());
        assertFalse(state.getExecutionState().hasLiveTurn());
    }

    private static SessionSendService sender(SessionState state, GrokSDKBridge grok, ZcodeSDKBridge zcode) {
        return new SessionSendService(null, state, new SessionCallbackFacade(null), new MessageParser(),
                new MessageMerger(), new Gson(), null, null, Map.of(), null, grok, zcode);
    }

    private static final class ResultGrokBridge extends GrokSDKBridge {
        private final SDKResult result;

        private ResultGrokBridge(SDKResult result) {
            this.result = result;
        }

        @Override
        public CompletableFuture<SDKResult> sendMessage(String channelId, String message, String sessionId,
                String runtimeSessionEpoch, String cwd, List<ClaudeSession.Attachment> attachments,
                String permissionMode, String model, JsonObject openedFiles, String agentPrompt, Boolean streaming,
                boolean disableThinking, String reasoningEffort, MessageCallback callback) {
            return CompletableFuture.completedFuture(result);
        }
    }

    private static final class ResultCliBridge extends MarkerCliBridge {
        private final SDKResult result;

        private ResultCliBridge(SDKResult result) {
            super(ResultCliBridge.class);
            this.result = result;
        }

        @Override
        protected String getProviderName() {
            return "kimi";
        }

        @Override
        protected String getStdinEnvKey() {
            return "KIMI_USE_STDIN";
        }

        @Override
        public CompletableFuture<SDKResult> sendMessage(String channelId, String message, String sessionId, String cwd,
                String model, String reasoningEffort, List<ClaudeSession.Attachment> attachments, String permissionMode,
                String dshPreset, Boolean thinking, MessageCallback callback) {
            return CompletableFuture.completedFuture(result);
        }
    }

    private static final class ResultZcodeBridge extends ZcodeSDKBridge {
        private final SDKResult result;

        private ResultZcodeBridge(SDKResult result) {
            this.result = result;
        }

        @Override
        public CompletableFuture<SDKResult> sendMessage(String channelId, String message, String sessionId,
                String runtimeSessionEpoch, String cwd, List<ClaudeSession.Attachment> attachments,
                String permissionMode, String model, JsonObject openedFiles, String agentPrompt, Boolean streaming,
                boolean disableThinking, String reasoningEffort, MessageCallback callback) {
            return CompletableFuture.completedFuture(result);
        }
    }
}
