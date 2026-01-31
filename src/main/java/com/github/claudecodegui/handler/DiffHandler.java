package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeCodeGuiBundle;
import com.github.claudecodegui.handler.diff.DiffResult;
import com.github.claudecodegui.handler.diff.InteractiveDiffManager;
import com.github.claudecodegui.handler.diff.InteractiveDiffRequest;
import com.github.claudecodegui.util.EditorFileUtils;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.diff.DiffContentFactory;
import com.intellij.diff.DiffManager;
import com.intellij.diff.contents.DiffContent;
import com.intellij.diff.requests.SimpleDiffRequest;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Document;
import com.intellij.openapi.fileEditor.FileDocumentManager;
import com.intellij.openapi.fileTypes.FileType;
import com.intellij.openapi.fileTypes.FileTypeManager;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.File;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Diff 和文件刷新相关消息处理器
 */
public class DiffHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(DiffHandler.class);
    private final Gson gson = new Gson();

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
     * 刷新文件到 IDEA
     * 使用异步方式和重试机制确保文件能被正确刷新
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

            // 在后台线程中处理文件刷新
            CompletableFuture.runAsync(() -> {
                try {
                    File file = new File(filePath);

                    // 添加短暂延迟，等待文件写入完成
                    try {
                        TimeUnit.MILLISECONDS.sleep(300);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }

                    // 如果文件不存在且是相对路径，尝试相对于项目根目录解析
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

                    // 使用工具类方法异步刷新并查找文件
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
     * 执行文件刷新操作（必须在 UI 线程中调用）
     */
    private void performFileRefresh(VirtualFile virtualFile, String filePath) {
        try {
            // 刷新文件系统，让 IDEA 检测到文件变化
            // IDEA 会自动提示用户是否重新加载，避免强制刷新导致的冲突
            virtualFile.refresh(false, false);

            LOG.info("File refreshed successfully: " + filePath);
        } catch (Exception e) {
            LOG.error("Failed to perform file refresh: " + filePath, e);
        }
    }

    /**
     * 显示 Diff 视图
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

                    // 创建 Diff 内容
                    DiffContent leftContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), oldContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), newContent, fileType);

                    // 创建 Diff 请求
                    String diffTitle = title != null ? title : "文件变更: " + fileName;
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        fileName + " (修改前)",
                        fileName + " (修改后)"
                    );

                    // 显示 Diff 窗口
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
     * 显示多处编辑的 Diff 视图
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
                    // 获取文件当前内容
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

                    // 反向重建编辑前内容
                    String beforeContent = rebuildBeforeContent(afterContent, edits);

                    String fileName = new File(filePath).getName();
                    FileType fileType = FileTypeManager.getInstance().getFileTypeByFileName(fileName);

                    // 创建 Diff 内容
                    DiffContent leftContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), beforeContent, fileType);
                    DiffContent rightContent = DiffContentFactory.getInstance()
                        .create(context.getProject(), afterContent, fileType);

                    // 创建 Diff 请求
                    String diffTitle = "文件变更: " + fileName + " (" + edits.size() + " 处编辑)";
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        fileName + " (修改前)",
                        fileName + " (修改后)"
                    );

                    // 显示 Diff 窗口
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
     * 反向重建编辑前内容
     * 通过反向应用编辑操作，从编辑后内容推导出编辑前内容
     *
     * 注意：如果文件被 linter/formatter 修改过，newString 可能无法精确匹配。
     * 此时会尝试标准化空白后再匹配，如果仍失败则跳过该操作继续处理。
     */
    private String rebuildBeforeContent(String afterContent, JsonArray edits) {
        String content = afterContent;

        // 反向遍历编辑操作
        for (int i = edits.size() - 1; i >= 0; i--) {
            JsonObject edit = edits.get(i).getAsJsonObject();
            String oldString = edit.has("oldString") ? edit.get("oldString").getAsString() : "";
            String newString = edit.has("newString") ? edit.get("newString").getAsString() : "";
            boolean replaceAll = edit.has("replaceAll") && edit.get("replaceAll").getAsBoolean();

            if (replaceAll) {
                // 全局替换：newString → oldString
                if (content.contains(newString)) {
                    content = content.replace(newString, oldString);
                } else {
                    // 尝试标准化空白后匹配
                    String normalizedNew = normalizeWhitespace(newString);
                    String normalizedContent = normalizeWhitespace(content);
                    if (normalizedContent.contains(normalizedNew)) {
                        // 找到标准化匹配，使用原始 oldString 替换
                        content = replaceNormalized(content, newString, oldString);
                    } else {
                        LOG.warn("rebuildBeforeContent: newString not found (replace_all), skipping operation");
                    }
                }
            } else {
                // 单次替换：找到第一个 newString，替换为 oldString
                int index = content.indexOf(newString);
                if (index >= 0) {
                    content = content.substring(0, index) + oldString + content.substring(index + newString.length());
                } else {
                    // 尝试标准化空白后匹配
                    int fuzzyIndex = findNormalizedIndex(content, newString);
                    if (fuzzyIndex >= 0) {
                        // 找到模糊匹配位置，计算实际结束位置
                        int actualEnd = findActualEndIndex(content, fuzzyIndex, newString);
                        content = content.substring(0, fuzzyIndex) + oldString + content.substring(actualEnd);
                    } else {
                        LOG.warn("rebuildBeforeContent: newString not found, skipping operation");
                    }
                }
            }
        }

        LOG.info("Successfully rebuilt before content (" + edits.size() + " operations)");
        return content;
    }

    /**
     * 标准化空白字符（用于模糊匹配）
     * 将连续空白替换为单个空格，并去除首尾空白
     */
    private String normalizeWhitespace(String s) {
        if (s == null) return "";
        return s.replaceAll("\\s+", " ").trim();
    }

    /**
     * 在标准化空白后查找子串位置
     */
    private int findNormalizedIndex(String content, String target) {
        String normalizedTarget = normalizeWhitespace(target);
        String[] lines = content.split("\n", -1);
        int charIndex = 0;

        for (int lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            // 尝试在当前行开始的多行区域中匹配
            StringBuilder remainingBuilder = new StringBuilder();
            for (int j = lineIdx; j < lines.length; j++) {
                if (j > lineIdx) remainingBuilder.append("\n");
                remainingBuilder.append(lines[j]);
            }
            String remainingContent = remainingBuilder.toString();
            String normalizedRemaining = normalizeWhitespace(remainingContent);

            if (normalizedRemaining.startsWith(normalizedTarget) ||
                normalizedRemaining.contains(normalizedTarget)) {
                // 找到了匹配的起始位置
                return charIndex;
            }
            charIndex += lines[lineIdx].length() + 1; // +1 for newline
        }
        return -1;
    }

    /**
     * 找到实际的结束索引（考虑空白差异）
     */
    private int findActualEndIndex(String content, int startIndex, String target) {
        String normalizedTarget = normalizeWhitespace(target);
        int targetNormalizedLen = normalizedTarget.length();

        int normalizedCount = 0;
        int actualIndex = startIndex;

        while (actualIndex < content.length() && normalizedCount < targetNormalizedLen) {
            char c = content.charAt(actualIndex);
            if (!Character.isWhitespace(c) ||
                (normalizedCount > 0 && normalizedCount < normalizedTarget.length() &&
                 normalizedTarget.charAt(normalizedCount) == ' ')) {
                normalizedCount++;
            }
            actualIndex++;
        }

        // 跳过尾部空白（但不跳过换行符）
        while (actualIndex < content.length() &&
               Character.isWhitespace(content.charAt(actualIndex)) &&
               content.charAt(actualIndex) != '\n') {
            actualIndex++;
        }

        return actualIndex;
    }

    /**
     * 使用标准化匹配进行替换
     */
    private String replaceNormalized(String content, String target, String replacement) {
        int index = findNormalizedIndex(content, target);
        if (index < 0) return content;

        int endIndex = findActualEndIndex(content, index, target);
        return content.substring(0, index) + replacement + content.substring(endIndex);
    }

    /**
     * 显示可编辑的 Diff 视图
     * 用户可以在 diff 视图中选择性接受或拒绝更改
     * 使用新的 InteractiveDiffManager 实现，带有 Apply/Reject 按钮
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
                    String currentContent = "";
                    Charset charset = StandardCharsets.UTF_8;

                    if (!isNewFile) {
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
                    }

                    // Rebuild the original content (BEFORE modifications) by reverse-applying operations
                    String originalContent;
                    if (isNewFile) {
                        // New file: original content is empty
                        originalContent = "";
                    } else {
                        // Modified file: rebuild original content by reverse-applying operations
                        originalContent = rebuildBeforeContent(currentContent, operations);
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
                                    // User explicitly rejected - restore original content
                                    writeContentToFile(finalFilePath, finalOriginalContent);
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

    /**
     * Schedule periodic check for file changes after diff is opened
     */
    private void scheduleFileChangeCheck(String filePath, String beforeContent, Path tempFile, Path tempDir, Charset charset) {
        // Use a simple approach: check file content after a delay
        // In a more sophisticated implementation, you could use VirtualFileListener
        CompletableFuture.runAsync(() -> {
            try {
                // Wait for user to make changes and close diff
                // This is a simplified approach - the temp file will be cleaned up on JVM exit
                // A more robust solution would use IDEA's Disposer mechanism

                // For now, just ensure temp files are registered for cleanup
                LOG.info("Editable diff session started for: " + filePath);

            } catch (Exception e) {
                LOG.error("Error in file change check: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Clean up temporary files
     */
    private void cleanupTempFiles(Path tempFile, Path tempDir) {
        try {
            if (tempFile != null && Files.exists(tempFile)) {
                Files.delete(tempFile);
            }
            if (tempDir != null && Files.exists(tempDir)) {
                Files.delete(tempDir);
            }
        } catch (IOException e) {
            LOG.warn("Failed to cleanup temp files: " + e.getMessage());
        }
    }

    /**
     * Show error toast notification to user via WebView
     */
    private void showErrorToast(String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getBrowser() == null || context.isDisposed()) {
                    LOG.warn("Cannot show error toast: browser is null or disposed");
                    return;
                }
                String escapedMsg = JsUtils.escapeJs(message);
                String js = "if (window.addToast) { window.addToast('" + escapedMsg + "', 'error'); }";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } catch (Exception e) {
                LOG.error("Failed to show error toast: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Send message to frontend to remove file from edits list
     */
    private void sendRemoveFileFromEdits(String filePath) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getBrowser() == null || context.isDisposed()) {
                    LOG.warn("Cannot send remove_file_from_edits: browser is null or disposed");
                    return;
                }
                JsonObject payload = new JsonObject();
                payload.addProperty("filePath", filePath);
                String payloadJson = gson.toJson(payload);
                String js = "(function() {" +
                        "  if (typeof window.handleRemoveFileFromEdits === 'function') {" +
                        "    window.handleRemoveFileFromEdits('" + JsUtils.escapeJs(payloadJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } catch (Exception e) {
                LOG.error("Failed to send remove_file_from_edits message: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Send message to frontend to update file stats in edits list
     */
    private void sendUpdateFileInEdits(String filePath, int additions, int deletions) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getBrowser() == null || context.isDisposed()) {
                    LOG.warn("Cannot send update_file_in_edits: browser is null or disposed");
                    return;
                }
                JsonObject payload = new JsonObject();
                payload.addProperty("filePath", filePath);
                payload.addProperty("additions", additions);
                payload.addProperty("deletions", deletions);
                String payloadJson = gson.toJson(payload);
                String js = "(function() {" +
                        "  if (typeof window.handleUpdateFileInEdits === 'function') {" +
                        "    window.handleUpdateFileInEdits('" + JsUtils.escapeJs(payloadJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } catch (Exception e) {
                LOG.error("Failed to send update_file_in_edits message: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Compute diff statistics between two strings
     */
    private int[] computeDiffStats(String before, String after) {
        String[] beforeLines = before.split("\n", -1);
        String[] afterLines = after.split("\n", -1);

        // Simple line-based diff counting
        int additions = 0;
        int deletions = 0;

        // Use LCS-based approach for accurate counting
        int[][] dp = new int[beforeLines.length + 1][afterLines.length + 1];

        for (int i = 1; i <= beforeLines.length; i++) {
            for (int j = 1; j <= afterLines.length; j++) {
                if (beforeLines[i - 1].equals(afterLines[j - 1])) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        int lcsLength = dp[beforeLines.length][afterLines.length];
        deletions = beforeLines.length - lcsLength;
        additions = afterLines.length - lcsLength;

        return new int[]{additions, deletions};
    }

    /**
     * 显示编辑预览 Diff（当前内容 → 应用编辑后的内容）
     * 用于在执行编辑前预览效果
     */
    private void handleShowEditPreviewDiff(String content) {
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String filePath = json.has("filePath") ? json.get("filePath").getAsString() : "";
            JsonArray edits = json.has("edits") ? json.getAsJsonArray("edits") : new JsonArray();
            String title = json.has("title") ? json.get("title").getAsString() : null;

            LOG.info("Showing edit preview diff for file: " + filePath + " with " + edits.size() + " edits");

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

                    String diffTitle = title != null ? title : "编辑预览: " + fileName;
                    SimpleDiffRequest diffRequest = new SimpleDiffRequest(
                        diffTitle,
                        leftContent,
                        rightContent,
                        fileName + " (当前)",
                        fileName + " (编辑后)"
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
     * 显示完整文件 Diff（原始内容 → 修改后的内容）
     * 用于展示修改前后的完整文件对比
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
                        // 有缓存的原始内容：展示完整文件 Diff
                        LOG.info("Using cached original content for full file diff");
                        beforeContent = originalContent;

                        // 计算修改后的内容：在原始内容上应用 oldString → newString 替换
                        if (replaceAll) {
                            afterContent = beforeContent.replace(oldString, newString);
                        } else {
                            int index = beforeContent.indexOf(oldString);
                            if (index >= 0) {
                                afterContent = beforeContent.substring(0, index) + newString + beforeContent.substring(index + oldString.length());
                            } else {
                                // oldString 不在原始内容中，使用当前文件内容
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
                        // 没有缓存的原始内容：只展示编辑部分（oldString → newString）
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
                        // 无缓存时显示"Edit Only"标记
                        diffTitle = (title != null ? title : "编辑: " + fileName) + " (仅编辑部分)";
                        leftLabel = "old_string";
                        rightLabel = "new_string";
                    } else {
                        diffTitle = title != null ? title : "编辑: " + fileName;
                        leftLabel = fileName + " (修改前)";
                        rightLabel = fileName + " (修改后)";
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
     * Write content to file and refresh VFS.
     * Validates that the file path is within the project directory for security.
     */
    private void writeContentToFile(String filePath, String content) {
        if (content == null) {
            return;
        }

        // Security: Validate path is within project directory
        String projectBasePath = context.getProject().getBasePath();
        if (projectBasePath != null) {
            try {
                java.nio.file.Path normalizedPath = java.nio.file.Paths.get(filePath).toAbsolutePath().normalize();
                java.nio.file.Path projectPath = java.nio.file.Paths.get(projectBasePath).toAbsolutePath().normalize();
                if (!normalizedPath.startsWith(projectPath)) {
                    LOG.warn("Security: Attempted to write file outside project directory: " + filePath);
                    return;
                }
            } catch (java.nio.file.InvalidPathException e) {
                LOG.error("Invalid file path: " + filePath, e);
                return;
            }
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

    /**
     * Send diff result to frontend.
     */
    private void sendDiffResult(String filePath, String action, String content, String error) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getBrowser() == null || context.isDisposed()) {
                    LOG.warn("Cannot send diff_result: browser is null or disposed");
                    return;
                }

                JsonObject payload = new JsonObject();
                payload.addProperty("filePath", filePath);
                payload.addProperty("action", action);
                if (content != null) {
                    payload.addProperty("content", content);
                }
                if (error != null) {
                    payload.addProperty("error", error);
                }

                String payloadJson = gson.toJson(payload);
                String js = "(function() {" +
                        "  if (typeof window.handleDiffResult === 'function') {" +
                        "    window.handleDiffResult('" + JsUtils.escapeJs(payloadJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
                LOG.info("Diff result sent to frontend: " + action + " for " + filePath);
            } catch (Exception e) {
                LOG.error("Failed to send diff_result message: " + e.getMessage(), e);
            }
        });
    }
}
