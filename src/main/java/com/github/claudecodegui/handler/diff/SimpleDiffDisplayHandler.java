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
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Handles non-interactive diff display requests.
 * This handler is thin: it parses JSON, delegates reconstruction to
 * {@link DiffReconstructionService}, and shows via {@link AdjustableDiffManager}.
 */
public class SimpleDiffDisplayHandler implements DiffActionHandler {

    private static final Logger LOG = Logger.getInstance(SimpleDiffDisplayHandler.class);

    private final HandlerContext context;
    private final Gson gson;
    private final DiffFileOperations fileOperations;

    public SimpleDiffDisplayHandler(HandlerContext context, Gson gson, DiffFileOperations fileOperations) {
        this.context = context;
        this.gson = gson;
        this.fileOperations = fileOperations;
    }

    private static final String[] TYPES = {
            "show_diff", "show_multi_edit_diff", "show_edit_preview_diff", "show_edit_full_diff"
    };

    @Override
    public String[] getSupportedTypes() {
        return TYPES;
    }

    @Override
    public void handle(String type, String content) {
        switch (type) {
            case "show_diff":
                handleShowDiff(content);
                break;
            case "show_multi_edit_diff":
                handleShowMultiEditDiff(content);
                break;
            case "show_edit_preview_diff":
                handleShowEditPreviewDiff(content);
                break;
            case "show_edit_full_diff":
                handleShowEditFullDiff(content);
                break;
            default:
                break;
        }
    }

    private void handleShowDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            String oldContent = json.has("oldContent") ? json.get("oldContent").getAsString() : "";
            String newContent = json.has("newContent") ? json.get("newContent").getAsString() : "";
            String title = json.has("title") ? json.get("title").getAsString() : null;

            if (!fileOperations.isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                return;
            }

            LOG.info("Showing diff for file: " + filePath);

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    String fileName = new File(filePath).getName();
                    DiffReconstructionResult result = DiffReconstructionService.reconstruct(
                            filePath, oldContent, newContent, false);

                    // Use disk content from reconstruction result — same read that built the diff
                    String diskSnapshot = result.getDiskContent();

