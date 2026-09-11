package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Regression tests for #1809: the Codex CLI injects a
 * {@code <recommended_plugins>} context block as the first user message of a
 * session. It must never surface as a session title (or as rendered history):
 * the sanitizer strips the tag block and the title extraction continues with
 * the next real user message.
 */
public class UserMessageSanitizerTest {

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
}
