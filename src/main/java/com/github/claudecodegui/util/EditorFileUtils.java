package com.github.claudecodegui.util;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.fileEditor.FileEditor;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.TextEditor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.File;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * 编辑器文件工具类
 * 用于获取 IDEA 中当前打开的文件信息
 */
public class EditorFileUtils {

    private static final Logger LOG = Logger.getInstance(EditorFileUtils.class);

    /**
     * 获取当前项目中所有打开的文件路径
     * @param project IDEA 项目对象
     * @return 打开的文件路径列表
     */
    public static List<String> getOpenedFiles(Project project) {
        List<String> openedFiles = new ArrayList<>();

        if (project == null) {
            return openedFiles;
        }

        try {
            // 获取文件编辑器管理器
            FileEditorManager fileEditorManager = FileEditorManager.getInstance(project);

            // 获取所有打开的文件
            VirtualFile[] openFiles = fileEditorManager.getOpenFiles();

            // 提取文件路径
            for (VirtualFile file : openFiles) {
                if (file != null && file.getPath() != null) {
                    openedFiles.add(file.getPath());
                }
            }
        } catch (Exception e) {
            // 捕获异常，避免影响主流程
            LOG.error("[EditorFileUtils] Error getting opened files: " + e.getMessage());
        }

        return openedFiles;
    }

    /**
     * 获取当前激活（正在查看）的文件路径
     * @param project IDEA 项目对象
     * @return 当前激活的文件路径，如果没有则返回 null
     */
    public static String getCurrentActiveFile(Project project) {
        if (project == null) {
            return null;
        }

        try {
            FileEditorManager fileEditorManager = FileEditorManager.getInstance(project);

            // 获取当前选中的文件
            VirtualFile[] selectedFiles = fileEditorManager.getSelectedFiles();

            if (selectedFiles.length > 0 && selectedFiles[0] != null) {
                return selectedFiles[0].getPath();
            }
        } catch (Exception e) {
            LOG.error("[EditorFileUtils] Error getting active file: " + e.getMessage());
        }

        return null;
    }

    /**
     * 获取当前激活文件中选中的代码信息
     * @param project IDEA 项目对象
     * @return 包含选中信息的 Map，如果没有选中则返回 null
     *         Map 包含: startLine, endLine, selectedText
     */
    public static Map<String, Object> getSelectedCodeInfo(Project project) {
        if (project == null) {
            return null;
        }

        try {
            FileEditorManager fileEditorManager = FileEditorManager.getInstance(project);

            // 获取当前选中的编辑器
            FileEditor selectedEditor = fileEditorManager.getSelectedEditor();
            if (selectedEditor instanceof TextEditor) {
                Editor editor = ((TextEditor) selectedEditor).getEditor();
                SelectionModel selectionModel = editor.getSelectionModel();

                // 检查是否有选中的文本
                if (selectionModel.hasSelection()) {
                    String selectedText = selectionModel.getSelectedText();
                    if (selectedText != null && !selectedText.trim().isEmpty()) {
                        int startOffset = selectionModel.getSelectionStart();
                        int endOffset = selectionModel.getSelectionEnd();

                        // 转换为行号（从 1 开始）
                        int startLine = editor.getDocument().getLineNumber(startOffset) + 1;
                        int endLine = editor.getDocument().getLineNumber(endOffset) + 1;

                        Map<String, Object> selectionInfo = new HashMap<>();
                        selectionInfo.put("startLine", startLine);
                        selectionInfo.put("endLine", endLine);
                        selectionInfo.put("selectedText", selectedText);

                        LOG.info("[EditorFileUtils] Selection detected: lines " + startLine + "-" + endLine);
                        return selectionInfo;
                    }
                }
            }
        } catch (Exception e) {
            LOG.error("[EditorFileUtils] Error getting selected code: " + e.getMessage());
        }

        return null;
    }

    /**
     * Asynchronously refresh and find a virtual file.
     * This method prevents deadlocks by performing refresh operations outside of read locks.
     *
     * @param file      the file to refresh and find
     * @param onSuccess callback invoked on UI thread with the VirtualFile if found
     * @param onFailure callback invoked on UI thread if file cannot be found (optional)
     */
    public static void refreshAndFindFileAsync(File file, Consumer<VirtualFile> onSuccess, Runnable onFailure) {
        try {
            final String canonicalPath = file.getCanonicalPath();

            // Step 1: Refresh file system on UI thread (not under read lock)
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    // Async refresh - this doesn't block and doesn't require read lock
                    LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file);

                    // Step 2: Find the file in a non-blocking read action
                    ReadAction
                            .nonBlocking(() -> {
                                // Only perform find operations, no refresh
                                VirtualFile vf = LocalFileSystem.getInstance().findFileByPath(canonicalPath);
                                if (vf == null) {
                                    // Fallback to finding by File object
                                    vf = LocalFileSystem.getInstance().findFileByIoFile(file);
                                }
                                return vf;
                            })
                            .finishOnUiThread(ModalityState.nonModal(), virtualFile -> {
                                // Step 3: Handle the result on UI thread
                                if (virtualFile == null) {
                                    LOG.warn("Could not find virtual file: " + file.getAbsolutePath() + ", retrying with sync refresh...");
                                    // Retry: sync refresh and find (already on UI thread, not under read lock)
                                    VirtualFile retryVf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file);
                                    if (retryVf != null) {
                                        onSuccess.accept(retryVf);
                                    } else {
                                        LOG.error("Failed to find virtual file after retry: " + file.getAbsolutePath());
                                        if (onFailure != null) {
                                            onFailure.run();
                                        }
                                    }
                                    return;
                                }

                                onSuccess.accept(virtualFile);
                            })
                            .submit(AppExecutorUtil.getAppExecutorService());
                } catch (Exception e) {
                    LOG.error("Failed to refresh file system: " + file.getAbsolutePath(), e);
                    if (onFailure != null) {
                        onFailure.run();
                    }
                }
            }, ModalityState.nonModal());

        } catch (Exception e) {
            LOG.error("Failed to get canonical path: " + file.getAbsolutePath(), e);
            if (onFailure != null) {
                ApplicationManager.getApplication().invokeLater(onFailure, ModalityState.nonModal());
            }
        }
    }

    /**
     * Synchronously refresh and find a virtual file on UI thread.
     * WARNING: This should only be called when already on UI thread and not under read lock.
     *
     * @param file the file to refresh and find
     * @return the VirtualFile, or null if not found
     */
    public static VirtualFile refreshAndFindFileSync(File file) {
        try {
            String canonicalPath = file.getCanonicalPath();
            VirtualFile vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(canonicalPath);
            if (vf == null) {
                vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file);
            }
            return vf;
        } catch (Exception e) {
            LOG.error("Failed to refresh and find file: " + file.getAbsolutePath(), e);
            return null;
        }
    }
}
