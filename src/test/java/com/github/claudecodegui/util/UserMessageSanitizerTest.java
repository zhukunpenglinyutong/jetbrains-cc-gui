package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.*;

/**
 * Tests for {@link UserMessageSanitizer}.
 *
 * Focuses on the comparison helpers used to reconcile a locally built user message
 * with the text the provider persisted, since the two representations legitimately
 * differ in formatting and appended context.
 */
public class UserMessageSanitizerTest {

    // ── normalizeForComparison ───────────────────────────────────────────

    @Test
    public void normalizeForComparisonNullReturnsEmpty() {
        assertEquals("", UserMessageSanitizer.normalizeForComparison(null));
    }

    @Test
    public void normalizeForComparisonTrimsAndCollapsesBlankLines() {
        assertEquals("hello",
            UserMessageSanitizer.normalizeForComparison("\r\n\r\nhello\r\n\r\n\r\n"));
    }

    @Test
    public void normalizeForComparisonRemovesAppendedContext() {
        String text = "hello\n\n## IDE Context\n\nThe user is viewing this file in their IDE.";
        assertEquals("hello", UserMessageSanitizer.normalizeForComparison(text));
    }

    @Test
    public void normalizeForComparisonRemovesSystemTags() {
        assertEquals("hello",
            UserMessageSanitizer.normalizeForComparison("<system-reminder>note</system-reminder>hello"));
    }

    @Test
    public void normalizeForComparisonRemovesImageAttachmentHint() {
        String text = "look at this\n\n"
            + "The user has attached the image(s) above. Please use the Read tool to view them.";
        assertEquals("look at this", UserMessageSanitizer.normalizeForComparison(text));
    }

    // ── matchesUserText ──────────────────────────────────────────────────

    @Test
    public void matchesUserTextExactEquality() {
        assertTrue(UserMessageSanitizer.matchesUserText("hello", "hello"));
    }

    @Test
    public void matchesUserTextAcrossLineSeparators() {
        assertTrue(UserMessageSanitizer.matchesUserText("one\ntwo", "one\r\ntwo"));
    }

    @Test
    public void matchesUserTextAcrossBlankLinePadding() {
        assertTrue(UserMessageSanitizer.matchesUserText("hello", "\n\nhello\n\n\n"));
    }

    @Test
    public void matchesUserTextAcrossAppendedContext() {
        assertTrue(UserMessageSanitizer.matchesUserText(
            "explain this method",
            "explain this method\n\n## Agent Role and Instructions\n\nYou are a reviewer."));
    }

    @Test
    public void matchesUserTextRejectsDifferentText() {
        assertFalse(UserMessageSanitizer.matchesUserText("hello", "world"));
    }

    @Test
    public void matchesUserTextRejectsNull() {
        assertFalse(UserMessageSanitizer.matchesUserText(null, "hello"));
        assertFalse(UserMessageSanitizer.matchesUserText("hello", null));
    }

    @Test
    public void matchesUserTextRejectsEmptyAfterNormalization() {
        // Both sides normalize to nothing — there is no shared text to match on.
        assertFalse(UserMessageSanitizer.matchesUserText("   ", "\n\n"));
    }
}
