package com.github.claudecodegui.service;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class CommitMessageCleanerTest {

    private final CommitMessageCleaner cleaner = new CommitMessageCleaner();

    @Test
    public void shouldExtractConventionalCommitFromNoisyModelOutput() {
        String raw = """
                Analysis:
                The diff changes several files.

                fix(commit): filter sensitive diff files

                - Reuse the secure diff collector for prompt mode
                - Avoid leaking environment files

                Explanation:
                The message above follows the requested format.
                """;

        assertEquals("""
                fix(commit): filter sensitive diff files

                - Reuse the secure diff collector for prompt mode
                - Avoid leaking environment files""", cleaner.clean(raw));
    }

    @Test
    public void shouldRemoveThinkingAndGeneratedFooters() {
        String raw = """
                <thinking>inspect every changed file</thinking>
                <commit>fix(commit): handle cancellation\\n\\n- Use a shared cancellation marker</commit>
                Generated with Claude Code
                """;

        assertEquals("""
                fix(commit): handle cancellation

                - Use a shared cancellation marker""", cleaner.clean(raw));
    }
}
