package com.github.claudecodegui.service.commit;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

/**
 * Unit tests for the (slimmed) commit-message extraction logic.
 */
public class CommitMessageCleanupTest {

    @Test
    public void extractsFromCommitTags() {
        String raw = "Here you go:\n<commit>\nfeat(api): add login\n\nbody line\n</commit>\n";
        assertEquals("feat(api): add login\n\nbody line", CommitMessageCleanup.clean(raw));
    }

    @Test
    public void keepsOnlyFirstCommitBlockWhenMultiple() {
        String raw = "<commit>feat: first</commit> extra <commit>feat: second</commit>";
        assertEquals("feat: first", CommitMessageCleanup.clean(raw));
    }

    @Test
    public void fallsBackToCodeFenceWithoutTags() {
        String raw = "Sure:\n```\nfix(ui): align button\n```\n";
        assertEquals("fix(ui): align button", CommitMessageCleanup.clean(raw));
    }

    @Test
    public void fallsBackToTrimmedRawWhenNothingElse() {
        String raw = "  refactor: trim me  \n";
        assertEquals("refactor: trim me", CommitMessageCleanup.clean(raw));
    }

    @Test
    public void convertsLiteralNewlines() {
        String raw = "<commit>feat: a\\n\\nbody</commit>";
        assertEquals("feat: a\n\nbody", CommitMessageCleanup.clean(raw));
    }

    @Test
    public void collapsesExcessiveBlankLines() {
        String raw = "<commit>feat: a\n\n\n\n\nbody</commit>";
        assertEquals("feat: a\n\nbody", CommitMessageCleanup.clean(raw));
    }

    @Test
    public void emptyInputReturnsEmpty() {
        assertEquals("", CommitMessageCleanup.clean(null));
        assertEquals("", CommitMessageCleanup.clean(""));
        assertEquals("", CommitMessageCleanup.clean("   "));
    }

    @Test
    public void truncatedCommitTagFallsBackToRaw() {
        // No closing tag — should not extract a partial tag block.
        String raw = "<commit>feat: incomplete";
        assertEquals("<commit>feat: incomplete", CommitMessageCleanup.clean(raw));
    }
}
