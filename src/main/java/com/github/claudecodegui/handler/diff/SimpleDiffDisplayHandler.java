package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.handler.core.HandlerContext;
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

/**
 * Handles non-interactive diff display requests.
 */
public class SimpleDiffDisplayHandler implements DiffActionHandler {

    private static final Logger LOG = Logger.getInstance(SimpleDiffDisplayHandler.class);

    private final HandlerContext context;
    private final Gson gson;
    private final DiffFileOperations fileOperations;
    private final DiffBrowserBridge browserBridge;

    public SimpleDiffDisplayHandler(HandlerContext context, Gson gson, DiffFileOperations fileOperations) {
        this(context, gson, fileOperations, new DiffBrowserBridge(context, gson));
    }

    public SimpleDiffDisplayHandler(HandlerContext context, Gson gson, DiffFileOperations fileOperations, DiffBrowserBridge browserBridge) {
        this.context = context;
        this.gson = gson;
        this.fileOperations = fileOperations;
        this.browserBridge = browserBridge;
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

    private void notifyDiffFailure(String filePath, String message) {
        LOG.warn(message + (filePath == null || filePath.isBlank() ? "" : ": " + filePath));
        if (browserBridge != null) {
            browserBridge.showErrorToast(message);
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
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    DiffContent leftContent = DiffContentFactory.getInstance()
                            .create(context.getProject(), oldContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                            .create(context.getProject(), newContent, fileType);

                    String diffTitle = title != null ? title : ClaudeCodeGuiBundle.message("diff.fileChange", fileName);
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                            diffTitle,
                            leftContent,
                            rightContent,
                            ClaudeCodeGuiBundle.message("diff.editBefore", fileName),
                            ClaudeCodeGuiBundle.message("diff.editAfter", fileName)
                    );

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
                        notifyDiffFailure(filePath, "Could not read file content for diff");
                        return;
                    }

                    ContentRebuildUtil.RebuildResult rebuildResult = ContentRebuildUtil.rebuildBeforeContentResult(afterContent, edits);
                    if (!rebuildResult.success()) {
                        notifyDiffFailure(filePath, "Could not safely rebuild before content for diff");
                        return;
                    }
                    String beforeContent = rebuildResult.content();

                    String fileName = new File(filePath).getName();
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    DiffContent leftContent = DiffContentFactory.getInstance()
                            .create(context.getProject(), beforeContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                            .create(context.getProject(), afterContent, fileType);

                    String diffTitle = ClaudeCodeGuiBundle.message("diff.tabName", fileName, edits.size());
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                            diffTitle,
                            leftContent,
                            rightContent,
                            ClaudeCodeGuiBundle.message("diff.editBefore", fileName),
                            ClaudeCodeGuiBundle.message("diff.editAfter", fileName)
                    );

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

                    ForwardApplyResult applyResult = applyForwardEditsForPreview(currentContent, edits);
                    if (!applyResult.success()) {
                        notifyDiffFailure(filePath, "Could not safely build edit preview diff: " + applyResult.reason());
                        return;
                    }
                    String afterContent = applyResult.content();

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

    static ForwardApplyResult applyForwardEditsForPreview(String originalContent, JsonArray edits) {
        String content = originalContent != null ? originalContent : "";
        if (edits == null || edits.isEmpty()) {
            return new ForwardApplyResult(true, content, null);
        }
        for (int i = 0; i < edits.size(); i++) {
            JsonObject edit = edits.get(i).getAsJsonObject();
            String oldString = edit.has("oldString") && !edit.get("oldString").isJsonNull()
                    ? edit.get("oldString").getAsString()
                    : "";
            String newString = edit.has("newString") && !edit.get("newString").isJsonNull()
                    ? edit.get("newString").getAsString()
                    : "";
            boolean replaceAll = edit.has("replaceAll") && !edit.get("replaceAll").isJsonNull()
                    && edit.get("replaceAll").getAsBoolean();
            if (oldString.isEmpty()) {
                return new ForwardApplyResult(false, content, "empty_old_string");
            }
            if (replaceAll) {
                if (!content.contains(oldString)) {
                    return new ForwardApplyResult(false, content, "old_string_not_found");
                }
                content = content.replace(oldString, newString);
                continue;
            }
            int first = content.indexOf(oldString);
            if (first < 0) {
                return new ForwardApplyResult(false, content, "old_string_not_found");
            }
            int second = content.indexOf(oldString, first + Math.max(1, oldString.length()));
            if (second >= 0) {
                return new ForwardApplyResult(false, content, "ambiguous_old_string");
            }
            content = content.substring(0, first) + newString + content.substring(first + oldString.length());
        }
        return new ForwardApplyResult(true, content, null);
    }

    record ForwardApplyResult(boolean success, String content, String reason) {
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
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    String beforeContent;
                    String afterContent;

                    if (originalContent != null && !originalContent.isEmpty()) {
                        LOG.info("Using cached original content for full file diff");
                        beforeContent = originalContent;

                        JsonArray singleEdit = new JsonArray();
                        JsonObject edit = new JsonObject();
                        edit.addProperty("oldString", oldString);
                        edit.addProperty("newString", newString);
                        edit.addProperty("replaceAll", replaceAll);
                        singleEdit.add(edit);
                        ForwardApplyResult applyResult = applyForwardEditsForPreview(beforeContent, singleEdit);
                        if (!applyResult.success()) {
                            notifyDiffFailure(filePath, "Could not safely build full edit diff: " + applyResult.reason());
                            return;
                        }
                        afterContent = applyResult.content();
                    } else {
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
}
