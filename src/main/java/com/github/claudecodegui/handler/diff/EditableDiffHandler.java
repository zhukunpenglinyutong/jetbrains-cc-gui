package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.ContentRebuildUtil;
import com.github.claudecodegui.util.FileChangeUndoPlan;
import com.github.claudecodegui.util.WslPathUtil;
import com.github.claudecodegui.handler.file.UndoFileHandler;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.command.WriteCommandAction;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.function.Consumer;

/**
 * Handles editable diff messages.
 */
public class EditableDiffHandler implements DiffActionHandler {

    private static final Logger LOG = Logger.getInstance(EditableDiffHandler.class);

    private final HandlerContext context;
    private final Gson gson;
    private final DiffBrowserBridge browserBridge;
    private final DiffFileOperations fileOperations;
    private final Consumer<JsonObject> undoSubmission;

    /** Creates an editable session diff handler. */
    public EditableDiffHandler(
            HandlerContext context,
            Gson gson,
            DiffBrowserBridge browserBridge,
            DiffFileOperations fileOperations
    ) {
        this(context, gson, browserBridge, fileOperations,
                request -> new UndoFileHandler(context).handle("undo_file_changes", request.toString()));
    }

    EditableDiffHandler(HandlerContext context, Gson gson, DiffBrowserBridge browserBridge,
                        DiffFileOperations fileOperations, Consumer<JsonObject> undoSubmission) {
        this.context = context;
        this.gson = gson;
        this.browserBridge = browserBridge;
        this.fileOperations = fileOperations;
        this.undoSubmission = undoSubmission;
    }

    private static final String[] TYPES = {"show_editable_diff"};

    /** Returns the editable diff request type. */
    @Override
    public String[] getSupportedTypes() {
        return TYPES;
    }

    /** Opens the recorded changes after validating their project scope. */
    @Override
    public void handle(String type, String content) {
        try {
            JsonObject json = this.gson.fromJson(content, JsonObject.class);
            String requestedPath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray suppliedOperations = json.has("operations") ? json.getAsJsonArray("operations") : new JsonArray();
            String status = json.has("status") ? json.get("status").getAsString() : "M";
            boolean nativePatch = this.hasNativeOperations(suppliedOperations);
            String workingDirectory = nativePatch ? this.resolveWorkingDirectory() : null;
            String filePath = nativePatch ? this.resolveFilePath(requestedPath, workingDirectory) : requestedPath;
            JsonArray operations = nativePatch ? this.freezeOperationPaths(suppliedOperations, workingDirectory) : suppliedOperations;
            JsonObject reviewOrigin = nativePatch ? this.captureReviewOrigin(operations) : null;

            if (!this.fileOperations.isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                return;
            }

            LOG.info("Showing editable diff for file: " + filePath + " with " + operations.size() + " operations, status: " + status);

            boolean isNewFile = "A".equals(status);
            if (!isNewFile && !(nativePatch && "D".equals(status))) {
                File file = new File(NodeDetector.toVfsPath(filePath));
                if (!file.exists()) {
                    LOG.warn("File does not exist: " + filePath);
                    this.browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.fileNotFoundDetail", filePath));
                    if (!nativePatch) {
                        this.browserBridge.sendRemoveFileFromEdits(filePath);
                    }
                    return;
                }
            }

            ApplicationManager.getApplication().invokeLater(() ->
                    this.showEditableDiff(filePath, requestedPath, operations, status, nativePatch, reviewOrigin));
        } catch (Exception e) {
            LOG.error("Failed to parse show_editable_diff request: " + e.getMessage(), e);
        }
    }

    void showEditableDiff(String filePath, String requestedPath, JsonArray operations, String status,
                          boolean nativePatch, JsonObject reviewOrigin) {
        try {
            boolean isNewFile = "A".equals(status);
            String currentContent = "";
            Charset charset = StandardCharsets.UTF_8;

            VirtualFile vFile = LocalFileSystem.getInstance().refreshAndFindFileByPath(NodeDetector.toVfsPath(filePath));
            if (vFile != null) {
                vFile.refresh(false, false);
                charset = vFile.getCharset() != null ? vFile.getCharset() : StandardCharsets.UTF_8;
                try {
                    Document document = nativePatch ? FileDocumentManager.getInstance().getDocument(vFile) : null;
                    currentContent = document == null ? new String(vFile.contentsToByteArray(), charset) : document.getText();
                } catch (IOException e) {
                    LOG.error("Failed to read file content: " + filePath, e);
                    this.browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.fileReadFailedDetail", e.getMessage()));
                    return;
                }
            }

            String originalContent = nativePatch
                    ? FileChangeUndoPlan.rebuild(filePath, vFile == null ? null : currentContent, operations).content()
                    : isNewFile
                    ? ""
                    : ContentRebuildUtil.rebuildBeforeContent(currentContent, operations);
            if (originalContent == null) {
                originalContent = "";
            }
            final String baselineContent = originalContent;

            String fileName = new File(filePath).getName();
            String tabName = ClaudeCodeGuiBundle.message("diff.tabName", fileName, operations.size());

            InteractiveDiffRequest request = isNewFile
                    ? InteractiveDiffRequest.forNewFile(filePath, currentContent, tabName)
                    : InteractiveDiffRequest.forModifiedFile(filePath, originalContent, currentContent, tabName);

            LOG.info("Diff request created - original length: " + originalContent.length() + ", current length: " + currentContent.length());

            InteractiveDiffManager.showInteractiveDiff(this.context.getProject(), request)
                    .thenAccept(result -> {
                        if (nativePatch) {
                            this.handleNativeDiffResult(result, filePath, requestedPath, operations, status, reviewOrigin);
                        } else {
                            this.handleDiffResult(result, filePath, baselineContent, isNewFile);
                        }
                    })
                    .exceptionally(e -> {
                        LOG.error("Error in interactive diff: " + e.getMessage(), e);
                        this.browserBridge.sendDiffResult(requestedPath, "REJECT", null, e.getMessage(), reviewOrigin);
                        return null;
                    });

            LOG.info("Interactive editable diff view opened for: " + filePath);
        } catch (Exception e) {
            LOG.error("Failed to show editable diff: " + e.getMessage(), e);
            this.browserBridge.showErrorToast(ClaudeCodeGuiBundle.message("diff.openFailedDetail", e.getMessage()));
        }
    }

