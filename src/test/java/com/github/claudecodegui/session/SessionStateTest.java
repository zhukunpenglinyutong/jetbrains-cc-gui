package com.github.claudecodegui.session;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SessionStateTest {

    @Test
    public void isValidSessionIdAcceptsExpectedClaudeSessionCharacters() {
        assertTrue(SessionState.isValidSessionId("550e8400-e29b-41d4-a716-446655440000"));
        assertTrue(SessionState.isValidSessionId("session_123-abc.def"));
    }

    @Test
    public void isValidSessionIdRejectsTooLongValues() {
        assertTrue(SessionState.isValidSessionId("a".repeat(128)));
        assertFalse(SessionState.isValidSessionId("a".repeat(129)));
    }

    @Test
    public void isValidSessionIdRejectsNonAllowlistedCharacters() {
        assertFalse(SessionState.isValidSessionId("session id"));
        assertFalse(SessionState.isValidSessionId("session:123"));
        assertFalse(SessionState.isValidSessionId("session$123"));
        assertFalse(SessionState.isValidSessionId("session@123"));
        assertFalse(SessionState.isValidSessionId("会话-123"));
        assertFalse(SessionState.isValidSessionId("../session"));
        assertFalse(SessionState.isValidSessionId("folder\\session"));
        assertFalse(SessionState.isValidSessionId("session\n123"));
        assertFalse(SessionState.isValidSessionId(" session"));
        assertFalse(SessionState.isValidSessionId("session "));
    }
}
