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
import com.intellij.openapi.progress.ProgressIndicator;
import com.intellij.openapi.progress.ProgressManager;
import com.intellij.openapi.progress.Task;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import org.jetbrains.annotations.NotNull;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

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

    interface BatchUndoAction {
        String filePath();
        default String requestFilePath() {
            return filePath();
        }
        void apply() throws Exception;
        void rollback() throws Exception;
        default void afterCommit() throws Exception {
        }
    }

    record BatchUndoExecution(boolean success, int appliedCount, String error) {
    }

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
    private java.util.Optional<Path> resolveProjectPath(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return java.util.Optional.empty();
        }
        String projectBasePath = context.getProject() != null ? context.getProject().getBasePath() : null;
        if (projectBasePath == null) {
            LOG.warn("[UndoFileHandler] Cannot validate path: project base path is null");
            return java.util.Optional.empty();
        }

        try {
            Path basePath = Path.of(projectBasePath).toRealPath().normalize();
            Path inputPath = Path.of(filePath);
            Path requestedPath = (inputPath.isAbsolute() ? inputPath : basePath.resolve(inputPath)).toAbsolutePath().normalize();
            if (!isWithin(basePath, requestedPath) || hasSymlinkSegment(basePath, requestedPath)) {
                LOG.warn("[UndoFileHandler] Refusing unsafe file path: " + filePath + " (requested: " + requestedPath + ")");
                return java.util.Optional.empty();
            }
            Path resolvedPath = resolveExistingOrParent(requestedPath);
            if (!isWithin(basePath, resolvedPath)) {
                LOG.warn("[UndoFileHandler] File path outside project directory: " + filePath
                    + " (resolved: " + resolvedPath + ", base: " + basePath + ")");
                return java.util.Optional.empty();
            }
            return java.util.Optional.of(resolvedPath);
        } catch (IOException e) {
            LOG.warn("[UndoFileHandler] Failed to validate path: " + e.getMessage());
            return java.util.Optional.empty();
        } catch (Exception e) {
            LOG.warn("[UndoFileHandler] Failed to validate path: " + filePath, e);
            return java.util.Optional.empty();
        }
    }

    private static Path resolveExistingOrParent(Path requestedPath) throws IOException {
        if (Files.exists(requestedPath)) {
            return requestedPath.toRealPath().normalize();
        }
        Path parent = requestedPath.getParent();
        if (parent != null && Files.exists(parent)) {
            return parent.toRealPath().resolve(requestedPath.getFileName()).normalize();
        }
        return requestedPath.toAbsolutePath().normalize();
    }

    private static boolean hasSymlinkSegment(Path basePath, Path requestedPath) {
        try {
            Path relative = basePath.relativize(requestedPath);
            Path current = basePath;
            for (Path part : relative) {
                current = current.resolve(part);
                if (Files.exists(current, LinkOption.NOFOLLOW_LINKS) && Files.isSymbolicLink(current)) {
                    return true;
                }
            }
        } catch (Exception e) {
            return true;
        }
        return false;
    }

    private static boolean isWithin(Path basePath, Path candidatePath) {
        Path normalizedBase = basePath.normalize();
        Path normalizedCandidate = candidatePath.normalize();
        if (System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win")) {
            String baseText = normalizedBase.toString().toLowerCase(java.util.Locale.ROOT);
            String candidateText = normalizedCandidate.toString().toLowerCase(java.util.Locale.ROOT);
            return candidateText.equals(baseText) || candidateText.startsWith(baseText + java.io.File.separator);
        }
        return normalizedCandidate.startsWith(normalizedBase);
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

            java.util.Optional<Path> safePath = resolveProjectPath(filePath);
            if (safePath.isEmpty()) {
                sendError(filePath, "Invalid file path: path must be within project directory");
                return;
            }
            String resolvedFilePath = safePath.get().toString();

            if (status == null || status.isEmpty()) {
                sendError(resolvedFilePath, "File status is required");
                return;
            }

            LOG.info("[UndoFileHandler] Undoing changes for file: " + resolvedFilePath + ", status: " + status);
            String requestFilePath = filePath;

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    if ("A".equals(status)) {
                        // Added file: delete it only when every operation is rollback-safe
                        if (hasUnsafeOperation(operations)) {
                            sendError(resolvedFilePath, "Operation is marked unsafe to rollback");
                            return;
                        }
                        validateExpectedAfterHash(resolvedFilePath, operations);
                        deleteFile(resolvedFilePath);
                    } else if ("M".equals(status)) {
                        // Modified file: reverse the edits
                        if (operations == null || operations.isEmpty()) {
                            sendError(resolvedFilePath, "No operations to undo");
                            return;
                        }
                        reverseEdits(resolvedFilePath, operations);
                    } else {
                        sendError(resolvedFilePath, "Unknown file status: " + status);
                        return;
                    }

                    // Send success callback
                    sendSuccess(resolvedFilePath, requestFilePath);

                } catch (Exception e) {
                    LOG.error("[UndoFileHandler] Failed to undo file changes: " + e.getMessage(), e);
                    sendError(resolvedFilePath, e.getMessage());
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

            ProgressManager.getInstance().run(new Task.Backgroundable(context.getProject(), "Undo Claude Changes", false) {
                @Override
                public void run(@NotNull ProgressIndicator indicator) {
                    executeUndoAllFileChanges(files, indicator);
                }
            });

        } catch (Exception e) {
            LOG.error("[UndoFileHandler] Failed to parse batch undo request: " + e.getMessage(), e);
            sendAllError("Invalid request: " + e.getMessage());
        }
    }

    private void executeUndoAllFileChanges(JsonArray files, ProgressIndicator indicator) {
        int failCount = 0;
        JsonArray failedFiles = new JsonArray();
        StringBuilder errors = new StringBuilder();
        List<BatchUndoAction> actions = new ArrayList<>();

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

            java.util.Optional<Path> safePath = resolveProjectPath(filePath);
            if (safePath.isEmpty()) {
                failCount++;
                String message = "Invalid path (outside project)";
                errors.append(filePath).append(": ").append(message).append("; ");
                failedFiles.add(failureObject(filePath, "invalid_path", message));
                continue;
            }
            String resolvedFilePath = safePath.get().toString();

            try {
                actions.add(createBatchUndoAction(resolvedFilePath, filePath, status, operations));
            } catch (Exception e) {
                failCount++;
                String reason = e instanceof UnsafeRollbackException ? "unsafe_to_rollback" : "undo_failed";
                errors.append(resolvedFilePath).append(": ").append(e.getMessage()).append("; ");
                failedFiles.add(failureObject(resolvedFilePath, reason, e.getMessage()));
                LOG.error("[UndoFileHandler] Failed to prepare undo " + resolvedFilePath + ": " + e.getMessage(), e);
            }
        }

        if (failCount > 0) {
            sendAllResult(false, false, 0, new JsonArray(), failedFiles, errors.toString());
            return;
        }

        BatchUndoExecution execution = executeBatchUndoActions(actions, indicator);
        JsonArray succeededFiles = new JsonArray();
        if (execution.success()) {
            for (BatchUndoAction action : actions) {
                succeededFiles.add(action.requestFilePath());
            }
            sendAllResult(true, false, actions.size(), succeededFiles, failedFiles, null);
        } else {
            String message = execution.error() != null ? execution.error() : "Batch undo failed";
            failedFiles.add(failureObject("", "undo_failed", message));
            sendAllResult(false, execution.appliedCount() > 0, execution.appliedCount(), succeededFiles, failedFiles, message);
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

    static BatchUndoExecution executeBatchUndoActions(List<? extends BatchUndoAction> actions, ProgressIndicator indicator) {
        if (actions == null || actions.isEmpty()) {
            return new BatchUndoExecution(true, 0, null);
        }
        List<BatchUndoAction> applied = new ArrayList<>();
        try {
            int total = actions.size();
            for (int i = 0; i < total; i++) {
                if (indicator != null) {
                    indicator.checkCanceled();
                    indicator.setText("Undoing file changes");
                    indicator.setText2(actions.get(i).filePath());
                    indicator.setFraction((double) i / total);
                }
                BatchUndoAction action = actions.get(i);
                action.apply();
                applied.add(action);
            }
            if (indicator != null) {
                indicator.setFraction(1.0);
            }
        } catch (Exception applyError) {
            List<String> rollbackErrors = new ArrayList<>();
            for (int i = applied.size() - 1; i >= 0; i--) {
                BatchUndoAction action = applied.get(i);
                try {
                    action.rollback();
                } catch (Exception rollbackError) {
                    rollbackErrors.add(action.filePath() + ": " + rollbackError.getMessage());
                    LOG.warn("[UndoFileHandler] Failed to rollback batch undo action for " + action.filePath(), rollbackError);
                }
            }
            String message = applyError.getMessage();
            if (!rollbackErrors.isEmpty()) {
                message += "; rollback failures: " + String.join("; ", rollbackErrors);
            }
            return new BatchUndoExecution(false, applied.size(), message);
        }
        for (BatchUndoAction action : applied) {
            try {
                action.afterCommit();
            } catch (Exception cleanupError) {
                LOG.warn("[UndoFileHandler] Failed to cleanup after batch undo action for " + action.filePath(), cleanupError);
            }
        }
        return new BatchUndoExecution(true, applied.size(), null);
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

    private record DocumentSnapshot(VirtualFile file, Document document, String content) {
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    @FunctionalInterface
    private interface ThrowingSupplier<T> {
        T get() throws Exception;
    }

    private static void runOnEdtAndWait(ThrowingRunnable runnable) throws Exception {
        if (ApplicationManager.getApplication().isDispatchThread()) {
            runnable.run();
            return;
        }
        AtomicReference<Exception> exceptionRef = new AtomicReference<>();
        ApplicationManager.getApplication().invokeAndWait(() -> {
            try {
                runnable.run();
            } catch (Exception e) {
                exceptionRef.set(e);
            }
        });
        Exception exception = exceptionRef.get();
        if (exception != null) {
            throw exception;
        }
    }

    private static <T> T callOnEdtAndWait(ThrowingSupplier<T> supplier) throws Exception {
        if (ApplicationManager.getApplication().isDispatchThread()) {
            return supplier.get();
        }
        AtomicReference<T> resultRef = new AtomicReference<>();
        AtomicReference<Exception> exceptionRef = new AtomicReference<>();
        ApplicationManager.getApplication().invokeAndWait(() -> {
            try {
                resultRef.set(supplier.get());
            } catch (Exception e) {
                exceptionRef.set(e);
            }
        });
        Exception exception = exceptionRef.get();
        if (exception != null) {
            throw exception;
        }
        return resultRef.get();
    }

    private void deleteFile(String filePath) throws Exception {
        String normalizedPath = filePath.replace('\\', '/');
        LocalFileSystem localFileSystem = LocalFileSystem.getInstance();
        VirtualFile file = localFileSystem.refreshAndFindFileByPath(normalizedPath);
        Path nioPath = Path.of(filePath);
        if (Files.isSymbolicLink(nioPath)) {
            throw new Exception("Refusing to delete symlink path");
        }
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

    private BatchUndoAction createBatchUndoAction(
            String filePath,
            String requestFilePath,
            String status,
            JsonArray operations
    ) throws Exception {
        if ("A".equals(status)) {
            if (hasUnsafeOperation(operations)) {
                throw new UnsafeRollbackException("Operation is marked unsafe to rollback");
            }
            Path path = Path.of(filePath);
            AtomicReference<Path> backupPathRef = new AtomicReference<>();
            return new BatchUndoAction() {
                @Override
                public String filePath() {
                    return filePath;
                }

                @Override
                public String requestFilePath() {
                    return requestFilePath != null ? requestFilePath : filePath;
                }

                @Override
                public void apply() throws Exception {
                    validateExpectedAfterHash(filePath, operations);
                    if (Files.isSymbolicLink(path)) {
                        throw new Exception("Refusing to undo symlink path");
                    }
                    if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                        return;
                    }
                    Path backupPath = createBackupTempPath();
                    Files.deleteIfExists(backupPath);
                    movePath(path, backupPath);
                    backupPathRef.set(backupPath);
                    LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                }

                @Override
                public void rollback() throws Exception {
                    Path backupPath = backupPathRef.get();
                    if (backupPath == null || !Files.exists(backupPath, LinkOption.NOFOLLOW_LINKS)
                            || Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
                        return;
                    }
                    Path parent = path.getParent();
                    if (parent != null) {
                        Files.createDirectories(parent);
                    }
                    movePath(backupPath, path);
                    LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                }

                @Override
                public void afterCommit() throws Exception {
                    Path backupPath = backupPathRef.get();
                    if (backupPath != null) {
                        Files.deleteIfExists(backupPath);
                    }
                }
            };
        }
        if ("M".equals(status)) {
            if (operations == null || operations.isEmpty()) {
                throw new Exception("No operations to undo");
            }
            if (Files.isSymbolicLink(Path.of(filePath))) {
                throw new Exception("Refusing to undo symlink path");
            }
            DocumentSnapshot snapshot = callOnEdtAndWait(() -> {
                VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                if (file == null || !file.exists()) {
                    throw new Exception("File not found: " + filePath);
                }
                Document document = FileDocumentManager.getInstance().getDocument(file);
                if (document == null) {
                    throw new Exception("Cannot get document for: " + filePath);
                }
                return new DocumentSnapshot(file, document, document.getText());
            });
            String originalContent = snapshot.content();
            UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits(originalContent, operations);
            if (!result.isSuccess()) {
                throw new Exception(result.toErrorMessage());
            }
            String revertedContent = result.getContent();
            return new BatchUndoAction() {
                @Override
                public String filePath() {
                    return filePath;
                }

                @Override
                public String requestFilePath() {
                    return requestFilePath != null ? requestFilePath : filePath;
                }

                @Override
                public void apply() throws Exception {
                    runOnEdtAndWait(() ->
                            WriteCommandAction.runWriteCommandAction(context.getProject(), "Undo Claude Changes", null, () ->
                                    snapshot.document().setText(revertedContent)
                            )
                    );
                }

                @Override
                public void rollback() throws Exception {
                    runOnEdtAndWait(() -> {
                        WriteCommandAction.runWriteCommandAction(context.getProject(), "Rollback Claude Batch Undo", null, () ->
                                snapshot.document().setText(originalContent)
                        );
                        FileDocumentManager.getInstance().saveDocument(snapshot.document());
                        snapshot.file().refresh(false, false);
                    }
                    );
                }

                @Override
                public void afterCommit() throws Exception {
                    runOnEdtAndWait(() -> {
                        FileDocumentManager.getInstance().saveDocument(snapshot.document());
                        snapshot.file().refresh(false, false);
                    });
                }
            };
        }
        throw new Exception("Unknown file status: " + status);
    }

    private static Path createBackupTempPath() throws IOException {
        return Files.createTempFile("cc-gui-undo-", ".bak");
    }

    private static void movePath(Path source, Path target) throws IOException {
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(source, target);
        }
    }

    private void validateExpectedAfterHash(String filePath, JsonArray operations) throws Exception {
        String expectedHash = firstExpectedAfterHash(operations);
        if (expectedHash == null) {
            return;
        }
        String content = readCurrentContentForHash(filePath);
        if (!expectedHash.equals(sha256(content))) {
            throw new Exception("content_changed: Current content no longer matches the captured LLM result");
        }
    }

    private String readCurrentContentForHash(String filePath) throws Exception {
        AtomicReference<String> documentTextRef = new AtomicReference<>();
        runOnEdtAndWait(() -> {
            VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
            if (file == null) {
                return;
            }
            Document document = FileDocumentManager.getInstance().getDocument(file);
            if (document != null) {
                documentTextRef.set(document.getText());
            }
        });
        String documentText = documentTextRef.get();
        if (documentText != null) {
            return documentText;
        }
        Path path = Path.of(filePath);
        if (Files.isSymbolicLink(path)) {
            throw new Exception("Refusing to read symlink path");
        }
        if (!Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return "";
        }
        try (InputStream inputStream = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            return new String(inputStream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String firstExpectedAfterHash(JsonArray operations) {
        if (operations == null) {
            return null;
        }
        for (int i = 0; i < operations.size(); i++) {
            if (!operations.get(i).isJsonObject()) {
                continue;
            }
            JsonObject operation = operations.get(i).getAsJsonObject();
            String hash = getOptionalString(operation, "expectedAfterContentHash", "expected_after_content_hash");
            if (hash != null && !hash.isBlank()) {
                return hash;
            }
        }
        return null;
    }

    private static String getOptionalString(JsonObject object, String camelName, String snakeName) {
        if (object == null) {
            return null;
        }
        try {
            if (object.has(camelName) && !object.get(camelName).isJsonNull()) {
                return object.get(camelName).getAsString();
            }
            if (object.has(snakeName) && !object.get(snakeName).isJsonNull()) {
                return object.get(snakeName).getAsString();
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }

    private static String sha256(String content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest((content != null ? content : "").getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            return Integer.toHexString((content != null ? content : "").hashCode());
        }
    }

    private void reverseEdits(String filePath, JsonArray operations) throws Exception {
        VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
        if (file == null || !file.exists()) {
            throw new Exception("File not found: " + filePath);
        }

        Document document = FileDocumentManager.getInstance().getDocument(file);
        if (document == null) {
            throw new Exception("Cannot get document for: " + filePath);
        }

        final java.util.concurrent.atomic.AtomicReference<Exception> exceptionRef = new java.util.concurrent.atomic.AtomicReference<>();

        WriteCommandAction.runWriteCommandAction(context.getProject(), "Undo Claude Changes", null, () -> {
            String content = document.getText();
            UndoOperationApplier.Result result = UndoOperationApplier.reverseEdits(content, operations);
            if (!result.isSuccess()) {
                exceptionRef.set(new Exception(result.toErrorMessage()));
                return;
            }
            document.setText(result.getContent());
        });

        Exception ex = exceptionRef.get();
        if (ex != null) {
            throw ex;
        }

        // Save the document
        FileDocumentManager.getInstance().saveDocument(document);

        // Refresh the file
        file.refresh(false, false);

        LOG.info("[UndoFileHandler] Successfully reversed edits for file: " + filePath);
    }

    private void sendSuccess(String filePath, String requestFilePath) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        result.addProperty("filePath", filePath != null ? filePath : "");
        result.addProperty("requestFilePath", requestFilePath != null ? requestFilePath : "");

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
