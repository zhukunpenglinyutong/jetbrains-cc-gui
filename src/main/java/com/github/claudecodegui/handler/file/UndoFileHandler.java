package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.UndoOperationApplier;

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
import java.nio.file.Files;
import java.nio.file.Path;

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
                        // Added file: delete it only when every operation is rollback-safe
                        if (hasUnsafeOperation(operations)) {
                            sendError(filePath, "Operation is marked unsafe to rollback");
                            return;
                        }
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
                JsonArray succeededFiles = new JsonArray();
                JsonArray failedFiles = new JsonArray();
                StringBuilder errors = new StringBuilder();

                for (int i = 0; i < files.size(); i++) {
                    JsonObject fileObj = files.get(i).getAsJsonObject();
                    String filePath = fileObj.has("filePath") ? fileObj.get("filePath").getAsString() : null;
                    String status = fileObj.has("status") ? fileObj.get("status").getAsString() : null;
                    JsonArray operations = fileObj.has("operations") ? fileObj.getAsJsonArray("operations") : null;

                    if (filePath == null || filePath.isEmpty()) {
                        failCount++;
                        String message = "Missing path";
                        errors.append("File ").append(i).append(": ").append(message).append("; ");
                        failedFiles.add(failureObject(filePath, "missing_path", message));
                        continue;
                    }

                    // Security: Validate file path
                    if (!isValidFilePath(filePath)) {
                        failCount++;
                        String message = "Invalid path (outside project)";
                        errors.append(filePath).append(": ").append(message).append("; ");
                        failedFiles.add(failureObject(filePath, "invalid_path", message));
                        continue;
                    }

                    try {
                        if ("A".equals(status)) {
                            // Added file: delete it only when every operation is rollback-safe
                            if (hasUnsafeOperation(operations)) {
                                throw new UnsafeRollbackException("Operation is marked unsafe to rollback");
                            }
                            deleteFile(filePath);
                        } else if ("M".equals(status)) {
                            // Modified file: reverse the edits
                            if (operations == null || operations.isEmpty()) {
                                throw new Exception("No operations to undo");
                            }
                            reverseEdits(filePath, operations);
                        } else {
                            throw new Exception("Unknown file status: " + status);
                        }
                        successCount++;
                        succeededFiles.add(filePath);
                        LOG.info("[UndoFileHandler] Successfully undone: " + filePath);
                    } catch (Exception e) {
                        failCount++;
                        String reason = e instanceof UnsafeRollbackException ? "unsafe_to_rollback" : "undo_failed";
                        errors.append(filePath).append(": ").append(e.getMessage()).append("; ");
                        failedFiles.add(failureObject(filePath, reason, e.getMessage()));
                        LOG.error("[UndoFileHandler] Failed to undo " + filePath + ": " + e.getMessage(), e);
                    }
                }

                if (failCount == 0) {
                    sendAllResult(true, false, successCount, succeededFiles, failedFiles, null);
                } else if (successCount > 0) {
                    sendAllResult(false, true, successCount, succeededFiles, failedFiles, errors.toString());
                } else {
                    sendAllResult(false, false, successCount, succeededFiles, failedFiles, errors.toString());
                }
            });

        } catch (Exception e) {
            LOG.error("[UndoFileHandler] Failed to parse batch undo request: " + e.getMessage(), e);
            sendAllError("Invalid request: " + e.getMessage());
        }
    }

    static boolean hasUnsafeOperation(JsonArray operations) {
        if (operations == null || operations.isEmpty()) {
            return false;
        }
        for (int i = 0; i < operations.size(); i++) {
            if (!operations.get(i).isJsonObject()) {
                continue;
            }
            JsonObject operation = operations.get(i).getAsJsonObject();
            Boolean safeToRollback = getOptionalBoolean(operation, "safeToRollback", "safe_to_rollback");
            if (Boolean.FALSE.equals(safeToRollback)) {
                return true;
            }
        }
        return false;
    }

    private static Boolean getOptionalBoolean(JsonObject object, String camelName, String snakeName) {
        if (object == null) {
            return null;
        }
        try {
            if (object.has(camelName) && !object.get(camelName).isJsonNull()) {
                return object.get(camelName).getAsBoolean();
            }
            if (object.has(snakeName) && !object.get(snakeName).isJsonNull()) {
                return object.get(snakeName).getAsBoolean();
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }

    private static final class UnsafeRollbackException extends Exception {
        private UnsafeRollbackException(String message) {
            super(message);
        }
    }

    private void deleteFile(String filePath) throws Exception {
        String normalizedPath = filePath.replace('\\', '/');
        LocalFileSystem localFileSystem = LocalFileSystem.getInstance();
        VirtualFile file = localFileSystem.refreshAndFindFileByPath(normalizedPath);
        Path nioPath = Path.of(filePath);
        if (file == null || !file.exists()) {
            if (!Files.exists(nioPath)) {
                LOG.warn("[UndoFileHandler] File not found for deletion: " + filePath);
                return;
            }
            try {
                Files.delete(nioPath);
                localFileSystem.refreshAndFindFileByPath(normalizedPath);
                if (Files.exists(nioPath)) {
                    throw new IOException("File still exists after delete");
                }
                LOG.info("[UndoFileHandler] Successfully deleted file via filesystem fallback: " + filePath);
                return;
            } catch (IOException e) {
                throw new Exception("Failed to delete file: " + e.getMessage(), e);
            }
        }

        final java.util.concurrent.atomic.AtomicReference<Exception> exceptionRef = new java.util.concurrent.atomic.AtomicReference<>();

        WriteCommandAction.runWriteCommandAction(context.getProject(), "Undo Claude: Delete File", null, () -> {
            try {
                file.delete(this);
                LOG.info("[UndoFileHandler] Successfully deleted file: " + filePath);
            } catch (IOException e) {
                exceptionRef.set(e);
            }
        });

        Exception ex = exceptionRef.get();
        if (ex != null) {
            throw new Exception("Failed to delete file: " + ex.getMessage(), ex);
        }
        if (Files.exists(nioPath)) {
            throw new Exception("Failed to delete file: file still exists after deletion");
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

        String content = document.getText();
        UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits(content, operations);
        if (!result.isSuccess()) {
            throw new Exception(result.toErrorMessage());
        }

        WriteCommandAction.runWriteCommandAction(context.getProject(), "Undo Claude Changes", null, () -> {
            document.setText(result.getContent());
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

    private JsonObject failureObject(String filePath, String reason, String message) {
        JsonObject failure = new JsonObject();
        failure.addProperty("filePath", filePath != null ? filePath : "");
        failure.addProperty("reason", reason);
        failure.addProperty("message", message);
        return failure;
    }

    private void sendAllResult(
        boolean success,
        boolean partial,
        int count,
        JsonArray succeededFiles,
        JsonArray failedFiles,
        String error
    ) {
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        result.addProperty("partial", partial);
        result.addProperty("count", count);
        result.add("succeededFiles", succeededFiles);
        result.add("failedFiles", failedFiles);
        if (error != null && !error.isEmpty()) {
            result.addProperty("error", error);
        }

        String json = gson.toJson(result);
        LOG.info("[UndoFileHandler] Sending batch undo callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            callJavaScript("onUndoAllFileResult", escapeJs(json));
        });
    }

    private void sendAllError(String error) {
        sendAllResult(false, false, 0, new JsonArray(), new JsonArray(), error);
    }
}
