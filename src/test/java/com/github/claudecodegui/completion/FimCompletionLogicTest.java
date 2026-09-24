package com.github.claudecodegui.completion;

import org.junit.Test;

import static org.junit.Assert.*;

public class FimCompletionLogicTest {

    @Test
    public void extractsPrefixSuffixAroundCaret() {
        // document text "abc<caret>def"
        String doc = "abcdef";
        FimCompletionLogic.Context ctx =
                FimCompletionLogic.extractContext(doc, 3, 100, 100);
        assertEquals("abc", ctx.prefix);
        assertEquals("def", ctx.suffix);
    }

    @Test
    public void clampsPrefixToMaxChars() {
        String doc = "0123456789xyz";
        FimCompletionLogic.Context ctx =
                FimCompletionLogic.extractContext(doc, 10, 5, 100);
        assertEquals("56789", ctx.prefix);
    }

    @Test
    public void clampsSuffixToMaxChars() {
        String doc = "abc0123456789";
        FimCompletionLogic.Context ctx =
                FimCompletionLogic.extractContext(doc, 3, 100, 5);
        assertEquals("01234", ctx.suffix);
    }

    @Test
    public void emptyContextWhenCaretAtZero() {
        FimCompletionLogic.Context ctx =
                FimCompletionLogic.extractContext("hello", 0, 100, 100);
        assertEquals("", ctx.prefix);
        assertEquals("hello", ctx.suffix);
    }

    @Test
    public void clampsCaretBeyondDocumentLength() {
        FimCompletionLogic.Context ctx =
                FimCompletionLogic.extractContext("abc", 99, 100, 100);
        assertEquals("abc", ctx.prefix);
        assertEquals("", ctx.suffix);
    }

    @Test
    public void insertOffsetEqualsCaretOffset() {
        // FIM middle fragment inserts exactly at the caret (between prefix and suffix).
        assertEquals(3, FimCompletionLogic.computeInsertOffset(3));
        assertEquals(0, FimCompletionLogic.computeInsertOffset(0));
    }

    @Test
    public void shouldSuggestRejectsBlankBeforeCaret() {
        assertFalse(FimCompletionLogic.shouldSuggest("   ", 3));
        assertFalse(FimCompletionLogic.shouldSuggest("abc", 0));
        assertFalse(FimCompletionLogic.shouldSuggest(null, 0));
        assertTrue(FimCompletionLogic.shouldSuggest("abc", 3));
    }

    @Test
    public void identifierBeforeCaretDetection() {
        assertTrue(FimCompletionLogic.isIdentifierCharBeforeCaret("foo bar", 3));
        assertFalse(FimCompletionLogic.isIdentifierCharBeforeCaret("foo ", 4));
        assertFalse(FimCompletionLogic.isIdentifierCharBeforeCaret("", 0));
        assertFalse(FimCompletionLogic.isIdentifierCharBeforeCaret("abc", 0));
    }
}
