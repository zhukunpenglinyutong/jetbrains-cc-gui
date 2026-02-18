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
 * Editor context information collector.
 *
 * This utility collects the user's current working environment in the IDEA editor.
 * The gathered information is sent to the AI as context, helping it better understand
 * the user's intent and the current code environment.
 *
 * The collected context includes:
 * 1. The currently active (viewed) file - serves as the AI's primary focus when answering questions
 * 2. The user's selected code snippet - the core subject of the user's question
 * 3. The list of all open files - potential contextual references
 *
 * This information is built into JSON format and appended to the system prompt sent to the AI:
 * {
 *   "active": "path/to/active/file#Lstart-end",  // Highest priority, AI's primary focus
 *   "selection": {                                 // If code is selected, the AI should analyze this first
 *     "startLine": startLineNumber,
 *     "endLine": endLineNumber,
 *     "selectedText": "the selected code content"
 *   },
 *   "others": ["path/to/other/file1", "path/to/other/file2"]  // Potentially related context, lowest priority
 * }
 */
public class EditorFileUtils {

    private static final Logger LOG = Logger.getInstance(EditorFileUtils.class);

    /**
     * Get all open file paths in the current project.
     *
     * Collects all files the user has open in IDEA, which may be related to their current task.
     * The returned file list is sent to the AI as potential context references, helping it understand:
     * - Which related files the user might be working on
     * - The user's working scope and the code modules they are focused on
     * - Cross-file code relationships and dependencies
     *
     * Note: This list includes all open files, but the active file (the one currently being viewed)
     *       is marked separately since it is typically the primary subject of the user's question.
     *
     * @param project the IDEA project
     * @return list of open file paths (absolute paths)
     */
    public static List<String> getOpenedFiles(Project project) {
        List<String> openedFiles = new ArrayList<>();

        if (project == null) {
            return openedFiles;
        }

        try {
            // Get the file editor manager
            FileEditorManager fileEditorManager = FileEditorManager.getInstance(project);

            // Get all open files
            VirtualFile[] openFiles = fileEditorManager.getOpenFiles();

            // Extract file paths
            for (VirtualFile file : openFiles) {
                if (file != null && file.getPath() != null) {
                    openedFiles.add(file.getPath());
                }
            }
        } catch (Exception e) {
            // Catch exceptions to avoid disrupting the main flow
            LOG.error("[EditorFileUtils] Error getting opened files: " + e.getMessage());
        }

        return openedFiles;
    }

    /**
     * Get the path of the currently active (viewed) file.
     *
     * Returns the file the user is currently viewing or editing, which is typically the
     * primary subject of their question.
     *
     * Importance:
     * - This is the most critical clue for the AI to understand the user's intent (highest priority)
     * - When the user asks a question without specifying a file, the AI should focus on this file by default
     * - If the user has also selected code, this file path combined with the selection forms
     *   the AI's primary analysis target
     *
     * Usage examples:
     * - "What's wrong with this code?" - AI analyzes the selected code in this file first
     * - "What does this class do?" - AI analyzes the class definition in this file
     * - "How to optimize performance?" - AI provides suggestions based on this file's code
     *
     * @param project the IDEA project
     * @return the active file path (absolute), or null if no file is open
     */
    public static String getCurrentActiveFile(Project project) {
        if (project == null) {
            return null;
        }

        try {
            FileEditorManager fileEditorManager = FileEditorManager.getInstance(project);

            // Get the currently selected file
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
     * Get information about the selected code in the currently active file.
     *
     * Returns the code snippet and its location that the user has selected in the editor.
     * Selected code is typically the core subject of the user's question and has the highest priority;
     * the AI should treat it as the primary analysis target.
     *
     * Priority order:
     * Selected code > Currently active file > Other open files
     *
     * Importance:
     * - When the user selects code, it is a strong signal that they want the AI to focus on that code
     * - The AI should treat selected code as the PRIMARY FOCUS when answering questions
     * - Even with a vague question (e.g., "anything wrong?"), the AI should prioritize analyzing the selection
     *
     * Usage examples:
     * - User selects a function and asks "what's wrong with this code?" - AI should analyze logic, potential bugs, code quality, etc.
     * - User selects a class and asks "how to optimize?" - AI should advise on design, performance, maintainability, etc.
     * - User selects code and asks "explain this" - AI should explain functionality, logic flow, key syntax, etc.
     *
     * Return value details:
     * - startLine: the starting line number of the selection (1-based)
     * - endLine: the ending line number of the selection (1-based)
     * - selectedText: the full text content of the user's selection
     *
     * @param project the IDEA project
     * @return a Map containing selection info, or null if no code is selected.
     *         The Map contains: startLine (Integer), endLine (Integer), selectedText (String)
     */
    public static Map<String, Object> getSelectedCodeInfo(Project project) {
        if (project == null) {
            return null;
        }

        try {
            FileEditorManager fileEditorManager = FileEditorManager.getInstance(project);

            // Get the currently selected editor
            FileEditor selectedEditor = fileEditorManager.getSelectedEditor();
            if (selectedEditor instanceof TextEditor) {
                Editor editor = ((TextEditor) selectedEditor).getEditor();
                SelectionModel selectionModel = editor.getSelectionModel();

                // Check if any text is selected
                if (selectionModel.hasSelection()) {
                    String selectedText = selectionModel.getSelectedText();
                    if (selectedText != null && !selectedText.trim().isEmpty()) {
                        int startOffset = selectionModel.getSelectionStart();
                        int endOffset = selectionModel.getSelectionEnd();

                        // Convert to line numbers (1-based)
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
