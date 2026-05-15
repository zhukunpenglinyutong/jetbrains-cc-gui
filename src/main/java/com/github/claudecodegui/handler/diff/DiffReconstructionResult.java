package com.github.claudecodegui.handler.diff;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Result of diff content reconstruction.
 * Contains the before/after content, whether full-file reconstruction succeeded,
 * and the raw disk content that was read during reconstruction (for snapshot protection).
 */
public class DiffReconstructionResult {

    private final String beforeContent;
    private final String afterContent;
    private final boolean fullFile;
    private final String diskContent;

    private DiffReconstructionResult(
            @NotNull String beforeContent,
            @NotNull String afterContent,
            boolean fullFile,
            @Nullable String diskContent
    ) {
        this.beforeContent = beforeContent;
        this.afterContent = afterContent;
        this.fullFile = fullFile;
        this.diskContent = diskContent;
    }

    /**
     * Create a result with full-file content (reconstruction succeeded).
     */
    public static DiffReconstructionResult fullFile(
            @NotNull String beforeContent,
            @NotNull String afterContent,
            @Nullable String diskContent
    ) {
        return new DiffReconstructionResult(beforeContent, afterContent, true, diskContent);
    }

    /**
     * Create a result with fragment content (reconstruction failed, fallback).
     */
    public static DiffReconstructionResult fragment(@NotNull String beforeContent, @NotNull String afterContent) {
        return new DiffReconstructionResult(beforeContent, afterContent, false, null);
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

    /**
     * Returns the raw disk content that was read during reconstruction.
     * This is the exact bytes used to build the diff — use it as the concurrent
     * modification snapshot baseline. Returns null if file was not read from disk.
     */
    @Nullable
    public String getDiskContent() {
        return diskContent;
    }
}