                    String diffTitle = title != null ? title : ClaudeCodeGuiBundle.message("diff.fileChange", fileName);
                    AdjustableDiffRequest request = new AdjustableDiffRequest(
                            filePath,
                            result.getBeforeContent(),
                            result.getAfterContent(),
                            diffTitle,
                            result.isFullFile(),
                            diskSnapshot
                    );
                    AdjustableDiffManager.show(context.getProject(), request, fileOperations);
                    LOG.info("Diff view opened for: " + filePath
                            + (result.isFullFile() ? " (full file)" : " (fragment fallback)"));
                } catch (Exception e) {
                    LOG.error("Failed to show diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_diff request: " + e.getMessage(), e);
        }
    }

    private void handleShowMultiEditDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray edits = json.has("edits") ? json.getAsJsonArray("edits") : new JsonArray();
            String currentContent = json.has("currentContent") ? json.get("currentContent").getAsString() : null;

            if (!fileOperations.isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                return;
            }

            LOG.info("Showing multi-edit diff for file: " + filePath + " with " + edits.size() + " edits");

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    String afterContent = currentContent;
                    if (afterContent == null) {
                        // Use charset-aware read — same method Apply uses for stale-check,
                        // so non-UTF-8 files won't false-positive as externally modified
                        afterContent = DiffReconstructionService.readFileContent(filePath);
                    }

                    if (afterContent == null) {
                        LOG.warn("Could not read file content: " + filePath);
                        return;
                    }

                    ContentRebuildResult rebuildResult = ContentRebuildUtil.rebuildBeforeContent(afterContent, edits);
                    String beforeContent = rebuildResult.getContent();
                    boolean canApply = rebuildResult.isExact();
                    String fileName = new File(filePath).getName();
                    String diffTitle = ClaudeCodeGuiBundle.message("diff.tabName", fileName, edits.size());
                    if (!canApply) {
                        diffTitle += " " + ClaudeCodeGuiBundle.message("diff.editOnly");
                    }

                    // afterContent IS the current disk content — use it as snapshot directly
                    AdjustableDiffRequest request = new AdjustableDiffRequest(
                            filePath,
                            beforeContent,
                            afterContent,
                            diffTitle,
                            canApply, // only allow Apply when all reverse operations matched exactly
                            canApply ? afterContent : null
                    );
                    AdjustableDiffManager.show(context.getProject(), request, fileOperations);
                    LOG.info("Multi-edit diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show multi-edit diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_multi_edit_diff request: " + e.getMessage(), e);
        }
    }

    private void handleShowEditPreviewDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray edits = json.has("edits") ? json.getAsJsonArray("edits") : new JsonArray();
            String title = json.has("title") ? json.get("title").getAsString() : null;

            LOG.info("Showing edit preview diff for file: " + filePath + " with " + edits.size() + " edits");

            if (!fileOperations.isPathWithinProject(filePath)) {
                LOG.warn("Security: file path outside project directory: " + filePath);
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    VirtualFile file = LocalFileSystem.getInstance().refreshAndFindFileByPath(filePath.replace('\\', '/'));
                    if (file != null && file.isDirectory()) {
                        LOG.warn("Cannot show preview diff for directory: " + filePath);
                        return;
                    }

                    String currentContent = "";
                    if (file != null) {
                        file.refresh(false, false);
                        try {
                            var charset = file.getCharset() != null ? file.getCharset() : StandardCharsets.UTF_8;
                            currentContent = new String(file.contentsToByteArray(), charset);
                        } catch (IOException e) {
                            LOG.error("Failed to read file content: " + filePath, e);
                            return;
                        }
                    }

                    String afterContent = currentContent;
                    for (int i = 0; i < edits.size(); i++) {
                        JsonObject edit = edits.get(i).getAsJsonObject();
                        String oldString = edit.has("oldString") ? edit.get("oldString").getAsString() : "";
                        String newString = edit.has("newString") ? edit.get("newString").getAsString() : "";
                        boolean replaceAll = edit.has("replaceAll") && edit.get("replaceAll").getAsBoolean();

                        if (oldString.isEmpty()) {
                            if (!newString.isEmpty()) {
                                LOG.info("Preview: skipping pure insertion edit (no position info)");
                            }
                            continue;
                        }

                        if (replaceAll) {
                            afterContent = afterContent.replace(oldString, newString);
                        } else {
                            int index = afterContent.indexOf(oldString);
                            if (index >= 0) {
                                afterContent = afterContent.substring(0, index)
                                        + newString
                                        + afterContent.substring(index + oldString.length());
                            } else {
                                LOG.warn("oldString not found in file, skipping edit");
                            }
                        }
                    }

                    String fileName = new File(filePath).getName();
                    String diffTitle = title != null ? title : ClaudeCodeGuiBundle.message("diff.editPreview", fileName);

                    AdjustableDiffRequest request = new AdjustableDiffRequest(
                            filePath,
                            currentContent,
                            afterContent,
                            diffTitle,
                            false, // preview may be incomplete (skipped insertions, failed edits) — not safe to Apply
                            null
                    );
                    AdjustableDiffManager.show(context.getProject(), request, fileOperations);
                    LOG.info("Edit preview diff view opened for: " + filePath);
                } catch (Exception e) {
                    LOG.error("Failed to show edit preview diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_edit_preview_diff request: " + e.getMessage(), e);
        }
    }

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

            if (!fileOperations.isPathWithinProject(filePath)) {
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
                    DiffReconstructionResult result = DiffReconstructionService.reconstruct(
                            filePath, oldString, newString, replaceAll, originalContent);

                    // Use disk content from reconstruction result — same read that built the diff
                    String diskSnapshot = result.getDiskContent();

                    String diffTitle;
                    if (!result.isFullFile()) {
                        diffTitle = (title != null ? title : ClaudeCodeGuiBundle.message("diff.edit", fileName))
                                + " " + ClaudeCodeGuiBundle.message("diff.editOnly");
                    } else {
                        diffTitle = title != null ? title : ClaudeCodeGuiBundle.message("diff.edit", fileName);
                    }

                    AdjustableDiffRequest request = new AdjustableDiffRequest(
                            filePath,
                            result.getBeforeContent(),
                            result.getAfterContent(),
                            diffTitle,
                            result.isFullFile(),
                            diskSnapshot
                    );
                    AdjustableDiffManager.show(context.getProject(), request, fileOperations);
                    LOG.info("Edit full diff view opened for: " + filePath
                            + (result.isFullFile() ? " (full file)" : " (fragment fallback)"));
                } catch (Exception e) {
                    LOG.error("Failed to show edit full diff: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("Failed to parse show_edit_full_diff request: " + e.getMessage(), e);
        }
    }
}
