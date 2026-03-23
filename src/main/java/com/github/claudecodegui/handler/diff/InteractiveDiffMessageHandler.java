package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;
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
 * Handles show_interactive_diff messages.
 */
public class InteractiveDiffMessageHandler implements DiffActionHandler {

    private static final Logger LOG = Logger.getInstance(InteractiveDiffMessageHandler.class);

    private final HandlerContext context;
    private final Gson gson;
    private final DiffBrowserBridge browserBridge;
    private final DiffFileOperations fileOperations;

    public InteractiveDiffMessageHandler(
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

    private static final String[] TYPES = {"show_interactive_diff"};

    @Override
    public String[] getSupportedTypes() {
        return TYPES;
    }

    @Override
    public void handle(String type, String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            String newFileContents = json.has("newFileContents") ? json.get("newFileContents").getAsString() : "";
            String tabName = json.has("tabName") ? json.get("tabName").getAsString() : null;
            boolean isNewFile = json.has("isNewFile") && json.get("isNewFile").getAsBoolean();

            if (!fileOperations.isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                browserBridge.sendDiffResult(filePath, "REJECT", null, "File path outside project");
                return;
            }

            if (filePath.isEmpty()) {
                LOG.warn("show_interactive_diff: filePath is empty");
                browserBridge.sendDiffResult(filePath, "REJECT", null, "File path is empty");
                return;
            }

            if (tabName == null || tabName.isEmpty()) {
                String fileName = new File(filePath).getName();
                tabName = ClaudeCodeGuiBundle.message("diff.tabName", fileName, 1);
            }

            LOG.info("Showing interactive diff for file: " + filePath);

            if (!isNewFile) {
                File file = new File(filePath);
                if (!file.exists()) {
                    LOG.warn("File does not exist: " + filePath);
                    browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.fileNotFoundDetail", filePath));
                    browserBridge.sendDiffResult(filePath, "REJECT", null, "File not found");
                    return;
                }
            }

            String finalTabName = tabName;
            ApplicationManager.getApplication().invokeLater(() ->
                    showInteractiveDiff(filePath, newFileContents, finalTabName, isNewFile)
            );
        } catch (Exception e) {
            LOG.error("Failed to parse show_interactive_diff request: " + e.getMessage(), e);
        }
    }

    private void showInteractiveDiff(String filePath, String newFileContents, String tabName, boolean isNewFile) {
        try {
            String originalContent = "";
            if (!isNewFile) {
                VirtualFile vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                if (vFile != null) {
                    vFile.refresh(false, false);
                    Charset charset = vFile.getCharset() != null ? vFile.getCharset() : StandardCharsets.UTF_8;
                    try {
                        originalContent = new String(vFile.contentsToByteArray(), charset);
                    } catch (IOException e) {
                        LOG.error("Failed to read file content: " + filePath, e);
                        browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.fileReadFailedDetail", e.getMessage()));
                        browserBridge.sendDiffResult(filePath, "REJECT", null, "Failed to read file");
                        return;
                    }
                }
            }

            InteractiveDiffRequest request = isNewFile
                    ? InteractiveDiffRequest.forNewFile(filePath, newFileContents, tabName)
                    : InteractiveDiffRequest.forModifiedFile(filePath, originalContent, newFileContents, tabName);

            InteractiveDiffManager.showInteractiveDiff(context.getProject(), request)
                    .thenAccept(result -> handleDiffResult(result, filePath))
                    .exceptionally(e -> {
                        LOG.error("Error in interactive diff: " + e.getMessage(), e);
                        browserBridge.sendDiffResult(filePath, "REJECT", null, e.getMessage());
                        return null;
                    });
        } catch (Exception e) {
            LOG.error("Failed to show interactive diff: " + e.getMessage(), e);
            browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.openFailedDetail", e.getMessage()));
        }
    }

    private void handleDiffResult(DiffResult result, String filePath) {
        if (result.isApplied()) {
            fileOperations.writeContentToFile(filePath, result.getFinalContent());
            browserBridge.sendDiffResult(filePath, "APPLY", result.getFinalContent(), null);
            return;
        }

        if (result.isRejected()) {
            browserBridge.sendDiffResult(filePath, "REJECT", null, null);
            return;
        }

        LOG.info("Diff dismissed for: " + filePath);
        browserBridge.sendDiffResult(filePath, "DISMISS", null, null);
    }
}
