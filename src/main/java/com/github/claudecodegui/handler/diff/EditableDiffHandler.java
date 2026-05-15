package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.ContentRebuildResult;
import com.github.claudecodegui.util.ContentRebuildUtil;
import com.github.claudecodegui.util.LineSeparatorUtil;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

/**
 * Handles editable diff messages.
 */
public class EditableDiffHandler implements DiffActionHandler {

    private static final Logger LOG = Logger.getInstance(EditableDiffHandler.class);

    private final HandlerContext context;
    private final Gson gson;
    private final DiffBrowserBridge browserBridge;
    private final DiffFileOperations fileOperations;

    public EditableDiffHandler(
            HandlerContext context,
            Gson gson,
            DiffBrowserBridge browserBridge,
            DiffFileOperations fileOperations
    ) {
        this.context = context;
        this.gson = gson;
        this.browserBridge = browserBridge;
        this.fileOperations = fileOperations;
    }

    private static final String[] TYPES = {"show_editable_diff"};

    @Override
    public String[] getSupportedTypes() {
        return TYPES;
    }

    @Override
    public void handle(String type, String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray operations = json.has("operations") ? json.getAsJsonArray("operations") : new JsonArray();
            String status = json.has("status") ? json.get("status").getAsString() : "M";

            if (!fileOperations.isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                return;
            }

            LOG.info("Showing editable diff for file: " + filePath + " with " + operations.size() + " operations, status: " + status);

            boolean isNewFile = "A".equals(status);
            if (!isNewFile) {
                File file = new File(filePath);
                if (!file.exists()) {
                    LOG.warn("File does not exist: " + filePath);
                    browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.fileNotFoundDetail", filePath));
                    browserBridge.sendRemoveFileFromEdits(filePath);
                    return;
                }
            }

            ApplicationManager.getApplication().invokeLater(() -> showEditableDiff(filePath, operations, isNewFile));
        } catch (Exception e) {
            LOG.error("Failed to parse show_editable_diff request: " + e.getMessage(), e);
        }
    }

    private void showEditableDiff(String filePath, JsonArray operations, boolean isNewFile) {
        try {
            String currentContent = "";
            Charset charset = StandardCharsets.UTF_8;

            VirtualFile vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
            if (vFile != null) {
                vFile.refresh(false, false);
                charset = vFile.getCharset() != null ? vFile.getCharset() : StandardCharsets.UTF_8;
                try {
                    currentContent = new String(vFile.contentsToByteArray(), charset);
                } catch (IOException e) {
                    LOG.error("Failed to read file content: " + filePath, e);
                    browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.fileReadFailedDetail", e.getMessage()));
                    return;
                }
            }

            // currentContent is the actual disk content — use it as the safe restore baseline on Reject
            String diskSnapshot = currentContent;

            ContentRebuildResult rebuildResult = isNewFile
                    ? null
                    : ContentRebuildUtil.rebuildBeforeContent(currentContent, operations);
            String originalContent = isNewFile ? "" : rebuildResult.getContent();
            boolean rebuildExact = rebuildResult != null && rebuildResult.isExact();

            String fileName = new File(filePath).getName();
            String tabName = ClaudeCodeGuiBundle.message("diff.tabName", fileName, operations.size());
            if (!isNewFile && !rebuildExact) {
                tabName += " " + ClaudeCodeGuiBundle.message("diff.editOnly");
            }

            InteractiveDiffRequest request;
            if (isNewFile) {
                request = InteractiveDiffRequest.forNewFile(filePath, currentContent, tabName);
            } else if (rebuildExact) {
                request = InteractiveDiffRequest.forModifiedFile(filePath, originalContent, currentContent, tabName);
            } else {
                // Rebuild was approximate (fuzzy/skipped ops) — right side read-only
                // to prevent editing based on unreliable baseline, but no Apply Always
                // (this is not a permission review flow)
                request = InteractiveDiffRequest.forApproximateModifiedFile(filePath, originalContent, currentContent, tabName);
            }

            LOG.info("Diff request created - original length: " + originalContent.length()
                    + ", current length: " + currentContent.length()
                    + ", rebuild exact: " + rebuildExact);

            InteractiveDiffManager.showInteractiveDiff(context.getProject(), request)
                    .thenAccept(result -> handleDiffResult(result, filePath, diskSnapshot, isNewFile))
                    .exceptionally(e -> {
                        LOG.error("Error in interactive diff: " + e.getMessage(), e);
                        browserBridge.sendDiffResult(filePath, "REJECT", null, e.getMessage());
                        return null;
                    });

            LOG.info("Interactive editable diff view opened for: " + filePath);
        } catch (Exception e) {
            LOG.error("Failed to show editable diff: " + e.getMessage(), e);
            browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.openFailedDetail", e.getMessage()));
        }
    }

    private void handleDiffResult(DiffResult result, String filePath, String diskSnapshot, boolean isNewFile) {
        if (result.isApplied()) {
            // Stale-check: verify file hasn't been modified or deleted externally
            if (diskSnapshot != null) {
                if (isStale(filePath, diskSnapshot)) {
                    browserBridge.showErrorToast(
                            ClaudeCodeGuiBundle.message("diff.adjustable.fileChanged"));
                    browserBridge.sendDiffResult(filePath, "REJECT", null,
                            "File changed externally");
                    return;
                }
            }
            fileOperations.writeContentToFile(filePath, result.getFinalContent());
            browserBridge.sendDiffResult(filePath, "APPLY", result.getFinalContent(), null);
            return;
        }

        if (result.isRejected()) {
            if (isNewFile) {
                // Stale-check before deleting: if file was modified externally, don't delete
                if (diskSnapshot != null && isStale(filePath, diskSnapshot)) {
                    LOG.warn("New file modified externally, skipping delete on reject: " + filePath);
                    browserBridge.sendRemoveFileFromEdits(filePath);
                    browserBridge.sendDiffResult(filePath, "REJECT", null, null);
                    return;
                }
                fileOperations.deleteFile(filePath);
            } else {
                // Stale-check before restoring: if file diverged, don't overwrite
                if (isStale(filePath, diskSnapshot)) {
                    LOG.warn("File changed externally, skipping restore on reject: " + filePath);
                    browserBridge.sendRemoveFileFromEdits(filePath);
                    browserBridge.sendDiffResult(filePath, "REJECT", null, null);
                    return;
                }
                fileOperations.writeContentToFile(filePath, diskSnapshot);
            }
            browserBridge.sendRemoveFileFromEdits(filePath);
            browserBridge.sendDiffResult(filePath, "REJECT", null, null);
            return;
        }

        LOG.info("Diff dismissed for: " + filePath);
        browserBridge.sendDiffResult(filePath, "DISMISS", null, null);
    }

    /**
     * Check if the file on disk has diverged from the snapshot taken when the diff was opened.
     * Returns true if the file was deleted or modified externally.
     */
    private boolean isStale(String filePath, String diskSnapshot) {
        String currentDisk = DiffReconstructionService.readFileContent(filePath);
        if (currentDisk == null) {
            LOG.warn("File deleted externally during interactive diff session: " + filePath);
            return true;
        }
        String normalizedSnapshot = LineSeparatorUtil.normalizeToLF(diskSnapshot);
        String normalizedCurrent = LineSeparatorUtil.normalizeToLF(currentDisk);
        if (!normalizedSnapshot.equals(normalizedCurrent)) {
            LOG.warn("File modified externally during interactive diff session: " + filePath);
            return true;
        }
        return false;
    }
}
