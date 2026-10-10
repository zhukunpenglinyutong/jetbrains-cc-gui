package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.util.WslPathUtil;
import com.github.claudecodegui.util.FileChangeUndoPlan;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.Application;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.util.Computable;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.List;

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

    /** Creates the session file undo handler. */
    public UndoFileHandler(HandlerContext context) {
        super(context);
    }

    /** Returns the supported undo requests. */
    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    /** Routes single-file and batch undo requests. */
    @Override
    public boolean handle(String type, String content) {
        if ("undo_file_changes".equals(type)) {
            LOG.info("[UndoFileHandler] Handling: undo_file_changes");
            this.handleUndoFileChanges(content);
            return true;
        } else if ("undo_all_file_changes".equals(type)) {
            LOG.info("[UndoFileHandler] Handling: undo_all_file_changes");
            this.handleUndoAllFileChanges(content);
            return true;
        }
        return false;
    }

    private boolean isValidFilePath(String filePath) {
        String projectBasePath = this.context.getProject() != null ? this.context.getProject().getBasePath() : null;
        if (projectBasePath == null) {
            LOG.warn("[UndoFileHandler] Cannot validate path: project base path is null");
            return false;
        }
        String resolved = this.resolveFilePath(filePath);
        boolean isValid = WslPathUtil.isPathWithinDirectory(resolved, projectBasePath) && !Files.isDirectory(Path.of(resolved))
                && !Path.of(resolved).normalize().equals(Path.of(WslPathUtil.toVfsPath(projectBasePath)).normalize());
        if (!isValid) {
            LOG.warn("[UndoFileHandler] File path outside project directory: " + filePath);
        }
        return isValid;
    }

    private void handleUndoFileChanges(String content) {
        try {
            JsonObject request = this.gson.fromJson(content, JsonObject.class);
            String filePath = request.has("filePath") ? request.get("filePath").getAsString() : null;
            JsonObject reviewOrigin = this.readReviewOrigin(request);
            // A reviewed diff keeps its browser identity while its filesystem target is already absolute.
            String resultFilePath = request.has("resultFilePath") && !request.get("resultFilePath").isJsonNull()
                    ? request.get("resultFilePath").getAsString() : filePath;
            String status = request.has("status") ? request.get("status").getAsString() : null;
            JsonArray operations = request.has("operations") ? request.getAsJsonArray("operations") : null;

            if (filePath == null || filePath.isEmpty()) {
                this.sendError(resultFilePath, "File path is required", reviewOrigin);
                return;
            }

            String workingDirectory = this.resolveUndoDirectory();
            String undoPath = this.resolveFilePath(filePath, workingDirectory);
            // Validate the same target that the deferred write will use.
            if (!this.isValidFilePath(undoPath)) {
                this.sendError(resultFilePath, "Invalid file path: path must be within project directory", reviewOrigin);
                return;
            }

            if (status == null || status.isEmpty()) {
                this.sendError(resultFilePath, "File status is required", reviewOrigin);
                return;
            }

            LOG.info("[UndoFileHandler] Undoing changes for file: " + filePath + ", status: " + status);

            // Disk IO and plan computation stay off the EDT; only document writes
            // and VFS deletes hop to the EDT via runEdtWrite.
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    if (this.hasNativeOperations(operations)) {
                        this.restoreNativeEdits(undoPath, status, this.resolveOperationPaths(operations, workingDirectory));
                    } else if ("A".equals(status)) {
                        // Added file: delete it
                        this.deleteFile(undoPath);
                    } else if ("M".equals(status)) {
                        // Modified file: reverse the edits
                        if (operations == null || operations.isEmpty()) {
                            this.sendError(resultFilePath, "No operations to undo", reviewOrigin);
                            return;
                        }
                        this.reverseEdits(undoPath, operations);
                    } else {
                        this.sendError(resultFilePath, "Unknown file status: " + status, reviewOrigin);
                        return;
                    }

                    // Send success callback
                    this.sendSuccess(resultFilePath, reviewOrigin);

                } catch (Exception e) {
                    LOG.error("[UndoFileHandler] Failed to undo file changes: " + e.getMessage(), e);
                    this.sendError(resultFilePath, e.getMessage(), reviewOrigin);
                }
            });

        } catch (Exception e) {
            LOG.error("[UndoFileHandler] Failed to parse undo request: " + e.getMessage(), e);
            this.sendError(null, "Invalid request: " + e.getMessage());
        }
    }

    private void handleUndoAllFileChanges(String content) {
        try {
            JsonObject request = gson.fromJson(content, JsonObject.class);
            JsonArray files = request.has("files") ? request.getAsJsonArray("files") : null;

            if (files == null || files.isEmpty()) {
                this.sendAllError("No files to undo");
                return;
            }

            LOG.info("[UndoFileHandler] Undoing changes for " + files.size() + " files");
            String workingDirectory = this.resolveUndoDirectory();
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                int successCount = 0;
                int failCount = 0;
                JsonArray successfulFiles = new JsonArray();
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

                    String undoPath = this.resolveFilePath(filePath, workingDirectory);
                    // Session selection can change while this work waits for the EDT.
                    if (!this.isValidFilePath(undoPath)) {
                        failCount++;
                        errors.append(filePath).append(": Invalid path (outside project); ");
                        continue;
                    }

                    try {
                        if (this.hasNativeOperations(operations)) {
                            this.restoreNativeEdits(undoPath, status, this.resolveOperationPaths(operations, workingDirectory));
                        } else if ("A".equals(status)) {
                            // Added file: delete it
                            this.deleteFile(undoPath);
                        } else if ("M".equals(status)) {
                            // Modified file: reverse the edits
                            this.reverseEdits(undoPath, operations);
                        } else {
                            throw new IllegalArgumentException("Unknown file status: " + status);
                        }
                        successCount++;
                        successfulFiles.add(filePath);
                        LOG.info("[UndoFileHandler] Successfully undone: " + filePath);
                    } catch (Exception e) {
                        failCount++;
                        errors.append(filePath).append(": ").append(e.getMessage()).append("; ");
                        LOG.error("[UndoFileHandler] Failed to undo " + filePath + ": " + e.getMessage(), e);
                    }
                }

                if (failCount == 0) {
                    this.sendAllSuccess(successCount);
                } else {
                    this.sendAllError(errors.toString(), successfulFiles);
                }
            });

        } catch (Exception e) {
            LOG.error("[UndoFileHandler] Failed to parse batch undo request: " + e.getMessage(), e);
            this.sendAllError("Invalid request: " + e.getMessage());
        }
    }

    void deleteFile(String filePath) throws Exception {
        VirtualFile file = LocalFileSystem.getInstance().findFileByPath(WslPathUtil.toVfsPath(filePath));
        if (file == null || !file.exists()) {
            LOG.warn("[UndoFileHandler] File not found for deletion: " + filePath);
            // File already doesn't exist, treat as success
            return;
        }

        // Use AtomicReference to capture exception from lambda
        final java.util.concurrent.atomic.AtomicReference<Exception> exceptionRef = new java.util.concurrent.atomic.AtomicReference<>();

        this.runEdtWrite("Undo File Creation", () -> {
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
        VirtualFile file = LocalFileSystem.getInstance().findFileByPath(WslPathUtil.toVfsPath(filePath));
        if (file == null || !file.exists()) {
            throw new Exception("File not found: " + filePath);
        }

        Document document = FileDocumentManager.getInstance().getDocument(file);
        if (document == null) {
            throw new Exception("Cannot get document for: " + filePath);
        }

        // Document reads need a read lock; plan computation stays off the EDT.
        String currentText = ApplicationManager.getApplication().runReadAction((Computable<String>) document::getText);
        String baseline = FileChangeUndoPlan.rebuild(filePath, currentText, operations).content();
        this.runEdtWrite("Undo Session Changes", () -> {
            document.setText(baseline);
            FileDocumentManager.getInstance().saveDocument(document);
        });

        // Refresh the file
        file.refresh(false, false);

        LOG.info("[UndoFileHandler] Successfully reversed edits for file: " + filePath);
    }

    private String resolveFilePath(String filePath) {
        return this.resolveFilePath(filePath, this.resolveUndoDirectory());
    }

    private String resolveUndoDirectory() {
        var session = this.context.getSession();
        String cwd = session == null ? null : session.getCwd();
        return cwd == null || cwd.isBlank() ? this.context.getProject().getBasePath() : cwd;
    }

    private String resolveFilePath(String filePath, String workingDirectory) {
        Path path = Path.of(WslPathUtil.toVfsPath(filePath));
        if (!path.isAbsolute()) {
            path = Path.of(WslPathUtil.toVfsPath(workingDirectory)).resolve(path);
        }
        return path.normalize().toString();
    }

    private JsonArray resolveOperationPaths(JsonArray operations, String workingDirectory) {
        JsonArray resolved = operations.deepCopy();
        for (var element : resolved) {
            if (element.isJsonObject()) {
                JsonObject operation = element.getAsJsonObject();
                if (operation.has("moveFrom") && !operation.get("moveFrom").isJsonNull()) {
                    operation.addProperty("moveFrom", this.resolveFilePath(operation.get("moveFrom").getAsString(), workingDirectory));
                }
            }
        }
        return resolved;
    }

    private boolean hasNativeOperations(JsonArray operations) {
        if (operations == null) {
            return false;
        }
        for (var element : operations) {
            if (element.isJsonObject() && element.getAsJsonObject().has("fileChangeKind")) {
                return true;
            }
        }
        return false;
    }

    private void restoreNativeEdits(String filePath, String status, JsonArray operations) throws Exception {
        if (!List.of("A", "M", "D", "R").contains(status == null ? "" : status)) {
            throw new IllegalArgumentException("Unknown file status: " + status);
        }
        JsonArray resolvedOps = operations.deepCopy();
        for (var element : resolvedOps) {
            JsonObject op = element.getAsJsonObject();
            if (op.has("moveFrom") && !op.get("moveFrom").isJsonNull()) {
                String source = op.get("moveFrom").getAsString();
                if (!this.isValidFilePath(source)) {
                    throw new IllegalArgumentException("Rename source is outside the project directory");
                }
                op.addProperty("moveFrom", this.resolveFilePath(source));
            }
        }
        Path currentPath = Path.of(this.resolveFilePath(filePath));
        VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(WslPathUtil.toVfsPath(currentPath.toString()));
        Charset charset = file == null || file.getCharset() == null ? StandardCharsets.UTF_8 : file.getCharset();
        Document document = file == null ? null : FileDocumentManager.getInstance().getDocument(file);
        // Disk reads stay off the EDT; document reads take a read lock.
        String currentContent = document != null
                ? ApplicationManager.getApplication().runReadAction((Computable<String>) document::getText)
                : Files.exists(currentPath) ? Files.readString(currentPath, charset) : null;
        FileChangeUndoPlan plan = FileChangeUndoPlan.rebuild(currentPath.toString(), currentContent, resolvedOps);
        Path originalPath = Path.of(plan.filePath());
        if (!this.isValidFilePath(plan.filePath())) {
            throw new IllegalArgumentException("Baseline path is outside the project directory");
        }
        if (plan.content() != null && !originalPath.equals(currentPath) && Files.exists(originalPath)) {
            throw new IOException("Cannot restore rename: original path is occupied");
        }
        boolean rename = !originalPath.equals(currentPath);
        if (rename && document != null && FileDocumentManager.getInstance().isDocumentUnsaved(document)) {
            // Deleting the current path would silently discard the unsaved buffer,
            // and a later save would resurrect the renamed-away file.
            throw new IOException("Cannot undo the rename while the file has unsaved changes in the editor: " + currentPath);
        }
        if (!rename && plan.content() != null && document != null) {
            this.runEdtWrite("Undo Session Changes", () -> {
                document.setText(plan.content());
                FileDocumentManager.getInstance().saveDocument(document);
            });
        } else {
            this.restoreFileBaseline(currentPath, originalPath, plan.content(), charset);
        }
        LocalFileSystem.getInstance().refreshAndFindFileByPath(WslPathUtil.toVfsPath(originalPath.toString()));
        if (file != null) {
            file.refresh(false, false);
        }
    }

    private void restoreFileBaseline(Path current, Path original, String content, Charset charset) throws Exception {
        if (content == null) {
            this.deleteFile(current.toString());
            return;
        }
        if (current.equals(original)) {
            Files.createDirectories(original.getParent());
            Files.writeString(original, content, charset);
            return;
        }
        // Keep the current file until the original has been fully restored.
        // CREATE_NEW also protects against a concurrently recreated source.
        Files.createDirectories(original.getParent());
        Files.writeString(original, content, charset, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        try {
            this.deleteDiskFile(current);
        } catch (IOException failure) {
            Files.deleteIfExists(original);
            throw failure;
        }
    }

    /**
     * Runs a write action on the EDT while the caller stays on a background
     * thread, keeping disk IO and plan computation off the UI thread.
     */
    private void runEdtWrite(String commandName, Runnable action) {
        Application application = ApplicationManager.getApplication();
        Runnable write = () -> WriteCommandAction.runWriteCommandAction(this.context.getProject(), commandName, null, action);
        if (application.isDispatchThread()) {
            write.run();
        } else {
            application.invokeAndWait(write);
        }
    }

    /**
     * Deletes through the VFS when possible so open editors close instead of
     * resurrecting the file on the next save; falls back to plain Files when
     * the IDE or the VFS entry is unavailable.
     */
    private void deleteDiskFile(Path path) throws IOException {
        Application application = ApplicationManager.getApplication();
        VirtualFile file = application == null ? null
                : LocalFileSystem.getInstance().findFileByPath(WslPathUtil.toVfsPath(path.toString()));
        if (application == null || file == null || !file.exists()) {
            Files.deleteIfExists(path);
            return;
        }
        java.util.concurrent.atomic.AtomicReference<IOException> failureRef = new java.util.concurrent.atomic.AtomicReference<>();
        this.runEdtWrite("Undo File Rename", () -> {
            try {
                file.delete(this);
            } catch (IOException e) {
                failureRef.set(e);
            }
        });
        if (failureRef.get() != null) {
            throw failureRef.get();
        }
    }

    private JsonObject readReviewOrigin(JsonObject request) {
        if (!request.has("sessionId")) {
            return null;
        }
        JsonObject origin = new JsonObject();
        for (String field : List.of("sessionId", "provider", "ledgerKeys")) {
            if (request.has(field)) {
                origin.add(field, request.get(field).deepCopy());
            }
        }
        return origin;
    }

    private void sendSuccess(String filePath, JsonObject reviewOrigin) {
        JsonObject result = reviewOrigin == null ? new JsonObject() : reviewOrigin.deepCopy();
        result.addProperty("success", true);
        result.addProperty("filePath", filePath != null ? filePath : "");

        String json = result.toString();
        LOG.info("[UndoFileHandler] Sending success callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            this.callJavaScript("onUndoFileResult", this.escapeJs(json));
        });
    }

    private void sendError(String filePath, String error) {
        this.sendError(filePath, error, null);
    }

    private void sendError(String filePath, String error, JsonObject reviewOrigin) {
        JsonObject result = reviewOrigin == null ? new JsonObject() : reviewOrigin.deepCopy();
        result.addProperty("success", false);
        result.addProperty("filePath", filePath != null ? filePath : "");
        result.addProperty("error", error);

        String json = result.toString();
        LOG.warn("[UndoFileHandler] Sending error callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            this.callJavaScript("onUndoFileResult", this.escapeJs(json));
        });
    }

    private void sendAllSuccess(int count) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.addProperty("count", count);

        String json = gson.toJson(result);
        LOG.info("[UndoFileHandler] Sending batch success callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            this.callJavaScript("onUndoAllFileResult", this.escapeJs(json));
        });
    }

    private void sendAllError(String error) {
        this.sendAllError(error, new JsonArray());
    }

    private void sendAllError(String error, JsonArray successfulFiles) {
        JsonObject result = new JsonObject();
        result.addProperty("success", false);
        result.addProperty("error", error);
        result.add("successfulFiles", successfulFiles);

        String json = gson.toJson(result);
        LOG.warn("[UndoFileHandler] Sending batch error callback: " + json);

        ApplicationManager.getApplication().invokeLater(() -> {
            this.callJavaScript("onUndoAllFileResult", this.escapeJs(json));
        });
    }
}
