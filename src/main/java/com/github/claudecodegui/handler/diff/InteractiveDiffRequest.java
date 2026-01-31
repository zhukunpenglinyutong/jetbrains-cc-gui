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

    /**
     * Creates a new InteractiveDiffRequest.
     *
     * @param filePath        The path to the file being diffed
     * @param originalContent The original content before modifications (null or empty for new files)
     * @param newFileContents The proposed new content for the file (after modifications)
     * @param tabName         The name to display in the diff tab
     * @param isNewFile       Whether this is a new file
     */
    public InteractiveDiffRequest(
            @NotNull String filePath,
            @Nullable String originalContent,
            @NotNull String newFileContents,
            @NotNull String tabName,
            boolean isNewFile
    ) {
        this.filePath = filePath;
        this.originalContent = originalContent;
        this.newFileContents = newFileContents;
        this.tabName = tabName;
        this.isNewFile = isNewFile;
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
        return new InteractiveDiffRequest(filePath, originalContent, newFileContents, tabName, false);
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
        return new InteractiveDiffRequest(filePath, "", newFileContents, tabName, true);
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

    @Override
    public String toString() {
        return "InteractiveDiffRequest{" +
                "filePath='" + filePath + '\'' +
                ", tabName='" + tabName + '\'' +
                ", isNewFile=" + isNewFile +
                ", originalContentLength=" + getOriginalContent().length() +
                ", newContentLength=" + newFileContents.length() +
                '}';
    }
}
