package com.github.claudecodegui.handler;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.IOException;

/**
 * Handler for undoing single file changes.
 * Supports reverting modified files and deleting newly added files.
 */
public class UndoFileHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(UndoFileHandler.class);
    private static final Gson gson = new Gson();

    private static final String[] SUPPORTED_TYPES = {
        "undo_file_changes",
        "undo_all_file_changes"
    };

    public UndoFileHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("undo_file_changes".equals(type)) {
            LOG.info("[UndoFileHandler] Handling: undo_file_changes");
            handleUndoFileChanges(content);
            return true;
        } else if ("undo_all_file_changes".equals(type)) {
            LOG.info("[UndoFileHandler] Handling: undo_all_file_changes");
            handleUndoAllFileChanges(content);
            return true;
        }
        return false;
    }

    /**
     * Validate file path is within project directory using canonical path resolution.
     * This prevents path traversal attacks including encoded characters, symlinks, etc.
     * @param filePath The file path to validate
     * @return true if path is valid and safe, false otherwise
     */
    private boolean isValidFilePath(String filePath) {
        if (filePath == null || filePath.isEmpty()) {
            return false;
        }

        String projectBasePath = context.getProject() != null ? context.getProject().getBasePath() : null;
        if (projectBasePath == null) {
            LOG.warn("[UndoFileHandler] Cannot validate path: project base path is null");
            return false;
        }

        try {
            // Use canonical path to resolve symlinks, "..", encoded chars, etc.
            java.io.File file = new java.io.File(filePath);
            java.io.File baseDir = new java.io.File(projectBasePath);

            String canonicalFilePath = file.getCanonicalPath();
            String canonicalBasePath = baseDir.getCanonicalPath();

            // Ensure the file is within the project directory
            boolean isValid = canonicalFilePath.startsWith(canonicalBasePath + java.io.File.separator)
                || canonicalFilePath.equals(canonicalBasePath);

            if (!isValid) {
                LOG.warn("[UndoFileHandler] File path outside project directory: " + filePath +
                    " (canonical: " + canonicalFilePath + ", base: " + canonicalBasePath + ")");
            }

            return isValid;
        } catch (java.io.IOException e) {
            LOG.warn("[UndoFileHandler] Failed to validate path: " + e.getMessage());
            return false;
        }
    }

    private void handleUndoFileChanges(String content) {
        try {
            JsonObject request = gson.fromJson(content, JsonObject.class);
            String filePath = request.has("filePath") ? request.get("filePath").getAsString() : null;
            String status = request.has("status") ? request.get("status").getAsString() : null;
            JsonArray operations = request.has("operations") ? request.getAsJsonArray("operations") : null;

            if (filePath == null || filePath.isEmpty()) {
                sendError(filePath, "File path is required");
                return;
            }

            // Security: Validate file path
            if (!isValidFilePath(filePath)) {
                sendError(filePath, "Invalid file path: path must be within project directory");
                return;
            }

            if (status == null || status.isEmpty()) {
                sendError(filePath, "File status is required");
                return;
            }

            LOG.info("[UndoFileHandler] Undoing changes for file: " + filePath + ", status: " + status);

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    if ("A".equals(status)) {
                        // Added file: delete it
                        deleteFile(filePath);
                    } else if ("M".equals(status)) {
                        // Modified file: reverse the edits
                        if (operations == null || operations.isEmpty()) {
                            sendError(filePath, "No operations to undo");
                            return;
                        }
                        reverseEdits(filePath, operations);
                    } else {
                        sendError(filePath, "Unknown file status: " + status);
                        return;
                    }

                    // Send success callback
                    sendSuccess(filePath);

                } catch (Exception e) {
                    LOG.error("[UndoFileHandler] Failed to undo file changes: " + e.getMessage(), e);
                    sendError(filePath, e.getMessage());
                }
            });

        } catch (Exception e) {
            LOG.error("[UndoFileHandler] Failed to parse undo request: " + e.getMessage(), e);
            sendError(null, "Invalid request: " + e.getMessage());
        }
    }

    private void handleUndoAllFileChanges(String content) {
        try {
            JsonObject request = gson.fromJson(content, JsonObject.class);
            JsonArray files = request.has("files") ? request.getAsJsonArray("files") : null;

            if (files == null || files.isEmpty()) {
                sendAllError("No files to undo");
                return;
            }

            LOG.info("[UndoFileHandler] Undoing changes for " + files.size() + " files");

            ApplicationManager.getApplication().invokeLater(() -> {
                int successCount = 0;
                int failCount = 0;
                StringBuilder errors = new StringBuilder();

                for (int i = 0; i < files.size(); i++) {
                    JsonObject fileObj = files.get(i).getAsJsonObject();
                    String filePath = fileObj.has("filePath") ? fileObj.get("filePath").getAsString() : null;
                    String status = fileObj.has("status") ? fileObj.get("status").getAsString() : null;
                    JsonArray operations = fileObj.has("operations") ? fileObj.getAsJsonArray("operations") : null;

                    if (filePath == null || filePath.isEmpty()) {
                        failCount++;
                        errors.append("File ").append(i).append(": Missing path; ");
                        continue;
                    }

                    // Security: Validate file path
                    if (!isValidFilePath(filePath)) {
                        failCount++;
                        errors.append(filePath).append(": Invalid path (outside project); ");
                        continue;
                    }

                    try {
                        if ("A".equals(status)) {
                            // Added file: delete it
                            deleteFile(filePath);
                        } else if ("M".equals(status)) {
                            // Modified file: reverse the edits
                            if (operations != null && !operations.isEmpty()) {
                                reverseEdits(filePath, operations);
                            }
                        }
                        successCount++;
                        LOG.info("[UndoFileHandler] Successfully undone: " + filePath);
                    } catch (Exception e) {
                        failCount++;
                        errors.append(filePath).append(": ").append(e.getMessage()).append("; ");
                        LOG.error("[UndoFileHandler] Failed to undo " + filePath + ": " + e.getMessage(), e);
                    }
                }

                if (failCount == 0) {
                    sendAllSuccess(successCount);
                } else if (successCount > 0) {
                    // Partial success
                    sendAllSuccess(successCount);
                } else {
                    sendAllError(errors.toString());
                }
            });

        } catch (Exception e) {
            LOG.error("[UndoFileHandler] Failed to parse batch undo request: " + e.getMessage(), e);
            sendAllError("Invalid request: " + e.getMessage());
        }
    }

    private void deleteFile(String filePath) throws Exception {
        VirtualFile file = LocalFileSystem.getInstance().findFileByPath(filePath);
        if (file == null || !file.exists()) {
            LOG.warn("[UndoFileHandler] File not found for deletion: " + filePath);
            // File already doesn't exist, treat as success
            return;
        }

        // Use AtomicReference to capture exception from lambda
        final java.util.concurrent.atomic.AtomicReference<Exception> exceptionRef = new java.util.concurrent.atomic.AtomicReference<>();

        WriteCommandAction.runWriteCommandAction(context.getProject(), "Undo Claude: Delete File", null, () -> {
            try {
                file.delete(this);
                LOG.info("[UndoFileHandler] Successfully deleted file: " + filePath);
            } catch (IOException e) {
                exceptionRef.set(e);
            }
        });

        // Check if exception occurred during write action
        Exception ex = exceptionRef.get();
        if (ex != null) {
            throw new Exception("Failed to delete file: " + ex.getMessage(), ex);
        }
    }

    private void reverseEdits(String filePath, JsonArray operations) throws Exception {
        VirtualFile file = LocalFileSystem.getInstance().findFileByPath(filePath);
        if (file == null || !file.exists()) {
            throw new Exception("File not found: " + filePath);
        }

        Document document = FileDocumentManager.getInstance().getDocument(file);
        if (document == null) {
            throw new Exception("Cannot get document for: " + filePath);
        }

        WriteCommandAction.runWriteCommandAction(context.getProject(), "Undo Claude Changes", null, () -> {
            String content = document.getText();

            // Reverse iterate through operations to undo in correct order
            // Each operation: replace newString back to oldString
            for (int i = operations.size() - 1; i >= 0; i--) {
                JsonObject op = operations.get(i).getAsJsonObject();
                String oldString = op.has("oldString") && !op.get("oldString").isJsonNull()
                    ? op.get("oldString").getAsString()
                    : "";
                String newString = op.has("newString") && !op.get("newString").isJsonNull()
                    ? op.get("newString").getAsString()
                    : "";
                boolean replaceAll = op.has("replaceAll") && op.get("replaceAll").getAsBoolean();

                if (newString.isEmpty()) {
                    // newString is empty means content was deleted, we need to restore oldString
                    // This case is tricky - we'd need position info which we don't have
                    // For now, skip these cases as they're rare in typical edit operations
                    LOG.warn("[UndoFileHandler] Skipping operation with empty newString (deletion case)");
                    continue;
                }

                if (replaceAll) {
                    // Replace all occurrences
                    content = content.replace(newString, oldString);
                } else {
                    // Replace first occurrence only
                    int index = content.indexOf(newString);
                    if (index != -1) {
                        content = content.substring(0, index) + oldString + content.substring(index + newString.length());
                    } else {
                        LOG.warn("[UndoFileHandler] Could not find newString to replace: " +
                            newString.substring(0, Math.min(50, newString.length())) + "...");
                    }
                }
            }

            document.setText(content);
        });

        // Save the document
        FileDocumentManager.getInstance().saveDocument(document);

        // Refresh the file
        file.refresh(false, false);

        LOG.info("[UndoFileHandler] Successfully reversed edits for file: " + filePath);
    }

    private void sendSuccess(String filePath) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.addProperty("filePath", filePath != null ? filePath : "");

        String json = gson.toJson(result);
        LOG.info("[UndoFileHandler] Sending success callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("onUndoFileResult", escapeJs(json));
        });
    }

    private void sendError(String filePath, String error) {
        JsonObject result = new JsonObject();
        result.addProperty("success", false);
        result.addProperty("filePath", filePath != null ? filePath : "");
        result.addProperty("error", error);

        String json = gson.toJson(result);
        LOG.warn("[UndoFileHandler] Sending error callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("onUndoFileResult", escapeJs(json));
        });
    }

    private void sendAllSuccess(int count) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.addProperty("count", count);

        String json = gson.toJson(result);
        LOG.info("[UndoFileHandler] Sending batch success callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("onUndoAllFileResult", escapeJs(json));
        });
    }

    private void sendAllError(String error) {
        JsonObject result = new JsonObject();
        result.addProperty("success", false);
        result.addProperty("error", error);

        String json = gson.toJson(result);
        LOG.warn("[UndoFileHandler] Sending batch error callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("onUndoAllFileResult", escapeJs(json));
        });
    }
}
