package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class SessionStateTest {

    @Test
    public void invalidatingPendingSendOperationsMarksEarlierEpochsAsStale() {
        SessionState state = new SessionState();

        long initialEpoch = state.capturePendingSendInvalidationEpoch();
        assertTrue(state.isPendingSendOperationCurrent(initialEpoch));

        state.invalidatePendingSendOperations();

        assertFalse(state.isPendingSendOperationCurrent(initialEpoch));
        assertTrue(state.isPendingSendOperationCurrent(state.capturePendingSendInvalidationEpoch()));
    }

    @Test
    public void claudeInvocationModeStartsUnknownUntilExplicitlyInitialized() {
        SessionState state = new SessionState();

        assertNull(state.getClaudeInvocationMode());

        state.setClaudeInvocationMode("cli");

        assertEquals("cli", state.getClaudeInvocationMode());
    }

    @Test
    public void invalidClaudeInvocationModeDoesNotOverwriteExistingSessionMode() {
        SessionState state = new SessionState();
        state.setClaudeInvocationMode("cli");

        state.setClaudeInvocationMode("bad-mode");

        assertEquals("cli", state.getClaudeInvocationMode());
    }

    @Test
    public void providerRejectsUnknownValues() {
        SessionState state = new SessionState();
        state.setProvider("codex");

        state.setProvider("bad-provider");

        assertEquals("codex", state.getProvider());
    }

    @Test
    public void providerAcceptsKnownValues() {
        SessionState state = new SessionState();

        state.setProvider("codex");
        assertEquals("codex", state.getProvider());

        state.setProvider("claude");
        assertEquals("claude", state.getProvider());
    }
}
