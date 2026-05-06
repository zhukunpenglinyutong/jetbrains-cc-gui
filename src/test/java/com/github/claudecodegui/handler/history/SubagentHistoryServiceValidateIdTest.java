package com.github.claudecodegui.handler.history;

import org.junit.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Tests for the private {@code validateId(name, value)} guard used to keep
 * untrusted session/agent identifiers from escaping the subagent log directory.
 *
 * The method is invoked via reflection because it is a defensive helper that we
 * want to verify in isolation (no IntelliJ Project mocks needed).
 */
public class SubagentHistoryServiceValidateIdTest {

    private static void invokeValidateId(String name, String value) throws Throwable {
        Method method = SubagentHistoryService.class.getDeclaredMethod(
                "validateId", String.class, String.class);
        method.setAccessible(true);
        try {
            method.invoke(null, name, value);
        } catch (InvocationTargetException e) {
            // Surface the real exception so JUnit's expected matching still works.
            throw e.getCause();
        }
    }

    private static void assertAccepted(String value) {
        try {
            invokeValidateId("sessionId", value);
        } catch (Throwable t) {
            fail("Expected '" + value + "' to be accepted, but got: " + t);
        }
    }

    private static void assertRejected(String value) {
        try {
            invokeValidateId("sessionId", value);
            fail("Expected validateId to reject '" + value + "', but it was accepted");
        } catch (IllegalArgumentException expected) {
            assertTrue(
                    "Error message should mention the field name",
                    expected.getMessage() != null && expected.getMessage().contains("sessionId"));
        } catch (Throwable t) {
            fail("Expected IllegalArgumentException for '" + value + "', got: " + t);
        }
    }

    @Test
    public void acceptsAlphaNum() {
        assertAccepted("abc123");
    }

    @Test
    public void acceptsHyphenUnderscore() {
        assertAccepted("abc-123_def");
    }

    @Test
    public void acceptsUuidLikeIds() {
        assertAccepted("550e8400-e29b-41d4-a716-446655440000");
    }

    @Test
    public void rejectsPathTraversal() {
        assertRejected("../etc");
    }

    @Test
    public void rejectsParentDirectorySegment() {
        assertRejected("..");
    }

    @Test
    public void rejectsDot() {
        // Plain dots are not in [A-Za-z0-9_-].
        assertRejected("abc.def");
    }

    @Test
    public void rejectsForwardSlash() {
        assertRejected("abc/def");
    }

    @Test
    public void rejectsBackslash() {
        assertRejected("abc\\def");
    }

    @Test
    public void rejectsUrlEncodedTraversal() {
        // The implementation does NOT URL-decode; '%' is not in the safe charset
        // so the input is rejected by the regex.
        assertRejected("%2E%2E");
        assertRejected("%2e%2e%2fpasswd");
    }

    @Test
    public void rejectsEmpty() {
        assertRejected("");
    }

    @Test
    public void rejectsNull() {
        assertRejected(null);
    }

    @Test
    public void rejectsWhitespace() {
        assertRejected("abc def");
        assertRejected("\t");
        assertRejected("\n");
    }

    @Test
    public void rejectsNullByte() {
        assertRejected("abc\u0000def");
    }

    @Test
    public void errorMessageIncludesSuppliedFieldName() throws Throwable {
        Method method = SubagentHistoryService.class.getDeclaredMethod(
                "validateId", String.class, String.class);
        method.setAccessible(true);
        try {
            method.invoke(null, "agentId", "../bad");
            fail("Expected IllegalArgumentException");
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            assertTrue(cause instanceof IllegalArgumentException);
            assertEquals("Invalid agentId", cause.getMessage());
        }
    }
}
