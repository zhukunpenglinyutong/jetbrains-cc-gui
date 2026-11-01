package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;
import org.junit.Test;

import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.*;

public class SessionExecutionOwnershipTest {
    @Test
    public void interactionFutureIsIdempotentAndEndsOnLocalAnswer() {
        SessionState session = running();
        SessionExecutionOwnership owner = session.currentExecutionOwnership();
        CompletableFuture<String> question = new CompletableFuture<>();
        owner.bindInteraction(SessionExecutionState.WaitReason.QUESTION, question);
        owner.bindInteraction(SessionExecutionState.WaitReason.QUESTION, question);
        assertEquals(1, session.getExecutionSnapshot().pendingInteractionCount());
        assertEquals(SessionExecutionState.WaitReason.QUESTION, session.getExecutionSnapshot().waitReason());
        assertTrue(owner.state().hasOwnedPendingWork());
        question.complete("LOCAL_PRIVATE_ANSWER");
        assertEquals(SessionExecutionState.Phase.RUNNING, session.getExecutionSnapshot().phase());
        assertFalse(owner.state().hasOwnedPendingWork());
        assertEquals(SessionExecutionState.Outcome.NONE, session.getExecutionSnapshot().outcome());
    }

    @Test
    public void actualWaitOverridesUnprovenStreamEndAndDenialIsNotTaskFailure() {
        SessionState session = running();
        SessionExecutionOwnership owner = session.currentExecutionOwnership();
        owner.state().activity(owner.turn(), SessionExecutionState.Phase.UNKNOWN);
        CompletableFuture<Boolean> approval = new CompletableFuture<>();
        owner.bindInteraction(SessionExecutionState.WaitReason.PERMISSION, approval);
        assertEquals(SessionExecutionState.Phase.WAITING_USER, session.getExecutionSnapshot().phase());
        approval.complete(false);
        assertEquals(SessionExecutionState.Phase.UNKNOWN, session.getExecutionSnapshot().phase());
        assertEquals(SessionExecutionState.Outcome.NONE, session.getExecutionSnapshot().outcome());
    }

    @Test
    public void concurrentQuestionsPlansAndExceptionsOnlyReleaseTheirOwnWait() {
        SessionState session = running();
        SessionExecutionOwnership owner = session.currentExecutionOwnership();
        CompletableFuture<String> first = new CompletableFuture<>();
        CompletableFuture<Boolean> second = new CompletableFuture<>();
        owner.bindInteraction(SessionExecutionState.WaitReason.QUESTION, first);
        owner.bindInteraction(SessionExecutionState.WaitReason.PLAN, second);
        first.completeExceptionally(new IllegalStateException("Question expired"));
        assertEquals(SessionExecutionState.WaitReason.PLAN, session.getExecutionSnapshot().waitReason());
        second.cancel(false);
        assertEquals(SessionExecutionState.Outcome.NONE, session.getExecutionSnapshot().outcome());
        assertEquals(0, session.getExecutionSnapshot().pendingInteractionCount());
    }

    @Test
    public void completedFutureAndIdleDialogsCannotInventAnExecution() {
        SessionState idle = new SessionState();
        assertNull(idle.currentExecutionOwnership());
        SessionState session = running();
        session.currentExecutionOwnership().bindInteraction(SessionExecutionState.WaitReason.PLAN, CompletableFuture.completedFuture(false));
        assertEquals(0, session.getExecutionSnapshot().pendingInteractionCount());
    }

    @Test
    public void oldBindingFutureCompletesOnlyItsDetachedExecution() {
        SessionState session = running();
        SessionExecutionOwnership old = session.currentExecutionOwnership();
        CompletableFuture<SDKResult> backend = new CompletableFuture<>();
        CompletableFuture<Boolean> approval = new CompletableFuture<>();
        old.bindResult(backend);
        old.bindInteraction(SessionExecutionState.WaitReason.PERMISSION, approval);
        session.setProvider("codex");
        session.beginTurn();
        SessionExecutionState.Snapshot replacement = session.getExecutionSnapshot();
        approval.complete(false);
        backend.complete(SDKResult.success("PRIVATE_RESULT"));
        assertEquals(SessionExecutionState.Outcome.SUCCEEDED, old.state().snapshot().outcome());
        assertEquals(replacement, session.getExecutionSnapshot());
        assertTrue(session.isBusy());
    }

    @Test
    public void futureCancellationAndVoidLifecycleDoNotProveProviderSuccessOrCancellation() {
        SessionState session = running();
        SessionExecutionOwnership owner = session.currentExecutionOwnership();
        CompletableFuture<Void> lifecycle = new CompletableFuture<>();
        owner.bindLifecycle(lifecycle);
        lifecycle.complete(null);
        assertEquals(SessionExecutionState.Outcome.NONE, session.getExecutionSnapshot().outcome());
        CompletableFuture<SDKResult> backend = new CompletableFuture<>();
        owner.bindResult(backend);
        backend.cancel(false);
        assertEquals(SessionExecutionState.Phase.UNKNOWN, session.getExecutionSnapshot().phase());
        assertEquals(SessionExecutionState.Outcome.NONE, session.getExecutionSnapshot().outcome());
    }

    @Test
    public void sdkResultAndExplicitProcessTerminationAreAuthoritative() {
        SessionState session = running();
        SessionExecutionOwnership owner = session.currentExecutionOwnership();
        CompletableFuture<SDKResult> backend = new CompletableFuture<>();
        owner.bindResult(backend);
        owner.state().activity(owner.turn(), SessionExecutionState.Phase.STOPPING);
        SDKResult result = SDKResult.error("Process terminated");
        result.cancelled = true;
        backend.complete(result);
        assertEquals(SessionExecutionState.Outcome.CANCELLED, session.getExecutionSnapshot().outcome());
        String terminal = session.getExecutionSnapshot().terminalEventId();
        owner.bindResult(CompletableFuture.completedFuture(SDKResult.success("Cleanup")));
        assertEquals(terminal, session.getExecutionSnapshot().terminalEventId());
    }

    private static SessionState running() {
        SessionState state = new SessionState();
        state.beginTurn();
        return state;
    }

    @Test
    public void exitedProcessResultSettlesDetachedStopWithoutChangingReplacement() {
        SessionState session = running();
        SessionExecutionOwnership old = session.currentExecutionOwnership();
        CompletableFuture<SDKResult> backend = new CompletableFuture<>();
        old.bindResult(backend);
        old.state().activity(old.turn(), SessionExecutionState.Phase.STOPPING);
        old.state().finish(old.turn(), SessionExecutionState.Outcome.FAILED);
        session.setProvider("codex");
        session.beginTurn();
        SessionExecutionState.Snapshot replacement = session.getExecutionSnapshot();
        SDKResult exit = SDKResult.error("Clean exit after interruption");
        exit.processExited = true;
        backend.complete(exit);
        assertEquals(SessionExecutionState.Outcome.FAILED, old.state().snapshot().outcome());
        assertEquals(replacement, session.getExecutionSnapshot());
        assertTrue(session.isBusy());
    }
}
