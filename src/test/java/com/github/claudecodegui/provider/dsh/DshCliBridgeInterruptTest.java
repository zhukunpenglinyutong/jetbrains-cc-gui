package com.github.claudecodegui.provider.dsh;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

public class DshCliBridgeInterruptTest {

    private static final class RecordingBridge extends DshCliBridge {
        final List<String> cancelled = new ArrayList<>();

        @Override
        void requestHostCancel(String sessionId) {
            cancelled.add(sessionId);
        }
    }

    private static final class RecordingCallback implements MessageCallback {
        final List<String> errors = new ArrayList<>();
        final List<SDKResult> completions = new ArrayList<>();

        @Override
        public void onMessage(String type, String content) {
        }

        @Override
        public void onError(String error) {
            errors.add(error);
        }

        @Override
        public void onComplete(SDKResult result) {
            completions.add(result);
        }
    }

    @Test
    public void interruptAsksTheHostToCancelTheChannelsSessionBeforeKilling() {
        RecordingBridge bridge = new RecordingBridge();
        bridge.startTurn("tab-1", "", new RecordingCallback()).onMessage("session_id", "dsh:abc");
        bridge.startTurn("tab-2", "other", new RecordingCallback());

        bridge.interruptChannel("tab-1");

        assertEquals(List.of("dsh:abc"), bridge.cancelled);
    }

    @Test
    public void interruptWithoutAKnownSessionDoesNotContactTheHost() {
        RecordingBridge bridge = new RecordingBridge();

        bridge.interruptChannel("tab-1");
        bridge.interruptChannel(null);
        bridge.startTurn("tab-1", "  ", new RecordingCallback());
        bridge.interruptChannel("tab-1");

        assertTrue(bridge.cancelled.isEmpty());
    }

    @Test
    public void aFinishedTurnDoesNotForgetTheNewerTurnOnTheSameChannel() {
        RecordingBridge bridge = new RecordingBridge();
        DshCliBridge.Turn old = bridge.startTurn("tab-1", "old", new RecordingCallback());
        bridge.startTurn("tab-1", "new", new RecordingCallback());

        bridge.forgetTurn("tab-1", old);
        bridge.interruptChannel("tab-1");

        assertEquals(List.of("new"), bridge.cancelled);
    }

    @Test
    public void theHostsCancelledErrorAfterStopEndsTheTurnAsInterrupted() {
        RecordingBridge bridge = new RecordingBridge();
        RecordingCallback callback = new RecordingCallback();
        DshCliBridge.Turn turn = bridge.startTurn("tab-1", "s1", callback);
        bridge.interruptChannel("tab-1");

        // The send process saw the host's cancelled turn end and exited before the kill.
        turn.onError("cancelled");
        SDKResult exited = SDKResult.error("cancelled");
        exited.processExited = true;
        SDKResult settled = turn.settle(exited);

        assertTrue(callback.errors.isEmpty());
        assertEquals(List.of(settled), callback.completions);
        assertTrue(settled.cancelled);
        assertFalse(settled.success);
        assertTrue(settled.processExited);
    }

    @Test
    public void aStoppedTurnThatReportedTheInterruptItselfIsNotCompletedTwice() {
        RecordingBridge bridge = new RecordingBridge();
        RecordingCallback callback = new RecordingCallback();
        DshCliBridge.Turn turn = bridge.startTurn("tab-1", "s1", callback);
        bridge.interruptChannel("tab-1");

        turn.onError("cancelled");
        SDKResult interrupted = SDKResult.error("User interrupted");
        turn.onComplete(interrupted);

        assertSame(interrupted, turn.settle(interrupted));
        assertEquals(List.of(interrupted), callback.completions);
        assertTrue(callback.errors.isEmpty());
    }

    @Test
    public void errorsWithoutStopStillReachTheUi() {
        RecordingCallback callback = new RecordingCallback();
        DshCliBridge.Turn turn = new RecordingBridge().startTurn("tab-1", "s1", callback);

        turn.onError("model overloaded");
        SDKResult failed = SDKResult.error("model overloaded");

        assertSame(failed, turn.settle(failed));
        assertEquals(List.of("model overloaded"), callback.errors);
        assertTrue(callback.completions.isEmpty());
    }
}
