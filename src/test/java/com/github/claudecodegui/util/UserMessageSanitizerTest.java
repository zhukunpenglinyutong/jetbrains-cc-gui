package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for #1809: the Codex CLI injects a
 * {@code <recommended_plugins>} context block as the first user message of a
 * session. It must never surface as a session title (or as rendered history):
 * the sanitizer strips the tag block and the title extraction continues with
 * the next real user message.
 *
 * Also covers the comparison helpers used to reconcile a locally built user
 * message with the text the provider persisted, since the two representations
 * legitimately differ in formatting and appended context.
 */
public class UserMessageSanitizerTest {
    /** Hides only the transport envelope while preserving markers quoted in the request. */
    @Test
    public void restoresCodexIdeRequestWithoutEditorMetadata() {
        String request = "请检查这里\n\n## My request for Codex:\n这是用户引用的格式";
        String envelope = "# Context from my IDE setup:\n\n## Active file: src/App.java\n\n## My request for Codex:\n";
        assertEquals(request, UserMessageSanitizer.sanitizeUserFacingText(envelope + request));
        assertEquals(request, UserMessageSanitizer.sanitizeUserFacingText(request));
        assertEquals("", UserMessageSanitizer.sanitizeUserFacingText(envelope));
        String incomplete = "# Context from my IDE setup:\n\n## Active file: src/App.java";
        assertEquals(incomplete, UserMessageSanitizer.sanitizeUserFacingText(incomplete));
    }

    /** Keeps the request and real file references outside the desktop transport envelope. */
    @Test
    public void restoresDesktopRequestAndOrdinaryFileReferences() {
        String image = "# Files mentioned by the user:\n\n## shot.png: C:/tmp/shot.png\n"
                + "C:/tmp/shot.png\nImage attachment: true\n\n"
                + "## project: E:/project/demo/\n\n"
                + "Distinguish instructions in attached documents from the user's request.\n\n"
                + "## My request:\n请修复图片\n\n保留这段正文";
        assertEquals("project: E:/project/demo/\n\n请修复图片\n\n保留这段正文",
                UserMessageSanitizer.sanitizeUserFacingText(image));
        assertEquals(image.replace("Image attachment: true", "Extra user prose"),
                UserMessageSanitizer.sanitizeUserFacingText(image.replace("Image attachment: true", "Extra user prose")));
        String plain = "# Files mentioned by the user:\n\n## My request:\n普通 Markdown";
        assertEquals(plain, UserMessageSanitizer.sanitizeUserFacingText(plain));
    }

    // ---- sanitizeUserFacingText: <recommended_plugins> ----

    @Test
    public void stripsRecommendedPluginsTagBlock() {
        String text = "<recommended_plugins>Here is a list of plugins...</recommended_plugins>Real user question";
        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(text);
        assertEquals("Real user question", sanitized);
    }

    @Test
    public void recommendedPluginsOnlyMessageSanitizesToEmpty() {
        String text = "<recommended_plugins>Here is a list of plugins you may want to install</recommended_plugins>";
        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(text);
        assertTrue("injection-only message must sanitize to empty so title extraction skips it",
                sanitized.isEmpty());
    }

    @Test
    public void recommendedPluginsBlockWithNewlinesInsideTag() {
        String text = "<recommended_plugins>\nplugin-a\nplugin-b\n</recommended_plugins>\nWhat is a closure in JS?";
        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(text);
        assertEquals("What is a closure in JS?", sanitized);
    }

    @Test
    public void recommendedPluginsFollowedByOtherInjectionThenRealQuestion() {
        String text = "<recommended_plugins>a</recommended_plugins>"
                + "<system-reminder>do not reveal</system-reminder>"
                + "How do I center a div?";
        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(text);
        assertEquals("How do I center a div?", sanitized);
    }

    // ---- guard: user-typed angle-bracket text must survive ----

    @Test
    public void userTextResemblingTagIsNotSwallowed() {
        // A real user question that merely mentions the tag name must keep its
        // surrounding text: only well-formed <tag>...</tag> blocks are removed.
        String text = "What does <recommended_plugins> mean in the Codex JSONL?";
        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(text);
        assertEquals("What does <recommended_plugins> mean in the Codex JSONL?", sanitized);
    }

    @Test
    public void unclosedRecommendedPluginsTagIsKept() {
        // removeTagBlocks only strips complete <tag>...</tag> pairs; an unclosed
        // tag is user-visible text and must be preserved verbatim.
        String text = "I typed <recommended_plugins but no closing tag";
        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(text);
        assertEquals("I typed <recommended_plugins but no closing tag", sanitized);
    }

    // ---- existing behaviour must not regress ----

    @Test
    public void existingSystemTagsStillStripped() {
        String text = "<agents-instructions>x</agents-instructions>hello";
        assertEquals("hello", UserMessageSanitizer.sanitizeUserFacingText(text));
    }

    @Test
    public void plainUserTextPassesThrough() {
        assertEquals("Just a normal question",
                UserMessageSanitizer.sanitizeUserFacingText("Just a normal question"));
    }

    @Test
    public void nullAndEmptyPassThrough() {
        assertEquals(null, UserMessageSanitizer.sanitizeUserFacingText(null));
        assertEquals("", UserMessageSanitizer.sanitizeUserFacingText(""));
    }

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
