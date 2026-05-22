package com.github.claudecodegui.util;

import org.jetbrains.annotations.NotNull;

/**
 * Result of reverse-rebuilding pre-edit content.
 * Carries the rebuilt content and whether all reverse operations matched exactly
 * (no fuzzy whitespace matching, no skipped operations).
 */
public class ContentRebuildResult {

    private final String content;
    private final boolean exact;

    ContentRebuildResult(@NotNull String content, boolean exact) {
        this.content = content;
        this.exact = exact;
    }

    @NotNull
    public String getContent() {
        return content;
    }

    /**
     * Returns true if every reverse operation used exact string matching.
     * Returns false if any operation used fuzzy whitespace matching or was skipped.
     * When false, the rebuilt content is approximate and should not be used for Apply.
     */
    public boolean isExact() {
        return exact;
    }
}
