package com.github.claudecodegui.markdown;

import org.junit.Test;
import static org.junit.Assert.*;

public class MarkdownReviewPromptTest {
    @Test
    public void recognizesMergedBatchWithoutInternalMetadata() {
        String message = "<ccgui-markdown-review>{\"batches\":[{\"annotations\":[{\"id\":\"000a\",\"path\":\"docs/a.md\",\"kind\":\"review\",\"selectedText\":\"source\",\"comment\":\"fix\",\"startLine\":1,\"endLine\":1}]}]}</ccgui-markdown-review>";
        assertTrue(MarkdownReviewPrompt.hasReview(message));
        assertEquals("Markdown review: docs/a.md", MarkdownReviewPrompt.displaySummary(message));
        assertFalse(MarkdownReviewPrompt.hasReview(message.replace("\"review\"", "\"quote\"")));
    }
    private static final String REVIEW = "<ccgui-markdown-review>{\"version\":1,\"batches\":[{\"kind\":\"review\",\"annotations\":[{}]}]}</ccgui-markdown-review>";

    @Test
    public void recognizesReviewsButNotQuotationsOrMalformedMessages() {
        assertTrue(MarkdownReviewPrompt.hasReview(REVIEW));
        assertFalse(MarkdownReviewPrompt.hasReview(REVIEW.replace("\"review\"", "\"quote\"")));
        assertFalse(MarkdownReviewPrompt.hasReview("ordinary text " + REVIEW));
        assertFalse(MarkdownReviewPrompt.hasReview("<ccgui-markdown-review>invalid</ccgui-markdown-review>"));
    }

    @Test
    public void keepsStableClaudeSystemContextAcrossTurnsAndCompactionAndClearsOnNewSession() {
        var context = new MarkdownReviewPrompt.SessionContext();
        assertEquals("role", context.apply("claude", "hello", "role", "session-1", false));
        String first = context.apply("claude", REVIEW, "role", "session-1", false);
        assertTrue(first.startsWith("role\n\n"));
        assertEquals(first, context.apply("claude", "continue", "role", "session-1", false));
        assertEquals(first, context.apply("claude", REVIEW, first, "session-1", false));
        assertEquals("role", context.apply("claude", "hello", "role", "session-2", false));
        assertEquals(first, context.apply("claude", "continue", "role", "restored", true));
    }

    @Test
    public void otherProvidersReceiveCompactContextOnlyOnReviewTurns() {
        var context = new MarkdownReviewPrompt.SessionContext();
        assertTrue(context.apply("codex", REVIEW, null, "session", false).contains("every unfinished or partial item"));
        assertNull(context.apply("codex", "hello", null, "session", true));
        assertTrue(MarkdownReviewPrompt.GUIDE.length() < 600);
    }

    @Test
    public void usesReadableSessionTitlesInsteadOfProtocolMetadata() {
        String withPath = REVIEW.replace("\"kind\":\"review\"", "\"kind\":\"review\",\"path\":\"docs/plan.md\"");
        assertEquals("Markdown review: docs/plan.md", MarkdownReviewPrompt.displaySummary(withPath));
        assertEquals("Please fix", MarkdownReviewPrompt.displaySummary(withPath + "\n\nPlease fix"));
        assertNull(MarkdownReviewPrompt.displaySummary("ordinary message"));
    }
}
