package com.github.claudecodegui.session;

import org.junit.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class SessionExecutionStateTest {
    @Test
    public void observationsDoNotStartWorkAndUiFlagsAreNotExecutionFacts() {
        SessionState state = new SessionState();
        SessionExecutionState.Snapshot initial = state.getExecutionSnapshot();
        state.setBusy(true);
        state.claimLoading(new Object());
        state.setError("history read failed");
        assertEquals(initial, state.getExecutionSnapshot());
        assertEquals(SessionExecutionState.Phase.IDLE, initial.phase());
        assertEquals("", initial.turnId());
        assertEquals("", initial.terminalEventId());
        assertEquals(0, initial.startedAt());
    }

    @Test
    public void newTurnsKeepBindingButReplaceTurnAndTerminalIdentities() {
        SessionExecutionState state = new SessionExecutionState(Clock.fixed(Instant.ofEpochMilli(1000), ZoneOffset.UTC));
        SessionExecutionState.Turn first = state.beginTurn();
        state.finish(first, SessionExecutionState.Outcome.SUCCEEDED);
        SessionExecutionState.Snapshot completed = state.snapshot();
        SessionExecutionState.Turn second = state.beginTurn();
        assertEquals(first.bindingEpoch(), second.bindingEpoch());
        assertNotEquals(first.turnId(), second.turnId());
        assertEquals(1000, completed.startedAt());
        assertEquals(1000, completed.completedAt());
        assertFalse(completed.terminalEventId().isEmpty());
        assertEquals("", state.snapshot().terminalEventId());
        assertEquals(SessionExecutionState.Outcome.NONE, state.snapshot().outcome());
    }

    @Test
    public void pendingQuestionsTakePrecedenceAndResolutionRestoresVerifiedActivity() {
        SessionExecutionState state = new SessionExecutionState();
        SessionExecutionState.Turn turn = state.beginTurn();
        state.activity(turn, SessionExecutionState.Phase.THINKING);
        SessionExecutionState.Interaction question = state.beginInteraction(turn, SessionExecutionState.WaitReason.QUESTION);
        SessionExecutionState.Interaction permission = state.beginInteraction(turn, SessionExecutionState.WaitReason.PERMISSION);
        assertEquals(SessionExecutionState.Phase.WAITING_USER, state.snapshot().phase());
        assertEquals(SessionExecutionState.WaitReason.QUESTION, state.snapshot().waitReason());
        assertEquals(2, state.snapshot().pendingInteractionCount());
        state.activity(turn, SessionExecutionState.Phase.RUNNING);
        assertTrue(state.endInteraction(question));
        assertEquals(SessionExecutionState.WaitReason.PERMISSION, state.snapshot().waitReason());
        assertTrue(state.endInteraction(permission));
        assertEquals(SessionExecutionState.Phase.RUNNING, state.snapshot().phase());
        assertEquals("", state.snapshot().pendingInteractionId());
        assertFalse(state.endInteraction(question));
    }

    @Test
    public void firstTerminalOutcomeWinsAndCannotBeReplayedByCleanup() {
        SessionExecutionState state = new SessionExecutionState();
        SessionExecutionState.Turn turn = state.beginTurn();
        SessionExecutionState.Interaction plan = state.beginInteraction(turn, SessionExecutionState.WaitReason.PLAN);
        assertTrue(state.finish(turn, SessionExecutionState.Outcome.SUCCEEDED));
        SessionExecutionState.Snapshot result = state.snapshot();
        assertFalse(state.finish(turn, SessionExecutionState.Outcome.FAILED));
        assertFalse(state.finish(turn, SessionExecutionState.Outcome.CANCELLED));
        assertFalse(state.activity(turn, SessionExecutionState.Phase.RUNNING));
        assertFalse(state.endInteraction(plan));
        assertNull(state.beginInteraction(turn, SessionExecutionState.WaitReason.QUESTION));
        assertEquals(0, result.pendingInteractionCount());
        assertEquals(result, state.snapshot());
    }

    @Test
    public void oldTurnsAndOldAnswersCannotChangeNewWork() {
        SessionExecutionState state = new SessionExecutionState();
        SessionExecutionState.Turn first = state.beginTurn();
        SessionExecutionState.Interaction oldQuestion = state.beginInteraction(first, SessionExecutionState.WaitReason.QUESTION);
        SessionExecutionState.Turn current = state.beginTurn();
        SessionExecutionState.Snapshot expected = state.snapshot();
        assertFalse(state.finish(first, SessionExecutionState.Outcome.FAILED));
        assertFalse(state.activity(first, SessionExecutionState.Phase.THINKING));
        assertFalse(state.endInteraction(oldQuestion));
        assertNull(state.beginInteraction(first, SessionExecutionState.WaitReason.PERMISSION));
        assertFalse(state.finish(new SessionExecutionState.Turn(current.bindingEpoch(), current.turnId()), SessionExecutionState.Outcome.SUCCEEDED));
        assertEquals(expected, state.snapshot());
    }

    @Test
    public void identicalInteractionFieldsDoNotGrantAnswerAuthority() {
        SessionExecutionState state = new SessionExecutionState();
        SessionExecutionState.Turn turn = state.beginTurn();
        SessionExecutionState.Interaction question = state.beginInteraction(turn, SessionExecutionState.WaitReason.QUESTION);
        assertFalse(state.endInteraction(new SessionExecutionState.Interaction(turn, question.id(), question.reason())));
        assertEquals(SessionExecutionState.Phase.WAITING_USER, state.snapshot().phase());
        assertTrue(state.endInteraction(question));
    }

    @Test
    public void rebindingRetiresAuthorityAndDoesNotInventAnOldOutcome() {
        SessionExecutionState state = new SessionExecutionState();
        SessionExecutionState.Turn old = state.beginTurn();
        state.rebind();
        assertNotEquals(old.bindingEpoch(), state.snapshot().bindingEpoch());
        assertEquals(SessionExecutionState.Phase.IDLE, state.snapshot().phase());
        assertEquals(SessionExecutionState.Outcome.NONE, state.snapshot().outcome());
        assertFalse(state.finish(old, SessionExecutionState.Outcome.SUCCEEDED));
    }

    @Test
    public void stopRequestIsNotCancellationAndTransportFailureWaitsForAcknowledgement() {
        SessionExecutionState state = new SessionExecutionState();
        SessionExecutionState.Turn turn = state.beginTurn();
        state.activity(turn, SessionExecutionState.Phase.STOPPING);
        assertEquals(SessionExecutionState.Outcome.NONE, state.snapshot().outcome());
        assertFalse(state.activity(turn, SessionExecutionState.Phase.RUNNING));
        assertFalse(state.finish(turn, SessionExecutionState.Outcome.FAILED));
        assertEquals(SessionExecutionState.Phase.UNKNOWN, state.snapshot().phase());
        assertTrue(state.finish(turn, SessionExecutionState.Outcome.CANCELLED));
        assertEquals(SessionExecutionState.Phase.CANCELLED, state.snapshot().phase());
    }

    @Test
    public void failedStopKeepsUncertaintyUnlessProviderAlreadyProvedFailure() {
        SessionExecutionState state = new SessionExecutionState();
        SessionExecutionState.Turn turn = state.beginTurn();
        state.activity(turn, SessionExecutionState.Phase.STOPPING);
        state.stopFailed(turn);
        assertEquals(SessionExecutionState.Phase.UNKNOWN, state.snapshot().phase());
        assertEquals(SessionExecutionState.Outcome.NONE, state.snapshot().outcome());
        state.activity(turn, SessionExecutionState.Phase.RUNNING);
        assertEquals(SessionExecutionState.Phase.RUNNING, state.snapshot().phase());

        turn = state.beginTurn();
        state.activity(turn, SessionExecutionState.Phase.STOPPING);
        state.finish(turn, SessionExecutionState.Outcome.FAILED);
        state.stopFailed(turn);
        assertEquals(SessionExecutionState.Outcome.FAILED, state.snapshot().outcome());
    }

    @Test
    public void interactionCapacityIsBoundedAndOverflowRemainsUncertainUntilNextTurn() {
        SessionExecutionState state = new SessionExecutionState();
        SessionExecutionState.Turn turn = state.beginTurn();
        SessionExecutionState.Interaction first = null;
        for (int index = 0; index < 16; index++) {
            SessionExecutionState.Interaction interaction = state.beginInteraction(turn, SessionExecutionState.WaitReason.QUESTION);
            if (index == 0) {
                first = interaction;
            }
        }
        assertNull(state.beginInteraction(turn, SessionExecutionState.WaitReason.PERMISSION));
        assertEquals(SessionExecutionState.Phase.UNKNOWN, state.snapshot().phase());
        assertEquals(0, state.snapshot().pendingInteractionCount());
        assertEquals(SessionExecutionState.WaitReason.NONE, state.snapshot().waitReason());
        assertEquals("", state.snapshot().pendingInteractionId());
        assertTrue(state.endInteraction(first));
        state.activity(turn, SessionExecutionState.Phase.RUNNING);
        assertEquals(SessionExecutionState.Phase.UNKNOWN, state.snapshot().phase());
        state.beginTurn();
        assertEquals(0, state.snapshot().pendingInteractionCount());
        assertEquals(SessionExecutionState.Phase.RUNNING, state.snapshot().phase());
    }

    @Test
    public void initialProviderSessionIdDiscoveryDoesNotReplaceAnActiveActor() {
        SessionState state = new SessionState();
        Object owner = state.beginTurn();
        SessionExecutionState.Snapshot before = state.getExecutionSnapshot();
        state.setSessionId("new-provider-session");
        assertEquals(before, state.getExecutionSnapshot());
        assertTrue(state.isCurrentTurn(owner));
        state.setSessionId("recovered-provider-session");
        assertEquals(before, state.getExecutionSnapshot());
        assertTrue(state.isCurrentTurn(owner));
        state.getExecutionState().finish(state.executionTurnForOwner(owner), SessionExecutionState.Outcome.SUCCEEDED);
        state.setSessionId("idle-replacement");
        assertNotEquals(before.bindingEpoch(), state.getExecutionSnapshot().bindingEpoch());
        assertFalse(state.isCurrentTurn(owner));
    }

    @Test
    public void lateInitialProviderIdentityDoesNotEraseTheTerminalEvent() {
        SessionState state = new SessionState();
        Object owner = state.beginTurn();
        state.getExecutionState().finish(state.executionTurnForOwner(owner), SessionExecutionState.Outcome.SUCCEEDED);
        SessionExecutionState.Snapshot completed = state.getExecutionSnapshot();
        state.setSessionId("late-provider-identity");
        assertEquals(completed, state.getExecutionSnapshot());
        assertTrue(state.isCurrentTurn(owner));
    }

    @Test
    public void historySelectionRetiresAnUnassignedActiveTurn() {
        ClaudeSession session = new ClaudeSession(null, null, null, null);
        SessionState state = session.getState();
        Object owner = state.beginTurn();
        SessionExecutionState.Snapshot previous = state.getExecutionSnapshot();
        session.setSessionInfo("selected-history", null);
        assertFalse(state.isCurrentTurn(owner));
        assertNotEquals(previous.bindingEpoch(), state.getExecutionSnapshot().bindingEpoch());
        assertEquals(SessionExecutionState.Phase.IDLE, state.getExecutionSnapshot().phase());
    }

    @Test
    public void providerAndRuntimeReplacementFenceOldOwnersButUnchangedSettingsDoNot() {
        SessionState state = new SessionState();
        Object owner = state.beginTurn();
        SessionExecutionState.Snapshot original = state.getExecutionSnapshot();
        state.setProvider("claude");
        state.setRuntimeSessionEpoch(state.getRuntimeSessionEpoch());
        assertEquals(original, state.getExecutionSnapshot());
        assertTrue(state.isCurrentTurn(owner));
        state.setProvider("codex");
        assertFalse(state.isCurrentTurn(owner));
        assertNotEquals(original.bindingEpoch(), state.getExecutionSnapshot().bindingEpoch());
        owner = state.beginTurn();
        state.rotateRuntimeSessionEpoch();
        assertFalse(state.isCurrentTurn(owner));
        assertEquals(SessionExecutionState.Phase.IDLE, state.getExecutionSnapshot().phase());
    }

    @Test
    public void rebindingClearsRetiredTurnFlagsButPreservesClaimedHistoryLoading() {
        for (boolean historyLoading : new boolean[]{false, true}) {
            for (String change : new String[]{"provider", "restored", "runtime"}) {
                SessionState state = new SessionState();
                state.setSessionId("original");
                Object owner = state.beginTurn();
                Object history = new Object();
                if (historyLoading) {
                    state.claimLoading(history);
                }
                switch (change) {
                    case "provider" -> state.setProvider("codex");
                    case "restored" -> state.setRestoredSessionId("replacement");
                    case "runtime" -> state.rotateRuntimeSessionEpoch();
                    default -> throw new AssertionError(change);
                }
                assertFalse(change, state.isCurrentTurn(owner));
                assertFalse(change, state.isBusy());
                assertEquals(change, historyLoading, state.isLoading());
                if (historyLoading) {
                    assertTrue(state.ownsLoading(history));
                    assertTrue(state.releaseLoading(history));
                }
                state.beginTurn();
                assertTrue(state.isBusy());
                assertTrue(state.isLoading());
            }
        }
    }
}
