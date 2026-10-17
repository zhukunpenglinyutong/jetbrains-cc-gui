package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.permission.PermissionManager;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class ClaudeSessionTest {

    @Test
    public void setSessionInfoNotifiesSessionIdWhenRestoringHistorySession() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        RecordingCallback callback = new RecordingCallback();
        session.setCallback(callback);

        session.setSessionInfo("history-session-123", "/workspace/demo");

        assertEquals("history-session-123", session.getSessionId());
        assertEquals("history-session-123", callback.lastSessionId);
        assertEquals("/workspace/demo", session.getCwd());
    }

    @Test
    public void hasNoTurnStartTimestampBeforeFirstSubmission() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);

        assertEquals(0L, session.getLastTurnStartedAtMillis());
    }

    /** Restored Codex controls and the next send share their existing default runtime. */
    @Test
    public void restoredCodexKeepsItsControlChannelBeforeFirstSend() throws Exception {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        session.setSessionInfo("restored-root", "/workspace/demo");

        assertEquals("codex", session.getChannelId());
        assertEquals("codex", session.launchClaude().get(5, TimeUnit.SECONDS));
        session.getState().setChannelId("existing-channel");
        session.setSessionInfo("restored-root", "/workspace/demo");
        assertEquals("existing-channel", session.getChannelId());
    }

    /** A new Codex chat still defers allocating its normal send channel. */
    @Test
    public void emptyCodexSessionDoesNotClaimARestoredControlChannel() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        session.setSessionInfo(null, "/workspace/demo");
        assertNull(session.getChannelId());
    }

    @Test
    public void interruptDoesNotResetAReplacementChannel() throws Exception {
        BlockingCodexBridge bridge = new BlockingCodexBridge(false);
        ClaudeSession session = new ClaudeSession(null, null, bridge, null);
        session.setProvider("codex");
        session.getState().setChannelId("old-channel");
        session.getState().setBusy(true);
        session.getState().setLoading(true);

        java.util.concurrent.CompletableFuture<Void> interrupt = session.interrupt();
        assertTrue(bridge.awaitInterrupt());
        session.getState().setChannelId("new-channel");
        session.getState().setError("new-channel-state");
        bridge.releaseInterrupt();
        interrupt.join();

        assertEquals("new-channel", session.getChannelId());
        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        assertEquals("new-channel-state", session.getError());
    }

    @Test
    public void delayedInterruptDoesNotResetNextTurnOnSameChannel() throws Exception {
        BlockingCodexBridge bridge = new BlockingCodexBridge(false);
        ClaudeSession session = new ClaudeSession(null, null, bridge, null);
        session.setProvider("codex");
        session.getState().setChannelId("shared-channel");
        session.getState().beginTurn();

        java.util.concurrent.CompletableFuture<Void> interrupt = session.interrupt();
        assertTrue(bridge.awaitInterrupt());
        session.getState().beginTurn();
        session.getState().setError("next-turn-state");
        bridge.releaseInterrupt();
        interrupt.join();

        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        assertEquals("next-turn-state", session.getError());
    }

    @Test
    public void endingControlWaitingClearsWaitingStateWhenNoSendInterleaved() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);

        session.setCodexControlWaiting(true);
        assertTrue(session.isBusy());
        assertTrue(session.isLoading());

        session.setCodexControlWaiting(false);
        assertFalse(session.isBusy());
        assertFalse(session.isLoading());
    }

    @Test
    public void endingControlWaitingKeepsTheLiveSendState() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setCodexControlWaiting(true);

        // The user sends while the control operation runs; its beginTurn owns
        // the waiting state when the operation completes.
        session.getState().beginTurn();
        session.setCodexControlWaiting(false);
        assertTrue(session.isBusy());
        assertTrue(session.isLoading());

        // A later control operation can claim the wait after the send has ended.
        session.getState().setBusy(false);
        session.getState().setLoading(false);
        session.setCodexControlWaiting(true);
        session.setCodexControlWaiting(false);
        assertFalse(session.isBusy());
        assertFalse(session.isLoading());
    }

    /** Controls must leave an already submitted message in charge of its wait. */
    @Test
    public void controlWaitingCannotBorrowAnActiveSend() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.getState().beginTurn();
        session.getState().setError("send-state");

        session.setCodexControlWaiting(true);
        session.setCodexControlWaiting(false);

        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        assertEquals("send-state", session.getError());
    }

    /** A restored control callback cannot end a message submitted after it. */
    @Test
    public void controlCallbackLeavesTheNextSendAlone() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        MessageCallback control = session.createCodexControlCallback();
        control.onMessage("stream_start", "");
        session.getState().beginTurn();
        session.getState().setError("next-send-state");

        control.onMessage("stream_end", "");
        control.onError("old-control-error");
        control.onComplete(new SDKResult());

        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        assertEquals("next-send-state", session.getError());
        assertTrue(session.getMessages().isEmpty());
    }

    /** Restoring another chat invalidates the old control's display receiver. */
    @Test
    public void replacedSessionIgnoresOldControlCallbacks() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setCodexControlWaiting(true);
        MessageCallback control = session.createCodexControlCallback();
        session.getState().rotateRuntimeSessionEpoch();
        session.getState().setError("restored-state");

        control.onError("old-control-error");
        control.onComplete(new SDKResult());

        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        assertEquals("restored-state", session.getError());
        assertTrue(session.getMessages().isEmpty());
    }

    /** Restoring history must retire the old display receiver and its waiting state. */
    @Test
    public void restoredThreadIgnoresThePreviousControlsMessagesAndTerminal() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        session.setSessionInfo("old-thread", "/workspace");
        assertTrue(session.setCodexControlWaiting(true));
        MessageCallback control = session.createCodexControlCallback();
        session.setSessionInfo("restored-thread", "/workspace");
        assertFalse(session.isBusy());
        assertFalse(session.isLoading());
        Object historyLoad = new Object();
        session.getState().claimLoading(historyLoad);
        session.getState().setError("restored-state");

        control.onMessage("session_id", "old-thread");
        control.onMessage("content_delta", "old answer");
        control.onMessage("stream_end", "");
        control.onError("old-control-error");
        control.onComplete(new SDKResult());

        assertEquals("restored-thread", session.getSessionId());
        assertFalse(session.isBusy());
        assertTrue(session.isLoading());
        assertTrue(session.getState().ownsLoading(historyLoad));
        assertEquals("restored-state", session.getError());
        assertTrue(session.getMessages().isEmpty());
    }

    /** Reselecting the old thread must not revive a callback retired by history restoration. */
    @Test
    public void reselectedThreadIgnoresItsPreviousControlReceiver() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        session.setSessionInfo("old-thread", "/workspace");
        assertTrue(session.setCodexControlWaiting(true));
        MessageCallback control = session.createCodexControlCallback();
        session.setSessionInfo("restored-thread", "/workspace");
        session.setSessionInfo("old-thread", "/workspace");
        assertTrue(session.setCodexControlWaiting(true));

        control.onMessage("content_delta", "old answer");
        control.onError("old-control-error");
        control.onComplete(new SDKResult());

        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        assertNull(session.getError());
        assertTrue(session.getMessages().isEmpty());
    }

    /** Refreshing the selected thread's metadata must preserve its live receiver. */
    @Test
    public void updatingTheSelectedThreadKeepsItsControlReceiver() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        session.setProvider("codex");
        session.setSessionInfo("selected-thread", "/workspace");
        assertTrue(session.setCodexControlWaiting(true));
        MessageCallback control = session.createCodexControlCallback();

        session.setSessionInfo("selected-thread", "/workspace/updated");

        assertTrue(session.isBusy());
        assertTrue(session.isLoading());
        control.onComplete(new SDKResult());
        assertFalse(session.isBusy());
        assertFalse(session.isLoading());
        assertEquals("/workspace/updated", session.getCwd());
    }

    /** A Stop acknowledgement from the old thread cannot unlock restored history. */
    @Test
    public void delayedInterruptLeavesRestoredHistoryLoading() throws Exception {
        BlockingCodexBridge bridge = new BlockingCodexBridge(false);
        ClaudeSession session = new ClaudeSession(null, null, bridge, null);
        session.setProvider("codex");
        session.setSessionInfo("old-thread", "/workspace");
        session.getState().beginTurn();

        java.util.concurrent.CompletableFuture<Void> interrupt = session.interrupt();
        assertTrue(bridge.awaitInterrupt());
        session.setSessionInfo("restored-thread", "/workspace");
        Object historyLoad = new Object();
        session.getState().claimLoading(historyLoad);
        session.getState().setError("restored-state");
        bridge.releaseInterrupt();
        interrupt.join();

        assertFalse(session.isBusy());
        assertTrue(session.isLoading());
        assertTrue(session.getState().ownsLoading(historyLoad));
        assertEquals("restored-state", session.getError());
    }

    @Test(expected = CompletionException.class)
    public void interruptCompletesExceptionallyWhenProviderInterruptFails() {
        BlockingCodexBridge bridge = new BlockingCodexBridge(true);
        ClaudeSession session = new ClaudeSession(null, null, bridge, null);
        session.setProvider("codex");
        session.getState().setChannelId("failing-channel");

        session.interrupt().join();
    }

    @Test
    public void nativeAutoKeepsResidualPermissionRequestsInteractive() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);

        session.setPermissionMode("auto");
        assertEquals(PermissionManager.PermissionMode.DEFAULT, session.getPermissionManager().getPermissionMode());

        session.setPermissionMode("bypassPermissions");
        assertEquals(PermissionManager.PermissionMode.ALLOW_ALL, session.getPermissionManager().getPermissionMode());
    }

    private static class RecordingCallback implements ClaudeSession.SessionCallback {
        private String lastSessionId;

        @Override
        public void onMessageUpdate(List<ClaudeSession.Message> messages) {
        }

        @Override
        public void onStateChange(boolean busy, boolean loading, String error) {
        }

        @Override
        public void onSessionIdReceived(String sessionId) {
            this.lastSessionId = sessionId;
        }

        @Override
        public void onPermissionRequested(com.github.claudecodegui.permission.PermissionRequest request) {
        }

        @Override
        public void onThinkingStatusChanged(boolean isThinking) {
        }

        @Override
        public void onSlashCommandsReceived(List<String> slashCommands) {
        }

        @Override
        public void onNodeLog(String log) {
        }

        @Override
        public void onSummaryReceived(String summary) {
        }
    }

    private static class BlockingCodexBridge extends CodexSDKBridge {
        private final CountDownLatch interruptStarted = new CountDownLatch(1);
        private final CountDownLatch interruptRelease = new CountDownLatch(1);
        private final boolean fail;

        private BlockingCodexBridge(boolean fail) {
            this.fail = fail;
        }

        @Override
        public void interruptChannel(String channelId) {
            interruptStarted.countDown();
            if (fail) {
                throw new IllegalStateException("interrupt failed");
            }
            try {
                if (!interruptRelease.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("interrupt test timed out");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("interrupt test interrupted", e);
            }
        }

        private boolean awaitInterrupt() throws InterruptedException {
            return interruptStarted.await(5, TimeUnit.SECONDS);
        }

        private void releaseInterrupt() {
            interruptRelease.countDown();
        }
    }
}
