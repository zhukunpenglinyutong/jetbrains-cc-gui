package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for the stale-session-ID fix (PR #1192).
 *
 * After session callbacks are re-bound (new session, history load), the ID
 * exposed via getSessionId() must never be the previous session's ID, and it
 * must never become null either: DetachTabAction skips DetachedWindowManager
 * registration on a null ID, and dispose-time PermissionService cleanup keys
 * off a stable identifier.
 */
public class ClaudeChatWindowExposedSessionIdTest {

    private static final String PERMISSION_KEY = "permission-key-uuid";

    @Test
    public void freshSessionFallsBackToPermissionServiceKey() {
        assertEquals(PERMISSION_KEY,
                ClaudeChatWindow.resolveExposedSessionId(null, PERMISSION_KEY));
        assertEquals(PERMISSION_KEY,
                ClaudeChatWindow.resolveExposedSessionId("", PERMISSION_KEY));
        assertEquals(PERMISSION_KEY,
                ClaudeChatWindow.resolveExposedSessionId("   ", PERMISSION_KEY));
    }

    @Test
    public void historyLoadedSessionExposesItsOwnId() {
        assertEquals("history-session-42",
                ClaudeChatWindow.resolveExposedSessionId("history-session-42", PERMISSION_KEY));
    }

    /** Keeps the failed input visible while releasing its expired resume target. */
    @Test
    public void expiredClaudeResumeClearsOnlyTheOwningIdentity() {
        SessionState state = this.resumedState("claude", "expired-epoch");
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.USER, "Retry this input", new JsonObject()));
        state.setError("No conversation found with session ID: expired-session");

        assertTrue(ClaudeChatWindow.retireExpiredClaudeResume(state, "expired-session", "expired-epoch"));

        assertNull(state.getSessionId());
        assertEquals(1, state.getMessages().size());
        assertEquals("Retry this input", state.getMessages().get(0).content);
        assertEquals("No conversation found with session ID: expired-session", state.getError());
        assertEquals(PERMISSION_KEY, ClaudeChatWindow.resolveExposedSessionId(state.getSessionId(), PERMISSION_KEY));
        assertFalse(ClaudeChatWindow.retireExpiredClaudeResume(state, "expired-session", "expired-epoch"));
    }

    /** Ignores a delayed failure after the same transcript has been reopened. */
    @Test
    public void expiredResumeCannotClearAnotherRuntimeEpoch() {
        SessionState state = this.resumedState("claude", "reopened-epoch");

        assertFalse(ClaudeChatWindow.retireExpiredClaudeResume(state, "expired-session", "expired-epoch"));
        assertEquals("expired-session", state.getSessionId());
    }

    /** Leaves a different provider or transcript selected in the window intact. */
    @Test
    public void expiredResumeCannotClearAnotherProviderOrSession() {
        SessionState otherProvider = this.resumedState("codex", "expired-epoch");
        SessionState otherSession = this.resumedState("claude", "expired-epoch");
        otherSession.setSessionId("another-session");

        assertFalse(ClaudeChatWindow.retireExpiredClaudeResume(otherProvider, "expired-session", "expired-epoch"));
        assertFalse(ClaudeChatWindow.retireExpiredClaudeResume(otherSession, "expired-session", "expired-epoch"));
        assertEquals("expired-session", otherProvider.getSessionId());
        assertEquals("another-session", otherSession.getSessionId());
    }

    /** Rejects events that cannot identify their owning runtime. */
    @Test
    public void expiredResumeRequiresBothSessionAndEpoch() {
        SessionState state = this.resumedState("claude", "expired-epoch");

        assertFalse(ClaudeChatWindow.retireExpiredClaudeResume(state, null, "expired-epoch"));
        assertFalse(ClaudeChatWindow.retireExpiredClaudeResume(state, "expired-session", null));
        assertEquals("expired-session", state.getSessionId());
    }

    private SessionState resumedState(String provider, String epoch) {
        SessionState state = new SessionState();
        state.setProvider(provider);
        state.setSessionId("expired-session");
        state.setRuntimeSessionEpoch(epoch);
        return state;
    }
}
