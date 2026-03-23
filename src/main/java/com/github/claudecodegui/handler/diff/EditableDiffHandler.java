package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.ContentRebuildUtil;
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

            String originalContent = isNewFile
                    ? ""
                    : ContentRebuildUtil.rebuildBeforeContent(currentContent, operations);

            String fileName = new File(filePath).getName();
            String tabName = ClaudeCodeGuiBundle.message("diff.tabName", fileName, operations.size());

            InteractiveDiffRequest request = isNewFile
                    ? InteractiveDiffRequest.forNewFile(filePath, currentContent, tabName)
                    : InteractiveDiffRequest.forModifiedFile(filePath, originalContent, currentContent, tabName);

            LOG.info("Diff request created - original length: " + originalContent.length() + ", current length: " + currentContent.length());

            InteractiveDiffManager.showInteractiveDiff(context.getProject(), request)
                    .thenAccept(result -> handleDiffResult(result, filePath, originalContent, isNewFile))
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

    private void handleDiffResult(DiffResult result, String filePath, String originalContent, boolean isNewFile) {
        if (result.isApplied()) {
            fileOperations.writeContentToFile(filePath, result.getFinalContent());
            browserBridge.sendDiffResult(filePath, "APPLY", result.getFinalContent(), null);
            return;
        }

        if (result.isRejected()) {
            if (isNewFile) {
                fileOperations.deleteFile(filePath);
            } else {
                fileOperations.writeContentToFile(filePath, originalContent);
            }
            browserBridge.sendRemoveFileFromEdits(filePath);
            browserBridge.sendDiffResult(filePath, "REJECT", null, null);
            return;
        }

        LOG.info("Diff dismissed for: " + filePath);
        browserBridge.sendDiffResult(filePath, "DISMISS", null, null);
    }
}
