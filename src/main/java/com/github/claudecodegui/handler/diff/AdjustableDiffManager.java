package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.util.LineSeparatorUtil;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffDialogHints;
import com.intellij.diff.DiffManagerEx;
import com.intellij.diff.chains.SimpleDiffRequestChain;
import com.intellij.diff.contents.DiffContent;
import com.intellij.diff.contents.DocumentContent;
import com.intellij.diff.editor.ChainDiffVirtualFile;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.diff.util.DiffUserDataKeys;
import com.intellij.diff.util.DiffUserDataKeysEx;
import com.intellij.diff.util.Side;
import com.intellij.icons.AllIcons;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.fileTypes.FileTypes;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.testFramework.LightVirtualFile;
import com.intellij.util.concurrency.annotations.RequiresEdt;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Manager for adjustable diff views: left read-only, right editable,
 * per-chunk chevron arrows, Apply writes back to file, Cancel closes.
 * <p>
 * Unlike {@link InteractiveDiffManager} (which is for permission review with
 * CompletableFuture-based workflow), this manager is fire-and-forget:
 * it shows the diff and handles Apply/Cancel internally.
 */
public class AdjustableDiffManager {

    private static final Logger LOG = Logger.getInstance(AdjustableDiffManager.class);

    /**
     * Show an adjustable diff view.
     *
     * @param project        the current project
     * @param request        diff request parameters
     * @param fileOperations file operations for writing back
     */
    @RequiresEdt
    public static void show(
            @NotNull Project project,
            @NotNull AdjustableDiffRequest request,
            @NotNull DiffFileOperations fileOperations
    ) {
        if (project.isDisposed()) return;

        String beforeContent = LineSeparatorUtil.normalizeToLF(request.getBeforeContent());
        String afterContent = LineSeparatorUtil.normalizeToLF(request.getAfterContent());

        String fileName = new File(request.getFilePath()).getName();
        FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);
        if (fileType == FileTypes.UNKNOWN) {
            fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);
        }

        // Create left (read-only) and right (editable) content
        DiffContentFactory contentFactory = DiffContentFactory.getInstance();

        LightVirtualFile leftFile = new LightVirtualFile(fileName, fileType, beforeContent);
        leftFile.setDetectedLineSeparator("\n");
        DiffContent leftContent = contentFactory.create(project, leftFile);

        LightVirtualFile rightFile = new LightVirtualFile(fileName, fileType, afterContent);
        rightFile.setDetectedLineSeparator("\n");
        DocumentContent rightDocContent = contentFactory.createDocument(project, rightFile);
        if (rightDocContent == null) {
            DiffContent fallback = contentFactory.create(project, rightFile);
            if (fallback instanceof DocumentContent) {
                rightDocContent = (DocumentContent) fallback;
            } else {
                LOG.error("Failed to create DocumentContent for adjustable diff");
                return;
            }
        }

        // Build diff request
        SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                request.getTabName(),
                leftContent,
                rightDocContent,
                ClaudeCodeGuiBundle.message("diff.editBefore", fileName),
                ClaudeCodeGuiBundle.message("diff.editAfter", fileName)
        );

        // Left always read-only; right editable only when full-file (Apply is available)
        boolean[] readOnly = request.isFullFile() ? new boolean[]{true, false} : new boolean[]{true, true};
        diffRequest.putUserData(DiffUserDataKeys.FORCE_READ_ONLY_CONTENTS, readOnly);
        diffRequest.putUserData(DiffUserDataKeys.PREFERRED_FOCUS_SIDE, Side.RIGHT);

        // Wrap in chain (needed for bottom panel and closeDiffView)
        SimpleDiffRequestChain chain = new SimpleDiffRequestChain(diffRequest);

        // State tracking
        AtomicBoolean actionTaken = new AtomicBoolean(false);
        final DocumentContent finalRightContent = rightDocContent;

        // Toolbar actions
        List<AnAction> actions = new ArrayList<>();

        // Close action (toolbar)
        actions.add(new AnAction(
                ClaudeCodeGuiBundle.message("diff.close"),
                ClaudeCodeGuiBundle.message("diff.close.description"),
                AllIcons.Actions.Cancel
        ) {
            @Override
            public void actionPerformed(@NotNull AnActionEvent e) {
                if (actionTaken.compareAndSet(false, true)) {
                    closeDiffView(project, chain);
                }
            }

            @Override
            public @NotNull ActionUpdateThread getActionUpdateThread() {
                return ActionUpdateThread.EDT;
            }
        });

        // Save action (toolbar) — only for full-file mode
        if (request.isFullFile()) {
            actions.add(new AnAction(
                    ClaudeCodeGuiBundle.message("diff.save"),
                    ClaudeCodeGuiBundle.message("diff.save.description"),
                    AllIcons.Actions.Checked
            ) {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e) {
                    if (actionTaken.compareAndSet(false, true)) {
                        if (!applyContent(project, request, finalRightContent, rightFile, fileOperations, chain)) {
                            actionTaken.set(false); // unlock so user can retry or cancel
                        }
                    }
                }

                @Override
                public @NotNull ActionUpdateThread getActionUpdateThread() {
                    return ActionUpdateThread.EDT;
                }
            });
        }

        diffRequest.putUserData(DiffUserDataKeysEx.CONTEXT_ACTIONS, actions);

        // Show the diff
        DiffManagerEx.getInstance().showDiffBuiltin(project, chain, DiffDialogHints.DEFAULT);
        LOG.info("Adjustable diff opened for: " + request.getFilePath()
                + (request.isFullFile() ? " (full file, Apply enabled)" : " (fragment, Apply disabled)"));
    }

    /**
     * Apply the right-side content to the file, with concurrent modification protection.
     * Returns true if apply succeeded, false if blocked (caller should reset actionTaken).
     * Write is synchronous (runWriteAction) so the diff only closes after successful write.
     */
    private static boolean applyContent(
            @NotNull Project project,
            @NotNull AdjustableDiffRequest request,
            @NotNull DocumentContent rightContent,
            @NotNull LightVirtualFile rightFile,
            @NotNull DiffFileOperations fileOperations,
            @NotNull SimpleDiffRequestChain chain
    ) {
        String filePath = request.getFilePath();

        // Concurrent modification check
        String diskSnapshot = request.getDiskSnapshot();
        if (diskSnapshot != null) {
            String currentDisk = DiffReconstructionService.readFileContent(filePath);
            if (currentDisk != null) {
                String normalizedSnapshot = LineSeparatorUtil.normalizeToLF(diskSnapshot);
                String normalizedCurrent = LineSeparatorUtil.normalizeToLF(currentDisk);
                if (!normalizedSnapshot.equals(normalizedCurrent)) {
                    LOG.warn("File modified externally during diff session: " + filePath);
                    Messages.showWarningDialog(
                            project,
                            ClaudeCodeGuiBundle.message("diff.adjustable.fileChanged"),
                            ClaudeCodeGuiBundle.message("diff.adjustable.fileChangedTitle")
                    );
                    return false;
                }
            }
        }

        // Security check
        if (!fileOperations.isPathWithinProject(filePath)) {
            LOG.warn("Security: file path outside project directory: " + filePath);
            return false;
        }

        // Read the edited content from the right side
        String content = getEditedContent(rightContent, rightFile);
        if (content == null) {
            LOG.error("Failed to read edited content from diff view");
            return false;
        }

        // Synchronous write via VFS — diff only closes on success
        try {
            VirtualFile file = LocalFileSystem.getInstance()
                    .refreshAndFindFileByPath(filePath.replace('\\', '/'));
            if (file == null || !file.exists()) {
                LOG.error("File not found for apply: " + filePath);
                Messages.showErrorDialog(project,
                        "File not found: " + filePath,
                        ClaudeCodeGuiBundle.message("diff.adjustable.fileChangedTitle"));
                return false;
            }

            Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;
            ApplicationManager.getApplication().runWriteAction(() -> {
                try {
                    file.setBinaryContent(content.getBytes(charset));
                    file.refresh(false, false);
                } catch (IOException e) {
                    throw new RuntimeException(e);
                }
            });

            LOG.info("Applied adjustable diff content to: " + filePath);
            closeDiffView(project, chain);
            return true;
        } catch (RuntimeException e) {
            LOG.error("Failed to write file: " + filePath, e);
            Messages.showErrorDialog(project,
                    "Failed to write file: " + e.getMessage(),
                    ClaudeCodeGuiBundle.message("diff.adjustable.fileChangedTitle"));
            return false;
        }
    }

    private static String getEditedContent(
            @Nullable DocumentContent docContent,
            @NotNull LightVirtualFile file
    ) {
        if (docContent != null && docContent.getDocument() != null) {
            return docContent.getDocument().getText();
        }
        return file.getContent().toString();
    }

    private static void closeDiffView(@NotNull Project project, @NotNull SimpleDiffRequestChain chain) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                FileEditorManager manager = FileEditorManager.getInstance(project);
                for (VirtualFile file : manager.getOpenFiles()) {
                    if (file instanceof ChainDiffVirtualFile) {
                        ChainDiffVirtualFile diffFile = (ChainDiffVirtualFile) file;
                        if (diffFile.getChain() == chain) {
                            manager.closeFile(file);
                            break;
                        }
                    }
                }
            } catch (Exception e) {
                LOG.debug("Failed to close adjustable diff view", e);
            }
        });
    }
}
