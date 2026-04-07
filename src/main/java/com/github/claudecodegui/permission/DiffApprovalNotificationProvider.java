package com.github.claudecodegui.permission;

import com.github.claudecodegui.approval.PendingFileChangeApprovalService;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.ui.EditorNotificationPanel;
import com.intellij.ui.EditorNotificationProvider;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.JComponent;
import java.util.function.Function;

/**
 * Shows a native editor banner when a file has pending AI diff approvals.
 *
 * Cursor-style layout:
 * File with pending hunks:
 *   [∧] [1 of 2] [∨]  [<] [1 of 3 Files] [>]  [Undo File]  [Keep File]
 *
 * Other files pending (current file has no hunks):
 *   [<] [1 of 3 Files] [>]
 */
public final class DiffApprovalNotificationProvider implements EditorNotificationProvider, DumbAware {

    private static final Logger LOG = Logger.getInstance(DiffApprovalNotificationProvider.class);

    @Override
    public @Nullable Function<? super FileEditor, ? extends JComponent> collectNotificationData(
            @NotNull Project project,
            @NotNull VirtualFile file
    ) {
        long t0 = System.nanoTime();
        PendingFileChangeApprovalService pendingService = PendingFileChangeApprovalService.getInstance(project);
        PendingFileChangeApprovalService.PendingFileChange pendingFileChange =
                pendingService.getPendingForFile(file.getPath());

        if (pendingFileChange != null) {
            String filePath = pendingFileChange.getFilePath();
            int fileIndex = pendingService.getFileIndex(filePath);
            int totalFiles = pendingService.getPendingCount();
            int hunkCount = pendingFileChange.getPendingHunkCount();
            boolean isConflicted = pendingFileChange.isConflicted();

            return fileEditor -> {
                EditorNotificationPanel panel = new EditorNotificationPanel();

                if (isConflicted) {
                    // Conflict banner — simpler layout
                    panel.text(ClaudeCodeGuiBundle.message(
                            "diff.pendingReview.conflictBanner", pendingFileChange.getFileName()));
                    panel.createActionLabel(
                            ClaudeCodeGuiBundle.message("diff.pendingReview.openDiffAction"),
                            () -> pendingService.openFullDiff(filePath)
                    );
                } else {
                    // Cursor-style: [∧] [1 of 2] [∨]  [<] [1 of 3 Files] [>]  [Undo File]  [Keep File]
                    // Hunk-level navigation: ∧ / ∨ (only if multiple hunks)
                    if (hunkCount > 1) {
                        panel.createActionLabel(
                                ClaudeCodeGuiBundle.message("diff.inline.prevHunk"),
                                () -> pendingService.activatePrevHunk(filePath, pendingService.findCurrentHunkId(filePath))
                        );
                        panel.createActionLabel(
                                ClaudeCodeGuiBundle.message("diff.inline.hunkPosition", 1, hunkCount),
                                () -> {}
                        );
                        panel.createActionLabel(
                                ClaudeCodeGuiBundle.message("diff.inline.nextHunk"),
                                () -> pendingService.activateNextHunk(filePath, pendingService.findCurrentHunkId(filePath))
                        );
                    }

                    // File-level navigation: < / >  (only if multiple files)
                    if (totalFiles > 1) {
                        panel.createActionLabel(
                                ClaudeCodeGuiBundle.message("diff.inline.prevFile"),
                                () -> pendingService.activatePrevPendingFile(filePath)
                        );
                        panel.createActionLabel(
                                ClaudeCodeGuiBundle.message("diff.inline.filePosition", fileIndex, totalFiles),
                                () -> {}
                        );
                        panel.createActionLabel(
                                ClaudeCodeGuiBundle.message("diff.inline.nextFileArrow"),
                                () -> pendingService.activateNextPendingFile(filePath)
                        );
                    }

                    // File-level actions: Undo File / Keep File
                    panel.createActionLabel(
                            ClaudeCodeGuiBundle.message("diff.inline.undoFile"),
                            () -> pendingService.rejectFileChange(filePath)
                    );
                    panel.createActionLabel(
                            ClaudeCodeGuiBundle.message("diff.inline.keepFile"),
                            () -> pendingService.approveFileChange(filePath)
                    );
                }
                return panel;
            };
        }

        // This file has no pending changes itself, but other files might.
        // Show a light navigation banner so the user can find remaining work.
        int otherPendingCount = pendingService.getPendingCount();
        if (otherPendingCount > 0) {
            int currentFileIndex = pendingService.getFileIndex(file.getPath());

            return fileEditor -> {
                EditorNotificationPanel panel = new EditorNotificationPanel();

                // [<] [X of Y Files] [>]  [Review Next File]
                if (otherPendingCount > 1) {
                    panel.createActionLabel(
                            ClaudeCodeGuiBundle.message("diff.inline.prevFile"),
                            () -> pendingService.activatePrevPendingFile(file.getPath())
                    );
                }
                panel.createActionLabel(
                        ClaudeCodeGuiBundle.message("diff.inline.filePosition", currentFileIndex, otherPendingCount),
                        () -> {}
                );
                if (otherPendingCount > 1) {
                    panel.createActionLabel(
                            ClaudeCodeGuiBundle.message("diff.inline.nextFileArrow"),
                            () -> pendingService.activateNextPendingFile(file.getPath())
                    );
                }
                panel.createActionLabel(
                        ClaudeCodeGuiBundle.message("diff.inline.reviewNextFile"),
                        () -> pendingService.activateNextPendingFile(file.getPath())
                );
                return panel;
            };
        }

        // Legacy queue-based review (pre-permission path)
        DiffApprovalQueueService queueService = DiffApprovalQueueService.getInstance(project);
        DiffApprovalQueueService.PendingReview review = queueService.getPendingReviewForFile(file.getPath());
        if (review == null) {
            long elapsed = (System.nanoTime() - t0) / 1_000_000;
            if (elapsed > 10) {
                LOG.info("[EDT-DIAG] collectNotificationData for " + file.getName() + " took " + elapsed + "ms (no panel)");
            }
            return null;
        }

        return fileEditor -> {
            EditorNotificationPanel panel = new EditorNotificationPanel();
            panel.text(ClaudeCodeGuiBundle.message("diff.pendingReview.banner", review.getFileName()));
            panel.createActionLabel(
                    ClaudeCodeGuiBundle.message("diff.pendingReview.reviewAction"),
                    () -> queueService.activateReview(review.getReviewId())
            );
            panel.createActionLabel(
                    ClaudeCodeGuiBundle.message("diff.pendingReview.approveAction"),
                    () -> queueService.approveReview(review.getReviewId())
            );
            panel.createActionLabel(
                    ClaudeCodeGuiBundle.message("diff.pendingReview.rejectAction"),
                    () -> queueService.rejectReview(review.getReviewId())
            );
            panel.createActionLabel(
                    ClaudeCodeGuiBundle.message(
                            "diff.pendingReview.remainingAction",
                            queueService.getRemainingCount(review.getReviewId())
                    ),
                    () -> queueService.activateNextPendingReview(review.getReviewId())
            );
            return panel;
        };
    }
}
