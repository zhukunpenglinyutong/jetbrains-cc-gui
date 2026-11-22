package com.github.claudecodegui.session;

import org.junit.Test;

import java.util.concurrent.CompletableFuture;

import static org.junit.Assert.*;

public class SessionInteractionScopeTest {
    @Test
    public void exactFileScopeCapturesTheOriginalOwnerBeforeSessionReplacement() {
        SessionState session = running();
        SessionExecutionOwnership owner = session.currentExecutionOwnership();
        CompletableFuture<String> question = new CompletableFuture<>();
        SessionInteractionScope.forFileRequest(token(owner), owner, () -> {
            session.setProvider("codex");
            session.beginTurn();
            SessionInteractionScope.resolve(session.currentExecutionOwnership())
                    .bindInteraction(SessionExecutionState.WaitReason.QUESTION, question);
            return question;
        });
        assertEquals(SessionExecutionState.Phase.WAITING_USER, owner.state().snapshot().phase());
        assertEquals(SessionExecutionState.Phase.RUNNING, session.getExecutionSnapshot().phase());
        question.complete("Local answer");
        assertEquals(SessionExecutionState.Outcome.NONE, session.getExecutionSnapshot().outcome());
    }

    @Test
    public void lateOldTurnCorrelationCannotCreateWaitForANewTurn() {
        SessionState session = running();
        SessionExecutionOwnership old = session.currentExecutionOwnership();
        session.beginTurn();
        SessionExecutionState.Snapshot snapshot = session.getExecutionSnapshot();
        SessionInteractionScope.forFileRequest(token(old), session.currentExecutionOwnership(), () -> {
            assertNull(SessionInteractionScope.resolve(session.currentExecutionOwnership()));
            return new CompletableFuture<>();
        });
        assertEquals(snapshot, session.getExecutionSnapshot());
    }

    @Test
    public void missingBridgeCorrelationIsUnknownAndDoesNotInventAWaitingFuture() {
        SessionState session = running();
        SessionInteractionScope.forFileRequest("", session.currentExecutionOwnership(), () -> {
            assertNull(SessionInteractionScope.resolve(session.currentExecutionOwnership()));
            return new CompletableFuture<>();
        });
        assertEquals(SessionExecutionState.Phase.UNKNOWN, session.getExecutionSnapshot().phase());
        assertEquals(0, session.getExecutionSnapshot().pendingInteractionCount());
    }

    @Test
    public void nestedAndThrowingScopesRestoreThePreviousThreadContext() {
        SessionState session = running();
        SessionExecutionOwnership owner = session.currentExecutionOwnership();
        SessionInteractionScope.forFileRequest(token(owner), owner, () -> {
            try {
                SessionInteractionScope.forFileRequest("stale", owner, () -> {
                    throw new IllegalArgumentException("Dialog failed");
                });
                fail("Expected the original dialog exception");
            } catch (IllegalArgumentException expected) {
                assertSame(owner, SessionInteractionScope.resolve(null));
            }
            return null;
        });
        assertNull(SessionInteractionScope.resolve(null));
        assertSame(owner, SessionInteractionScope.resolve(owner));
    }

    private static SessionState running() {
        SessionState state = new SessionState();
        state.beginTurn();
        return state;
    }

    private static String token(SessionExecutionOwnership owner) {
        return owner.turn().bindingEpoch() + "/" + owner.turn().turnId();
    }
}
