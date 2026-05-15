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
            String requestId = json.has("requestId") && !json.get("requestId").isJsonNull() ? json.get("requestId").getAsString() : null;

            if (!fileOperations.isPathWithinProject(filePath)) {
                String message = "Invalid file path: path must be within project directory";
                LOG.warn("Security: file path outside project directory: " + filePath);
                browserBridge.sendDiffResult(filePath, "ERROR", null, message, requestId);
                return;
            }

            LOG.info("Showing editable diff for file: " + filePath + " with " + operations.size() + " operations, status: " + status);

            boolean isNewFile = "A".equals(status);
            if (!isNewFile) {
                File file = new File(filePath);
                if (!file.exists()) {
                    LOG.warn("File does not exist: " + filePath);
                    browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.fileNotFoundDetail", filePath));
                    browserBridge.sendDiffResult(filePath, "ERROR", null, "File not found", requestId);
                    return;
                }
            }

            ApplicationManager.getApplication().executeOnPooledThread(() -> showEditableDiff(filePath, operations, isNewFile, requestId));
        } catch (Exception e) {
            LOG.error("Failed to parse show_editable_diff request: " + e.getMessage(), e);
        }
    }

    private void showEditableDiff(String filePath, JsonArray operations, boolean isNewFile, String requestId) {
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
                    browserBridge.sendDiffResult(filePath, "ERROR", null, e.getMessage(), requestId);
                    return;
                }
            }

            if (!areOperationsSafeToRollback(operations)) {
                String message = "Unable to open editable diff because one or more operations are marked unsafe to rollback";
                LOG.warn(message + ": " + filePath);
                browserBridge.showErrorToast(message);
                browserBridge.sendDiffResult(filePath, "ERROR", null, message, requestId);
                return;
            }

            ContentRebuildUtil.RebuildResult rebuildResult = isNewFile
                    ? new ContentRebuildUtil.RebuildResult(true, "", new JsonArray())
                    : ContentRebuildUtil.rebuildBeforeContentResult(currentContent, operations);
            if (!rebuildResult.success()) {
                String message = "Unable to rebuild original content for diff; one or more operations no longer match current file content";
                LOG.warn(message + ": " + filePath);
                browserBridge.showErrorToast(message);
                browserBridge.sendDiffResult(filePath, "ERROR", null, message, requestId);
                return;
            }
            String originalContent = rebuildResult.content();

            String fileName = new File(filePath).getName();
            String tabName = ClaudeCodeGuiBundle.message("diff.tabName", fileName, operations.size());

            String expectedCurrentContent = currentContent;
            InteractiveDiffRequest request = isNewFile
                    ? InteractiveDiffRequest.forNewFile(filePath, expectedCurrentContent, tabName)
                    : InteractiveDiffRequest.forModifiedFile(filePath, originalContent, expectedCurrentContent, tabName);

            LOG.info("Diff request created - original length: " + originalContent.length() + ", current length: " + expectedCurrentContent.length());

            InteractiveDiffManager.showInteractiveDiff(context.getProject(), request)
                    .thenAccept(result -> handleDiffResult(result, filePath, originalContent, expectedCurrentContent, isNewFile, requestId))
                    .exceptionally(e -> {
                        LOG.error("Error in interactive diff: " + e.getMessage(), e);
                        browserBridge.sendDiffResult(filePath, "REJECT", null, e.getMessage(), requestId);
                        return null;
                    });

            LOG.info("Interactive editable diff view opened for: " + filePath);
        } catch (Exception e) {
            LOG.error("Failed to show editable diff: " + e.getMessage(), e);
            browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.openFailedDetail", e.getMessage()));
            browserBridge.sendDiffResult(filePath, "ERROR", null, e.getMessage(), requestId);
        }
    }

    public static boolean areOperationsSafeToRollback(JsonArray operations) {
        if (operations == null) {
            return true;
        }
        for (int i = 0; i < operations.size(); i++) {
            if (!operations.get(i).isJsonObject()) {
                continue;
            }
            JsonObject operation = operations.get(i).getAsJsonObject();
            if (hasFalseBoolean(operation, "safeToRollback") || hasFalseBoolean(operation, "safe_to_rollback")) {
                return false;
            }
        }
        return true;
    }

    private static boolean hasFalseBoolean(JsonObject object, String key) {
        if (!object.has(key) || object.get(key).isJsonNull()) {
            return false;
        }
        try {
            return !object.get(key).getAsBoolean();
        } catch (Exception e) {
            return false;
        }
    }

    private void handleDiffResult(DiffResult result, String filePath, String originalContent, String expectedCurrentContent, boolean isNewFile, String requestId) {
        if (result.isApplied()) {
            if (!fileOperations.contentEquals(filePath, expectedCurrentContent)) {
                browserBridge.sendDiffResult(filePath, "ERROR", null, "File changed while diff was open", requestId);
                return;
            }
            boolean written = fileOperations.writeContentToFile(filePath, result.getFinalContent());
            if (written) {
                browserBridge.sendDiffResult(filePath, "APPLY", result.getFinalContent(), null, requestId);
            } else {
                browserBridge.sendDiffResult(filePath, "ERROR", null, "Failed to write applied diff content", requestId);
            }
            return;
        }

        if (result.isRejected()) {
            if (!fileOperations.contentEquals(filePath, expectedCurrentContent)) {
                browserBridge.sendDiffResult(filePath, "ERROR", null, "File changed while diff was open", requestId);
                return;
            }
            boolean reverted = isNewFile
                    ? fileOperations.deleteFile(filePath)
                    : fileOperations.writeContentToFile(filePath, originalContent);
            if (reverted) {
                browserBridge.sendRemoveFileFromEdits(filePath, requestId);
                browserBridge.sendDiffResult(filePath, "REJECT", null, null, requestId);
            } else {
                browserBridge.sendDiffResult(filePath, "ERROR", null, "Failed to revert diff changes", requestId);
            }
            return;
        }

        LOG.info("Diff dismissed for: " + filePath);
        browserBridge.sendDiffResult(filePath, "DISMISS", null, null, requestId);
    }
}
