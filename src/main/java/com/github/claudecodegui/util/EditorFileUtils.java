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
 * 编辑器上下文信息采集工具类
 *
 * 此工具类用于采集用户在 IDEA 编辑器中的当前工作环境信息，这些信息会被发送给 AI 作为上下文，
 * 帮助 AI 更准确地理解用户的意图和当前所处的代码环境。
 *
 * 采集的上下文信息包括：
 * 1. 当前激活（正在查看）的文件 - 作为 AI 回答问题时的主要关注点
 * 2. 用户选中的代码片段 - 作为用户提问的核心对象
 * 3. 所有打开的文件列表 - 作为潜在相关的上下文参考
 *
 * 这些信息最终会被构建成 JSON 格式，附加到发送给 AI 的系统提示词中，格式如下：
 * {
 *   "active": "当前激活的文件路径#L开始行-结束行",  // 优先级最高，AI 的主要关注点
 *   "selection": {                                  // 如果用户选中了代码，这是 AI 应该重点分析的内容
 *     "startLine": 起始行号,
 *     "endLine": 结束行号,
 *     "selectedText": "用户选中的代码内容"
 *   },
 *   "others": ["其他打开的文件路径1", "其他打开的文件路径2"]  // 潜在相关的上下文，优先级最低
 * }
 */
public class EditorFileUtils {

    private static final Logger LOG = Logger.getInstance(EditorFileUtils.class);

    /**
     * 获取当前项目中所有打开的文件路径
     *
     * 此方法用于采集用户在 IDEA 中打开的所有文件，这些文件可能与用户当前的工作任务相关。
     * 返回的文件列表会被发送给 AI 作为潜在的上下文参考，帮助 AI 理解：
     * - 用户当前可能正在处理哪些相关文件
     * - 用户的工作范围和关注的代码模块
     * - 跨文件的代码关联和依赖关系
     *
     * 注意：此列表包含所有打开的文件，但激活文件（用户当前正在查看的文件）会被单独标记，
     *       因为它通常是用户提问的主要对象。
     *
     * @param project IDEA 项目对象
     * @return 打开的文件路径列表（绝对路径）
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
     *
     * 此方法返回用户当前正在查看/编辑的文件，这个文件通常是用户提问的主要对象。
     *
     * 重要性说明：
     * - 这是 AI 理解用户意图的核心线索，优先级最高
     * - 当用户提问时没有明确指定文件时，AI 应该默认关注这个文件
     * - 如果用户同时选中了代码，则这个文件路径 + 选中的代码片段共同构成 AI 的主要分析对象
     *
     * 使用场景示例：
     * - 用户问"这段代码有什么问题"时，AI 会优先分析这个文件中选中的代码
     * - 用户问"这个类的作用是什么"时，AI 会分析这个文件中的类定义
     * - 用户问"如何优化性能"时，AI 会从这个文件的代码出发给出建议
     *
     * @param project IDEA 项目对象
     * @return 当前激活的文件路径（绝对路径），如果没有打开任何文件则返回 null
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
     *
     * 此方法返回用户在编辑器中选中的代码片段及其位置信息。选中的代码通常是用户提问的核心对象，
     * 具有最高的优先级，AI 应该将其作为主要的分析目标。
     *
     * 优先级说明：
     * 选中的代码 > 当前激活的文件 > 其他打开的文件
     *
     * 重要性说明：
     * - 当用户选中代码时，这通常是一个强烈的信号，表明用户想要 AI 重点关注这段代码
     * - AI 在回答问题时应该将选中的代码作为 PRIMARY FOCUS（主要焦点）
     * - 即使用户的提问很模糊（如"有什么问题"），AI 也应该优先分析这段选中的代码
     *
     * 使用场景示例：
     * - 用户选中一个函数并问"这段代码有什么问题" → AI 应该分析这个函数的逻辑、潜在 bug、代码质量等
     * - 用户选中一个类并问"如何优化" → AI 应该针对这个类的设计、性能、可维护性等方面给出建议
     * - 用户选中一段代码并问"解释一下" → AI 应该详细解释这段代码的功能、逻辑流程、关键语法等
     *
     * 返回值说明：
     * - startLine: 选中代码的起始行号（从 1 开始）
     * - endLine: 选中代码的结束行号（从 1 开始）
     * - selectedText: 用户选中的完整代码文本内容
     *
     * @param project IDEA 项目对象
     * @return 包含选中信息的 Map，如果没有选中任何代码则返回 null
     *         Map 包含: startLine (Integer), endLine (Integer), selectedText (String)
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
