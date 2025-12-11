package com.github.claudecodegui.util;

import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.fileEditor.FileEditor;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.TextEditor;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 编辑器文件工具类
 * 用于获取 IDEA 中当前打开的文件信息
 */
public class EditorFileUtils {

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
            System.err.println("[EditorFileUtils] Error getting opened files: " + e.getMessage());
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
            System.err.println("[EditorFileUtils] Error getting active file: " + e.getMessage());
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

                        System.out.println("[EditorFileUtils] Selection detected: lines " + startLine + "-" + endLine);
                        return selectionInfo;
                    }
                }
            }
        } catch (Exception e) {
            System.err.println("[EditorFileUtils] Error getting selected code: " + e.getMessage());
        }

        return null;
    }
}
