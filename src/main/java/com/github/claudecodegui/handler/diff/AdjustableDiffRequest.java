package com.github.claudecodegui.handler.diff;

import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Request parameters for showing an adjustable diff view.
 * The user can use per-chunk arrows, edit the right side, and optionally Apply to write back.
 */
public class AdjustableDiffRequest {

    private final String filePath;
    private final String beforeContent;
    private final String afterContent;
    private final String tabName;
    private final boolean fullFile;
    private final String diskSnapshot;

    public AdjustableDiffRequest(
            @NotNull String filePath,
            @NotNull String beforeContent,
            @NotNull String afterContent,
            @NotNull String tabName,
            boolean fullFile,
            @Nullable String diskSnapshot
    ) {
        this.filePath = filePath;
        this.beforeContent = beforeContent;
        this.afterContent = afterContent;
        this.tabName = tabName;
        this.fullFile = fullFile;
        this.diskSnapshot = diskSnapshot;
    }

    @NotNull
    public String getFilePath() {
        return filePath;
    }

    @NotNull
    public String getBeforeContent() {
        return beforeContent;
    }

    @NotNull
    public String getAfterContent() {
        return afterContent;
    }

    @NotNull
    public String getTabName() {
        return tabName;
    }

    /**
     * Whether this diff represents full-file content.
     * When true, Apply button is shown (write back makes sense).
     * When false, only Cancel is shown (fragment write back is meaningless).
     */
    public boolean isFullFile() {
        return fullFile;
    }

    /**
     * The file content snapshot taken when the diff was opened.
     * Used for concurrent modification protection: before Apply,
     * the current disk content is compared against this snapshot.
     * If they differ, Apply is rejected.
     */
    @Nullable
    public String getDiskSnapshot() {
        return diskSnapshot;
    }
}
