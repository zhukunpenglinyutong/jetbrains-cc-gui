package com.github.claudecodegui.permission;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Result of a diff review operation initiated by the permission system.
 * Wraps the user's decision (accept/reject) and the final file content.
 */
public class DiffReviewResult {

    private final boolean accepted;
    private final boolean alwaysAllow;
    private final String finalContent;
    private final String filePath;

    private DiffReviewResult(boolean accepted, boolean alwaysAllow, @Nullable String finalContent, @NotNull String filePath) {
        this.accepted = accepted;
        this.alwaysAllow = alwaysAllow;
        this.finalContent = finalContent;
        this.filePath = filePath;
    }

    /**
     * Creates an accepted result with the (possibly user-edited) content.
     */
    public static DiffReviewResult accepted(@NotNull String finalContent, @NotNull String filePath) {
        return new DiffReviewResult(true, false, finalContent, filePath);
    }

    /**
     * Creates an accepted result with "always allow" semantics.
     */
    public static DiffReviewResult acceptedAlways(@NotNull String finalContent, @NotNull String filePath) {
        return new DiffReviewResult(true, true, finalContent, filePath);
    }

    /**
     * Creates a rejected result (user clicked Reject or closed the diff view).
     */
    public static DiffReviewResult rejected(@NotNull String filePath) {
        return new DiffReviewResult(false, false, null, filePath);
    }

    public boolean isAccepted() {
        return accepted;
    }

    public boolean isAlwaysAllow() {
        return alwaysAllow;
    }

    @Nullable
    public String getFinalContent() {
        return finalContent;
    }

    @NotNull
    public String getFilePath() {
        return filePath;
    }

    @Override
    public String toString() {
        return "DiffReviewResult{" +
                "accepted=" + accepted +
                ", alwaysAllow=" + alwaysAllow +
                ", filePath='" + filePath + '\'' +
                ", hasContent=" + (finalContent != null) +
                '}';
    }
}