    private void handleDiffResult(DiffResult result, String filePath, String originalContent, boolean isNewFile) {
        if (result.isApplied()) {
            this.fileOperations.writeContentToFile(filePath, result.getFinalContent());
            this.browserBridge.sendDiffResult(filePath, "APPLY", result.getFinalContent(), null);
            return;
        }

        if (result.isRejected()) {
            if (isNewFile) {
                this.fileOperations.deleteFile(filePath);
            } else {
                this.fileOperations.writeContentToFile(filePath, originalContent);
            }
            this.browserBridge.sendRemoveFileFromEdits(filePath);
            this.browserBridge.sendDiffResult(filePath, "REJECT", null, null);
            return;
        }

        LOG.info("Diff dismissed for: " + filePath);
        this.browserBridge.sendDiffResult(filePath, "DISMISS", null, null);
    }

    private boolean hasNativeOperations(JsonArray operations) {
        for (var element : operations) {
            if (element.isJsonObject() && element.getAsJsonObject().has("fileChangeKind")) {
                return true;
            }
        }
        return false;
    }

    private String resolveWorkingDirectory() {
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

    private JsonArray freezeOperationPaths(JsonArray operations, String workingDirectory) {
        // The diff can outlive its chat's directory selection, including relative rename sources.
        JsonArray frozen = operations.deepCopy();
        for (var element : frozen) {
            if (element.isJsonObject()) {
                JsonObject operation = element.getAsJsonObject();
                if (operation.has("moveFrom") && !operation.get("moveFrom").isJsonNull()) {
                    operation.addProperty("moveFrom", this.resolveFilePath(operation.get("moveFrom").getAsString(), workingDirectory));
                }
            }
        }
        return frozen;
    }

    private JsonObject captureReviewOrigin(JsonArray operations) {
        var session = this.context.getSession();
        JsonObject origin = new JsonObject();
        origin.addProperty("sessionId", session == null ? null : session.getSessionId());
        origin.addProperty("provider", session == null ? this.context.getCurrentProvider() : session.getProvider());
        var keys = new LinkedHashSet<String>();
        for (var element : operations) {
            if (element.isJsonObject()) {
                var key = element.getAsJsonObject().get("ledgerKey");
                if (key != null && key.isJsonPrimitive() && !key.getAsString().isBlank()) {
                    keys.add(key.getAsString());
                }
            }
        }
        JsonArray ledgerKeys = new JsonArray();
        keys.forEach(ledgerKeys::add);
        origin.add("ledgerKeys", ledgerKeys);
        return origin;
    }

    private void handleNativeDiffResult(DiffResult result, String filePath, String requestedPath,
                                      JsonArray operations, String status, JsonObject reviewOrigin) {
        if (result.isRejected()) {
            // A diff decision belongs to the chat and operations that opened it.
            JsonObject undo = reviewOrigin.deepCopy();
            undo.addProperty("filePath", filePath);
            undo.addProperty("resultFilePath", requestedPath);
            undo.addProperty("status", status);
            undo.add("operations", operations);
            this.undoSubmission.accept(undo);
            return;
        }
        if (!result.isApplied()) {
            this.browserBridge.sendDiffResult(requestedPath, "DISMISS", null, null, reviewOrigin);
            return;
        }
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (!this.fileOperations.isPathWithinProject(filePath)) {
                    throw new IOException("File path is outside the project directory");
                }
                if (!("D".equals(status) && result.getFinalContent().isEmpty())) {
                    VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(WslPathUtil.toVfsPath(filePath));
                    Document document = file == null ? null : FileDocumentManager.getInstance().getDocument(file);
                    if (document != null) {
                        WriteCommandAction.runWriteCommandAction(this.context.getProject(), "Review Session Changes", null,
                                () -> document.setText(result.getFinalContent()));
                        FileDocumentManager.getInstance().saveDocument(document);
                    } else {
                        Path path = Path.of(filePath);
                        Files.createDirectories(path.getParent());
                        Files.writeString(path, result.getFinalContent(), StandardCharsets.UTF_8);
                        LocalFileSystem.getInstance().refreshAndFindFileByPath(WslPathUtil.toVfsPath(filePath));
                    }
                }
                this.browserBridge.sendDiffResult(requestedPath, "APPLY", result.getFinalContent(), null, reviewOrigin);
            } catch (Exception failure) {
                this.browserBridge.sendDiffResult(requestedPath, "APPLY", null, failure.getMessage(), reviewOrigin);
            }
        });
    }
}
