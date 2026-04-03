package com.github.claudecodegui.handler.diff;

import org.jetbrains.annotations.NotNull;

/**
 * Result of diff content reconstruction.
 * Contains the before/after content and whether full-file reconstruction succeeded.
 */
public class DiffReconstructionResult {

    private final String beforeContent;
    private final String afterContent;
    private final boolean fullFile;

    private DiffReconstructionResult(@NotNull String beforeContent, @NotNull String afterContent, boolean fullFile) {
        this.beforeContent = beforeContent;
        this.afterContent = afterContent;
        this.fullFile = fullFile;
    }

    /**
     * Create a result with full-file content (reconstruction succeeded).
     */
    public static DiffReconstructionResult fullFile(@NotNull String beforeContent, @NotNull String afterContent) {
        return new DiffReconstructionResult(beforeContent, afterContent, true);
    }

    /**
     * Create a result with fragment content (reconstruction failed, fallback).
     */
    public static DiffReconstructionResult fragment(@NotNull String beforeContent, @NotNull String afterContent) {
        return new DiffReconstructionResult(beforeContent, afterContent, false);
    }

    @NotNull
    public String getBeforeContent() {
        return beforeContent;
    }

    @NotNull
    public String getAfterContent() {
        return afterContent;
    }

    /**
     * Returns true if this result contains full-file content.
     * Returns false if only fragments are available (fallback).
     */
    public boolean isFullFile() {
        return fullFile;
    }
}
