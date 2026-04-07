package com.github.claudecodegui.approval;

import org.jetbrains.annotations.NotNull;

import java.util.Objects;

/**
 * Line-based inline approval hunk between a baseline document and current document.
 */
public final class InlineDiffHunk {

    public enum Type {
        ADDED,
        DELETED,
        MODIFIED
    }

    private final String hunkId;
    private final Type type;
    private final int beforeStartLine;
    private final int beforeEndLineExclusive;
    private final int afterStartLine;
    private final int afterEndLineExclusive;
    private final String beforeText;
    private final String afterText;

    public InlineDiffHunk(
            @NotNull String hunkId,
            @NotNull Type type,
            int beforeStartLine,
            int beforeEndLineExclusive,
            int afterStartLine,
            int afterEndLineExclusive,
            @NotNull String beforeText,
            @NotNull String afterText
    ) {
        this.hunkId = hunkId;
        this.type = type;
        this.beforeStartLine = beforeStartLine;
        this.beforeEndLineExclusive = beforeEndLineExclusive;
        this.afterStartLine = afterStartLine;
        this.afterEndLineExclusive = afterEndLineExclusive;
        this.beforeText = beforeText;
        this.afterText = afterText;
    }

    @NotNull
    public String getHunkId() {
        return hunkId;
    }

    @NotNull
    public Type getType() {
        return type;
    }

    public int getBeforeStartLine() {
        return beforeStartLine;
    }

    public int getBeforeEndLineExclusive() {
        return beforeEndLineExclusive;
    }

    public int getAfterStartLine() {
        return afterStartLine;
    }

    public int getAfterEndLineExclusive() {
        return afterEndLineExclusive;
    }

    @NotNull
    public String getBeforeText() {
        return beforeText;
    }

    @NotNull
    public String getAfterText() {
        return afterText;
    }

    public int getAddedLineCount() {
        return Math.max(0, afterEndLineExclusive - afterStartLine);
    }

    public int getDeletedLineCount() {
        return Math.max(0, beforeEndLineExclusive - beforeStartLine);
    }

    public boolean hasAfterLines() {
        return getAddedLineCount() > 0;
    }

    public boolean hasBeforeLines() {
        return getDeletedLineCount() > 0;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof InlineDiffHunk that)) return false;
        return beforeStartLine == that.beforeStartLine
                && beforeEndLineExclusive == that.beforeEndLineExclusive
                && afterStartLine == that.afterStartLine
                && afterEndLineExclusive == that.afterEndLineExclusive
                && hunkId.equals(that.hunkId)
                && type == that.type
                && beforeText.equals(that.beforeText)
                && afterText.equals(that.afterText);
    }

    @Override
    public int hashCode() {
        return Objects.hash(
                hunkId,
                type,
                beforeStartLine,
                beforeEndLineExclusive,
                afterStartLine,
                afterEndLineExclusive,
                beforeText,
                afterText
        );
    }
}
