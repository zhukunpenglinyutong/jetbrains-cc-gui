package com.github.claudecodegui.handler.diff;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Request parameters for showing an interactive diff view.
 */
public class InteractiveDiffRequest {
    private final String filePath;
    private final String originalContent;
    private final String newFileContents;
    private final String tabName;
    private final boolean isNewFile;
    private final boolean readOnly;
    private final String reviewId;

    /**
     * Creates a new InteractiveDiffRequest.
     *
     * @param filePath        The path to the file being diffed
     * @param originalContent The original content before modifications (null or empty for new files)
     * @param newFileContents The proposed new content for the file (after modifications)
     * @param tabName         The name to display in the diff tab
     * @param isNewFile       Whether this is a new file
     * @param readOnly        Whether the diff view should be read-only
     */
    public InteractiveDiffRequest(
            @NotNull String filePath,
            @Nullable String originalContent,
            @NotNull String newFileContents,
            @NotNull String tabName,
            boolean isNewFile,
            boolean readOnly,
            @Nullable String reviewId
    ) {
        this.filePath = filePath;
        this.originalContent = originalContent;
        this.newFileContents = newFileContents;
        this.tabName = tabName;
        this.isNewFile = isNewFile;
        this.readOnly = readOnly;
        this.reviewId = reviewId;
    }

    /**
     * Creates a request for a modified file with explicit original and new content.
     *
     * @param filePath        The path to the file
     * @param originalContent The content before modifications
     * @param newFileContents The content after modifications
     * @param tabName         The tab name
     */
    public static InteractiveDiffRequest forModifiedFile(
            @NotNull String filePath,
            @NotNull String originalContent,
            @NotNull String newFileContents,
            @NotNull String tabName
    ) {
        return new InteractiveDiffRequest(filePath, originalContent, newFileContents, tabName, false, false, null);
    }

    /**
     * Creates a request for a new file (no original content).
     *
     * @param filePath        The path to the new file
     * @param newFileContents The content of the new file
     * @param tabName         The tab name
     */
    public static InteractiveDiffRequest forNewFile(
            @NotNull String filePath,
            @NotNull String newFileContents,
            @NotNull String tabName
    ) {
        return new InteractiveDiffRequest(filePath, "", newFileContents, tabName, true, false, null);
    }

    @NotNull
    public String getFilePath() {
        return filePath;
    }

    /**
     * Returns the original content before modifications.
     * For new files, this returns an empty string.
     */
    @NotNull
    public String getOriginalContent() {
        return originalContent != null ? originalContent : "";
    }

    /**
     * Returns the new content after modifications.
     */
    @NotNull
    public String getNewFileContents() {
        return newFileContents;
    }

    @NotNull
    public String getTabName() {
        return tabName;
    }

    /**
     * Returns true if this is a new file (no original content).
     */
    public boolean isNewFile() {
        return isNewFile;
    }

    /**
     * Returns true if the diff view should be read-only (no user edits allowed).
     * When read-only, the user can only accept or reject the proposed changes.
     */
    public boolean isReadOnly() {
        return readOnly;
    }

    @Nullable
    public String getReviewId() {
        return reviewId;
    }

    /**
     * Creates a request for a modified file with read-only mode.
     */
    public static InteractiveDiffRequest forReadOnlyModifiedFile(
            @NotNull String filePath,
            @NotNull String originalContent,
            @NotNull String newFileContents,
            @NotNull String tabName
    ) {
        return new InteractiveDiffRequest(filePath, originalContent, newFileContents, tabName, false, true, null);
    }

    /**
     * Creates a request for a new file with read-only mode.
     */
    public static InteractiveDiffRequest forReadOnlyNewFile(
            @NotNull String filePath,
            @NotNull String newFileContents,
            @NotNull String tabName
    ) {
        return new InteractiveDiffRequest(filePath, "", newFileContents, tabName, true, true, null);
    }

    @NotNull
    public InteractiveDiffRequest withReviewId(@NotNull String newReviewId) {
        return new InteractiveDiffRequest(
                filePath,
                originalContent,
                newFileContents,
                tabName,
                isNewFile,
                readOnly,
                newReviewId
        );
    }

    @Override
    public String toString() {
        return "InteractiveDiffRequest{" +
                "filePath='" + filePath + '\'' +
                ", tabName='" + tabName + '\'' +
                ", isNewFile=" + isNewFile +
                ", originalContentLength=" + getOriginalContent().length() +
                ", newContentLength=" + newFileContents.length() +
                ", readOnly=" + readOnly +
                ", reviewId='" + reviewId + '\'' +
                '}';
    }
}
