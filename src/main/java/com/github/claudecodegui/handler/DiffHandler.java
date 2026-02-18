package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeCodeGuiBundle;
import com.github.claudecodegui.handler.diff.DiffBrowserBridge;
import com.github.claudecodegui.handler.diff.InteractiveDiffManager;
import com.github.claudecodegui.handler.diff.InteractiveDiffRequest;
import com.github.claudecodegui.util.ContentRebuildUtil;
import com.github.claudecodegui.util.EditorFileUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffManager;
import com.intellij.diff.contents.DiffContent;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Diff and file refresh message handler.
 */
public class DiffHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DiffHandler.class);
    private final Gson gson = new Gson();
    private final DiffBrowserBridge browserBridge;

    private static final String[] SUPPORTED_TYPES = {
        "refresh_file",
        "show_diff",
        "show_multi_edit_diff",
        "show_editable_diff",
        "show_edit_preview_diff",
        "show_edit_full_diff",
        "show_interactive_diff"
    };

    public DiffHandler(HandlerContext context) {
        super(context);
        this.browserBridge = new DiffBrowserBridge(context, gson);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "refresh_file":
                handleRefreshFile(content);
                return true;
            case "show_diff":
                handleShowDiff(content);
                return true;
            case "show_multi_edit_diff":
                handleShowMultiEditDiff(content);
                return true;
            case "show_editable_diff":
                handleShowEditableDiff(content);
                return true;
            case "show_edit_preview_diff":
                handleShowEditPreviewDiff(content);
                return true;
            case "show_edit_full_diff":
                handleShowEditFullDiff(content);
                return true;
            case "show_interactive_diff":
                handleShowInteractiveDiff(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Refresh a file in IDEA.
     * Uses async processing and retry mechanisms to ensure the file is properly refreshed.
     */
    private void handleRefreshFile(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : null;

            if (filePath == null || filePath.isEmpty()) {
                LOG.warn("refresh_file: filePath is empty");
                return;
            }

            LOG.info("Refreshing file: " + filePath);

            // Process file refresh in a background thread
            CompletableFuture.runAsync(() -> {
                try {
                    File file = new File(filePath);

                    // Add a short delay to wait for file write completion
                    try {
                        TimeUnit.MILLISECONDS.sleep(300);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }

                    // If the file does not exist and is a relative path, try resolving relative to the project root
                    if (!file.exists() && !file.isAbsolute() && context.getProject().getBasePath() != null) {
                        File projectFile = new File(context.getProject().getBasePath(), filePath);
                        if (projectFile.exists()) {
                            file = projectFile;
                        }
                    }

                    if (!file.exists()) {
                        LOG.warn("File does not exist: " + filePath);
                        return;
                    }

                    final File finalFile = file;

                    // Use utility method to asynchronously refresh and find the file
                    EditorFileUtils.refreshAndFindFileAsync(
                            finalFile,
                            virtualFile -> performFileRefresh(virtualFile, filePath),
                            () -> LOG.error("Failed to refresh file: " + filePath)
                    );

                } catch (Exception e) {
                    LOG.error("Failed to refresh file: " + filePath, e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse refresh_file request: " + e.getMessage(), e);
        }
    }

    /**
     * Perform the file refresh operation (must be called on the UI thread).
     */
    private void performFileRefresh(VirtualFile virtualFile, String filePath) {
        try {
            // Refresh the file system so IDEA detects the file change.
            // IDEA will automatically prompt the user to reload, avoiding conflicts from forced refresh.
            virtualFile.refresh(false, false);

            LOG.info("File refreshed successfully: " + filePath);
        } catch (Exception e) {
            LOG.error("Failed to perform file refresh: " + filePath, e);
        }
    }

    /**
     * Show the diff view.
     */
    private void handleShowDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            String oldContent = json.has("oldContent") ? json.get("oldContent").getAsString() : "";
            String newContent = json.has("newContent") ? json.get("newContent").getAsString() : "";
            String title = json.has("title") ? json.get("title").getAsString() : null;

            LOG.info("Showing diff for file: " + filePath);

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    String fileName = new File(filePath).getName();
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    // Create diff content
                    DiffContent leftContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), oldContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), newContent, fileType);

                    // Create diff request
                    String diffTitle = title != null ? title : ClaudeCodeGuiBundle.message("diff.fileChange", fileName);
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        ClaudeCodeGuiBundle.message("diff.editBefore", fileName),
                        ClaudeCodeGuiBundle.message("diff.editAfter", fileName)
                    );

                    // Show diff window
                    DiffManager.getInstance().showDiff(context.getProject(), diffRequest);

                    LOG.info("Diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_diff request: " + e.getMessage(), e);
        }
    }

    /**
     * Show diff view for multiple edits.
     */
    private void handleShowMultiEditDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray edits = json.has("edits") ? json.getAsJsonArray("edits") : new JsonArray();
            String currentContent = json.has("currentContent") ? json.get("currentContent").getAsString() : null;

            LOG.info("Showing multi-edit diff for file: " + filePath + " with " + edits.size() + " edits");

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    // Get current file content
                    String afterContent = currentContent;
                    if (afterContent == null) {
                        File file = new File(filePath);
                        if (file.exists()) {
                            VirtualFile virtualFile = EditorFileUtils.refreshAndFindFileSync(file);
                            if (virtualFile != null) {
                                virtualFile.refresh(false, false);
                                afterContent = new String(virtualFile.contentsToByteArray(), StandardCharsets.UTF_8);
                            }
                        }
                    }

                    if (afterContent == null) {
                        LOG.warn("Could not read file content: " + filePath);
                        return;
                    }

                    // Reverse-rebuild content before edits
                    String beforeContent = ContentRebuildUtil.rebuildBeforeContent(afterContent, edits);

                    String fileName = new File(filePath).getName();
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    // Create diff content
                    DiffContent leftContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), beforeContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), afterContent, fileType);

                    // Create diff request
                    String diffTitle = ClaudeCodeGuiBundle.message("diff.tabName", fileName, edits.size());
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        fileName + " (修改前)",
                        fileName + " (修改后)"
                    );

                    // Show diff window
                    DiffManager.getInstance().showDiff(context.getProject(), diffRequest);

                    LOG.info("Multi-edit diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show multi-edit diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_multi_edit_diff request: " + e.getMessage(), e);
        }
    }

    /**
     * Show an editable diff view.
     * Users can selectively accept or reject changes in the diff view.
     * Uses the InteractiveDiffManager implementation with Apply/Reject buttons.
     */
    private void handleShowEditableDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray operations = json.has("operations") ? json.getAsJsonArray("operations") : new JsonArray();
            String status = json.has("status") ? json.get("status").getAsString() : "M";

            LOG.info("Showing editable diff for file: " + filePath + " with " + operations.size() + " operations, status: " + status);

            // Check if file exists (for modified files)
            boolean isNewFile = "A".equals(status);
            if (!isNewFile) {
                File file = new File(filePath);
                if (!file.exists()) {
                    LOG.warn("File does not exist: " + filePath);
                    showErrorToast(ClaudeCodeGuiBundle.message("diff.fileNotFoundDetail", filePath));
                    sendRemoveFileFromEdits(filePath);
                    return;
                }
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    // Read current file content (this is the content AFTER modifications)
                    // For both new and modified files, Claude Code has already written the file to disk
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
                            showErrorToast(ClaudeCodeGuiBundle.message("diff.fileReadFailedDetail", e.getMessage()));
                            return;
                        }
                    }

                    // Rebuild the original content (BEFORE modifications) by reverse-applying operations
                    String originalContent;
                    if (isNewFile) {
                        // New file: original content is empty
                        originalContent = "";
                    } else {
                        // Modified file: rebuild original content by reverse-applying operations
                        originalContent = ContentRebuildUtil.rebuildBeforeContent(currentContent, operations);
                    }

                    // Create diff request using InteractiveDiffManager
                    // Left side: originalContent (before modifications)
                    // Right side: currentContent (after modifications, editable)
                    String fileName = new File(filePath).getName();
                    String tabName = ClaudeCodeGuiBundle.message("diff.tabName", fileName, operations.size());

                    InteractiveDiffRequest request;
                    if (isNewFile) {
                        request = InteractiveDiffRequest.forNewFile(filePath, currentContent, tabName);
                    } else {
                        request = InteractiveDiffRequest.forModifiedFile(filePath, originalContent, currentContent, tabName);
                    }

                    LOG.info("Diff request created - original length: " + originalContent.length() + ", current length: " + currentContent.length());

                    // Show interactive diff and handle result
                    final String finalFilePath = filePath;
                    final String finalOriginalContent = originalContent;
                    InteractiveDiffManager.showInteractiveDiff(context.getProject(), request)
                            .thenAccept(result -> {
                                if (result.isApplied()) {
                                    // Write content to file (user may have edited in diff view)
                                    writeContentToFile(finalFilePath, result.getFinalContent());
                                    sendDiffResult(finalFilePath, "APPLY", result.getFinalContent(), null);
                                } else if (result.isRejected()) {
                                    if (isNewFile) {
                                        // New file rejected: delete the file (it didn't exist before)
                                        deleteFile(finalFilePath);
                                    } else {
                                        // Modified file rejected: restore original content
                                        writeContentToFile(finalFilePath, finalOriginalContent);
                                    }
                                    sendRemoveFileFromEdits(finalFilePath);
                                    sendDiffResult(finalFilePath, "REJECT", null, null);
                                } else {
                                    // User dismissed (closed window) - do nothing, keep file as-is
                                    LOG.info("Diff dismissed for: " + finalFilePath);
                                    sendDiffResult(finalFilePath, "DISMISS", null, null);
                                }
                            })
                            .exceptionally(e -> {
                                LOG.error("Error in interactive diff: " + e.getMessage(), e);
                                sendDiffResult(finalFilePath, "REJECT", null, e.getMessage());
                                return null;
                            });

                    LOG.info("Interactive editable diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show editable diff: " + e.getMessage(), e);
                    showErrorToast(ClaudeCodeGuiBundle.message("diff.openFailedDetail", e.getMessage()));
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_editable_diff request: " + e.getMessage(), e);
        }
    }

    private void showErrorToast(String message) {
        browserBridge.showErrorToast(message);
    }

    private void sendRemoveFileFromEdits(String filePath) {
        browserBridge.sendRemoveFileFromEdits(filePath);
    }

    private void sendDiffResult(String filePath, String action, String content, String error) {
        browserBridge.sendDiffResult(filePath, action, content, error);
    }

    /**
     * Show edit preview diff (current content -> content after applying edits).
     * Used to preview the effect before executing edits.
     */
    private void handleShowEditPreviewDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray edits = json.has("edits") ? json.getAsJsonArray("edits") : new JsonArray();
            String title = json.has("title") ? json.get("title").getAsString() : null;

            LOG.info("Showing edit preview diff for file: " + filePath + " with " + edits.size() + " edits");

            if (!isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    // Get current file content
                    VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                    if (file != null && file.isDirectory()) {
                        LOG.warn("Cannot show preview diff for directory: " + filePath);
                        return;
                    }

                    String currentContent = "";
                    Charset charset = StandardCharsets.UTF_8;
                    if (file != null) {
                        file.refresh(false, false);
                        charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;
                        try {
                            currentContent = new String(file.contentsToByteArray(), charset);
                        } catch (IOException e) {
                            LOG.error("Failed to read file content: " + filePath, e);
                            return;
                        }
                    }

                    // Apply edits to get preview content
                    String afterContent = currentContent;
                    for (int i = 0; i < edits.size(); i++) {
                        JsonObject edit = edits.get(i).getAsJsonObject();
                        String oldString = edit.has("oldString") ? edit.get("oldString").getAsString() : "";
                        String newString = edit.has("newString") ? edit.get("newString").getAsString() : "";
                        boolean replaceAll = edit.has("replaceAll") && edit.get("replaceAll").getAsBoolean();

                        if (replaceAll) {
                            afterContent = afterContent.replace(oldString, newString);
                        } else {
                            int index = afterContent.indexOf(oldString);
                            if (index >= 0) {
                                afterContent = afterContent.substring(0, index) + newString + afterContent.substring(index + oldString.length());
                            } else {
                                LOG.warn("oldString not found in file, skipping edit");
                            }
                        }
                    }

                    String fileName = new File(filePath).getName();
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    DiffContent leftContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), currentContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), afterContent, fileType);

                    String diffTitle = title != null ? title : ClaudeCodeGuiBundle.message("diff.editPreview", fileName);
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        ClaudeCodeGuiBundle.message("diff.editPreviewCurrent", fileName),
                        ClaudeCodeGuiBundle.message("diff.editPreviewAfter", fileName)
                    );

                    DiffManager.getInstance().showDiff(context.getProject(), diffRequest);
                    LOG.info("Edit preview diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show edit preview diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_edit_preview_diff request: " + e.getMessage(), e);
        }
    }

    /**
     * Show full file diff (original content -> modified content).
     * Used to display a complete file comparison before and after modification.
     */
    private void handleShowEditFullDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            String oldString = json.has("oldString") ? json.get("oldString").getAsString() : "";
            String newString = json.has("newString") ? json.get("newString").getAsString() : "";
            String originalContent = json.has("originalContent") ? json.get("originalContent").getAsString() : null;
            boolean replaceAll = json.has("replaceAll") && json.get("replaceAll").getAsBoolean();
            String title = json.has("title") ? json.get("title").getAsString() : null;

            LOG.info("Showing edit full diff for file: " + filePath);

            if (!isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                    if (file != null && file.isDirectory()) {
                        LOG.warn("Cannot show diff for directory: " + filePath);
                        return;
                    }

                    String fileName = new File(filePath).getName();
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    String beforeContent;
                    String afterContent;

                    if (originalContent != null && !originalContent.isEmpty()) {
                        // Cached original content available: show full file diff
                        LOG.info("Using cached original content for full file diff");
                        beforeContent = originalContent;

                        // Calculate modified content: apply oldString -> newString replacement on the original content
                        if (replaceAll) {
                            afterContent = beforeContent.replace(oldString, newString);
                        } else {
                            int index = beforeContent.indexOf(oldString);
                            if (index >= 0) {
                                afterContent = beforeContent.substring(0, index) + newString + beforeContent.substring(index + oldString.length());
                            } else {
                                // oldString not found in original content, use current file content
                                if (file != null) {
                                    try {
                                        afterContent = new String(file.contentsToByteArray(), file.getCharset());
                                    } catch (IOException e) {
                                        afterContent = "";
                                    }
                                } else {
                                    afterContent = "";
                                }
                            }
                        }
                    } else {
                        // No cached original content: show only the edit portion (oldString -> newString)
                        LOG.info("No cached content, showing edit-only diff");
                        beforeContent = oldString;
                        afterContent = newString;
                    }

                    DiffContent leftContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), beforeContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), afterContent, fileType);

                    String diffTitle;
                    String leftLabel;
                    String rightLabel;

                    if (originalContent == null || originalContent.isEmpty()) {
                        diffTitle = (title != null ? title : ClaudeCodeGuiBundle.message("diff.edit", fileName))
                            + " " + ClaudeCodeGuiBundle.message("diff.editOnly");
                        leftLabel = "old_string";
                        rightLabel = "new_string";
                    } else {
                        diffTitle = title != null ? title : ClaudeCodeGuiBundle.message("diff.edit", fileName);
                        leftLabel = ClaudeCodeGuiBundle.message("diff.editBefore", fileName);
                        rightLabel = ClaudeCodeGuiBundle.message("diff.editAfter", fileName);
                    }

                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        leftLabel,
                        rightLabel
                    );

                    DiffManager.getInstance().showDiff(context.getProject(), diffRequest);
                    LOG.info("Edit full diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show edit full diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_edit_full_diff request: " + e.getMessage(), e);
        }
    }

    /**
     * Show interactive diff view with Apply/Reject buttons.
     * Based on the official Claude Code JetBrains plugin implementation.
     * This method receives the NEW content and reads the ORIGINAL content from the file.
     */
    private void handleShowInteractiveDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            String newFileContents = json.has("newFileContents") ? json.get("newFileContents").getAsString() : "";
            String tabName = json.has("tabName") ? json.get("tabName").getAsString() : null;
            boolean isNewFile = json.has("isNewFile") && json.get("isNewFile").getAsBoolean();

            if (filePath.isEmpty()) {
                LOG.warn("show_interactive_diff: filePath is empty");
                sendDiffResult(filePath, "REJECT", null, "File path is empty");
                return;
            }

            // Generate tab name if not provided
            if (tabName == null || tabName.isEmpty()) {
                String fileName = new File(filePath).getName();
                tabName = ClaudeCodeGuiBundle.message("diff.tabName", fileName, 1);
            }

            LOG.info("Showing interactive diff for file: " + filePath);

            // Check if file exists (for modified files)
            if (!isNewFile) {
                File file = new File(filePath);
                if (!file.exists()) {
                    LOG.warn("File does not exist: " + filePath);
                    showErrorToast(ClaudeCodeGuiBundle.message("diff.fileNotFoundDetail", filePath));
                    sendDiffResult(filePath, "REJECT", null, "File not found");
                    return;
                }
            }

            final String finalTabName = tabName;
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    // Read current file content as ORIGINAL content
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
                                showErrorToast(ClaudeCodeGuiBundle.message("diff.fileReadFailedDetail", e.getMessage()));
                                sendDiffResult(filePath, "REJECT", null, "Failed to read file");
                                return;
                            }
                        }
                    }

                    // Create diff request
                    // Left side: originalContent (current file content)
                    // Right side: newFileContents (proposed new content)
                    InteractiveDiffRequest request;
                    if (isNewFile) {
                        request = InteractiveDiffRequest.forNewFile(filePath, newFileContents, finalTabName);
                    } else {
                        request = InteractiveDiffRequest.forModifiedFile(filePath, originalContent, newFileContents, finalTabName);
                    }

                    // Show interactive diff and handle result
                    final String finalFilePath = filePath;
                    InteractiveDiffManager.showInteractiveDiff(context.getProject(), request)
                            .thenAccept(result -> {
                                if (result.isApplied()) {
                                    // Write content to file
                                    writeContentToFile(finalFilePath, result.getFinalContent());
                                    sendDiffResult(finalFilePath, "APPLY", result.getFinalContent(), null);
                                } else if (result.isRejected()) {
                                    sendDiffResult(finalFilePath, "REJECT", null, null);
                                } else {
                                    // User dismissed (closed window) - do nothing
                                    LOG.info("Diff dismissed for: " + finalFilePath);
                                    sendDiffResult(finalFilePath, "DISMISS", null, null);
                                }
                            })
                            .exceptionally(e -> {
                                LOG.error("Error in interactive diff: " + e.getMessage(), e);
                                sendDiffResult(finalFilePath, "REJECT", null, e.getMessage());
                                return null;
                            });
                } catch (Exception e) {
                    LOG.error("Failed to show interactive diff: " + e.getMessage(), e);
                    showErrorToast(ClaudeCodeGuiBundle.message("diff.openFailedDetail", e.getMessage()));
                }
            });

        } catch (Exception e) {
            LOG.error("Failed to parse show_interactive_diff request: " + e.getMessage(), e);
        }
    }

    /**
     * Check if a file path is within the project directory.
     * Uses canonical paths to prevent path traversal attacks.
     */
    private boolean isPathWithinProject(String filePath) {
        if (filePath == null || filePath.isEmpty()) {
            return false;
        }
        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath == null) {
            LOG.warn("Security: Cannot validate path - project base path is null");
            return false;
        }
        try {
            String canonicalFilePath = new File(filePath).getCanonicalPath();
            String canonicalBasePath = new File(projectBasePath).getCanonicalPath();
            return canonicalFilePath.startsWith(canonicalBasePath + File.separator)
                || canonicalFilePath.equals(canonicalBasePath);
        } catch (IOException e) {
            LOG.error("Failed to validate file path: " + filePath, e);
            return false;
        }
    }

    /**
     * Delete a file and refresh VFS.
     * Used when rejecting a newly created file to fully undo the creation.
     */
    private void deleteFile(String filePath) {
        if (!isPathWithinProject(filePath)) {
            LOG.warn("Security: Attempted to delete file outside project directory: " + filePath);
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                VirtualFile file = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(filePath.replace('\\', '/'));
                if (file != null) {
                    ApplicationManager.getApplication().runWriteAction(() -> {
                        try {
                            file.delete(this);
                            LOG.info("File deleted (reject new file): " + filePath);
                        } catch (IOException e) {
                            LOG.error("Failed to delete file: " + filePath, e);
                        }
                    });
                } else {
                    // Fallback: delete via java.io.File
                    File javaFile = new File(filePath);
                    if (javaFile.exists() && javaFile.delete()) {
                        LOG.info("File deleted via fallback (reject new file): " + filePath);
                    }
                }
            } catch (Exception e) {
                LOG.error("Failed to delete file: " + filePath, e);
            }
        });
    }

    /**
     * Write content to file and refresh VFS.
     * Validates that the file path is within the project directory for security.
     */
    private void writeContentToFile(String filePath, String content) {
        if (content == null) {
            return;
        }

        if (!isPathWithinProject(filePath)) {
            LOG.warn("Security: Attempted to write file outside project directory: " + filePath);
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                VirtualFile file = LocalFileSystem.getInstance()
                        .refreshAndFindFileByPath(filePath.replace('\\', '/'));

                if (file != null) {
                    Charset charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;

                    ApplicationManager.getApplication().runWriteAction(() -> {
                        try {
                            file.setBinaryContent(content.getBytes(charset));
                            file.refresh(false, false);
                            LOG.info("File content written successfully: " + filePath);
                        } catch (IOException e) {
                            LOG.error("Failed to write file content: " + filePath, e);
                        }
                    });
                } else {
                    // File doesn't exist, create it (only within project directory)
                    File javaFile = new File(filePath);
                    File parentDir = javaFile.getParentFile();
                    if (parentDir != null && !parentDir.exists()) {
                        if (!parentDir.mkdirs()) {
                            LOG.error("Failed to create parent directories: " + parentDir.getAbsolutePath());
                            return;
                        }
                    }
                    Files.write(javaFile.toPath(), content.getBytes(StandardCharsets.UTF_8));
                    LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                    LOG.info("New file created: " + filePath);
                }
            } catch (Exception e) {
                LOG.error("Failed to write content to file: " + filePath, e);
            }
        });
    }
}
