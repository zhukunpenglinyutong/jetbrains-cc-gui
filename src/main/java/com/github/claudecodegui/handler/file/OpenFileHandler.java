package com.github.claudecodegui.handler.file;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.util.EditorFileUtils;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.ide.BrowserUtil;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.ScrollType;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;

import java.io.File;
import java.util.concurrent.CompletableFuture;

/**
 * Handles opening files in the editor and opening URLs in the browser.
 */
class OpenFileHandler {

    private static final Logger LOG = Logger.getInstance(OpenFileHandler.class);

    private final HandlerContext context;

    OpenFileHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Open a file in the editor.
     * Supports file paths with line numbers: file.txt:100 or file.txt:100-200.
     */
    void handleOpenFile(String filePath) {
        LOG.info("Open file request: " + filePath);

        CompletableFuture.runAsync(() -> {
            try {
                int[] lineInfo = parseLineInfo(filePath);
                String actualPath = lineInfo[2] == 1 ? filePath.substring(0, filePath.lastIndexOf(':')) : filePath;
                int lineNumber = lineInfo[0];
                int endLineNumber = lineInfo[1];

                File file = resolveFile(actualPath);

                if (file == null) {
                    LOG.warn("File not found: " + actualPath);
                    ApplicationManager.getApplication().invokeLater(() -> {
                        context.callJavaScript("addErrorMessage", context.escapeJs("Cannot open file: file does not exist (" + actualPath + ")"));
                    }, ModalityState.nonModal());
                    return;
                }

                final File finalFile = file;
                EditorFileUtils.refreshAndFindFileAsync(finalFile, virtualFile -> {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (context.getProject().isDisposed() || !virtualFile.isValid()) {
                            return;
                        }
                        openInEditor(virtualFile, lineNumber, endLineNumber);
                        LOG.info("Successfully opened file: " + filePath);
                    }, ModalityState.nonModal());
                }, () -> {
                    LOG.error("Failed to get VirtualFile: " + filePath);
                    context.callJavaScript("addErrorMessage", context.escapeJs("Cannot open file: " + filePath));
                });
            } catch (Exception e) {
                LOG.error("Failed to open file: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Parse line number info from file path.
     * @return int[3]: [lineNumber, endLineNumber, hasLineInfo(0 or 1)]
     */
    private int[] parseLineInfo(String filePath) {
        int colonIndex = filePath.lastIndexOf(':');
        if (colonIndex > 0) {
            String afterColon = filePath.substring(colonIndex + 1);
            if (afterColon.matches("\\d+(-\\d+)?")) {
                int dashIndex = afterColon.indexOf('-');
                String startLineStr = dashIndex > 0 ? afterColon.substring(0, dashIndex) : afterColon;
                String endLineStr = dashIndex > 0 ? afterColon.substring(dashIndex + 1) : null;
                try {
                    int lineNumber = Integer.parseInt(startLineStr);
                    int endLineNumber = (endLineStr != null && !endLineStr.isBlank()) ? Integer.parseInt(endLineStr) : -1;
                    return new int[]{lineNumber, endLineNumber, 1};
                } catch (NumberFormatException e) {
                    LOG.warn("Failed to parse line number: " + afterColon);
                }
            }
        }
        return new int[]{-1, -1, 0};
    }

    /**
     * Resolve file path, handling MSYS paths and relative paths.
     */
    private File resolveFile(String actualPath) {
        File file = new File(actualPath);
        if (!file.exists() && PlatformUtils.isWindows()) {
            String convertedPath = PathUtils.convertMsysToWindowsPath(actualPath);
            if (!convertedPath.equals(actualPath)) {
                LOG.info("Detected MSYS2 path, converted to Windows path: " + convertedPath);
                file = new File(convertedPath);
            }
        }

        if (!file.exists() && !file.isAbsolute() && context.getProject().getBasePath() != null) {
            File projectFile = new File(context.getProject().getBasePath(), actualPath);
            LOG.info("Trying to resolve relative to project root: " + projectFile.getAbsolutePath());
            if (projectFile.exists()) {
                file = projectFile;
            }
        }

        return file.exists() ? file : null;
    }

    /**
     * Open a virtual file in the editor, optionally navigating to a line range.
     */
    private void openInEditor(com.intellij.openapi.vfs.VirtualFile virtualFile, int lineNumber, int endLineNumber) {
        if (lineNumber <= 0) {
            FileEditorManager.getInstance(context.getProject()).openFile(virtualFile, true);
            return;
        }

        OpenFileDescriptor descriptor = new OpenFileDescriptor(context.getProject(), virtualFile);
        Editor editor = FileEditorManager.getInstance(context.getProject()).openTextEditor(descriptor, true);

        if (editor == null) {
            LOG.warn("Cannot open text editor: " + virtualFile.getPath());
            FileEditorManager.getInstance(context.getProject()).openFile(virtualFile, true);
            return;
        }

        int lineCount = editor.getDocument().getLineCount();
        if (lineCount <= 0) {
            LOG.warn("File is empty, cannot navigate to line " + lineNumber);
            return;
        }

        int zeroBasedLine = Math.min(Math.max(0, lineNumber - 1), lineCount - 1);
        int startOffset = editor.getDocument().getLineStartOffset(zeroBasedLine);
        editor.getCaretModel().moveToOffset(startOffset);

        if (endLineNumber >= lineNumber) {
            int zeroBasedEndLine = Math.min(endLineNumber - 1, lineCount - 1);
            int endOffset = editor.getDocument().getLineEndOffset(zeroBasedEndLine);
            editor.getSelectionModel().setSelection(startOffset, endOffset);
        } else {
            editor.getSelectionModel().removeSelection();
        }

        editor.getScrollingModel().scrollToCaret(ScrollType.CENTER);
    }

    /**
     * Open the browser.
     */
    void handleOpenBrowser(String url) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                BrowserUtil.browse(url);
            } catch (Exception e) {
                LOG.error("Cannot open browser: " + e.getMessage(), e);
            }
        });
    }
}
