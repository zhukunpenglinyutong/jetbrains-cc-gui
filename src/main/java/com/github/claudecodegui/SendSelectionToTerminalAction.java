package com.github.claudecodegui;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.editor.SelectionModel;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.util.concurrency.AppExecutorUtil;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.io.File;

/**
 * Action that sends selected code to the plugin chat window.
 * Supports cross-platform shortcuts: Mac (Cmd+Option+K) and Windows/Linux (Ctrl+Alt+K).
 * Implements DumbAware to allow usage during index building.
 */
public class SendSelectionToTerminalAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(SendSelectionToTerminalAction.class);

    /**
     * Constructor - sets up localized action text and description.
     */
    public SendSelectionToTerminalAction() {
        super(
            ClaudeCodeGuiBundle.message("action.sendToGui.text"),
            ClaudeCodeGuiBundle.message("action.sendToGui.description"),
            null
        );
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    /**
     * Main logic for executing the action.
     */
    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }

        try {
            // Use ReadAction.nonBlocking() to safely retrieve file information on a background thread
            ReadAction
                .nonBlocking(() -> {
                    // Retrieve selected code and file information on the background thread
                    return getSelectionInfo(e);
                })
                .finishOnUiThread(com.intellij.openapi.application.ModalityState.defaultModalityState(), selectionInfo -> {
                    if (selectionInfo == null) {
                        return; // Error message already shown within the method
                    }

                    // Send to the plugin chat window (executed on the UI thread)
                    sendToChatWindow(project, selectionInfo);
                    LOG.info("已添加到待发送: " + selectionInfo);
                })
                .submit(AppExecutorUtil.getAppExecutorService());

        } catch (Exception ex) {
            showError(project, ClaudeCodeGuiBundle.message("send.failed", ex.getMessage()));
            LOG.error("Error: " + ex.getMessage(), ex);
        }
    }

    /**
     * Updates the action's availability state.
     * Only enabled when an editor is active, a file is open, and text is selected.
     */
    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        Editor editor = e.getData(CommonDataKeys.EDITOR);
        if (editor == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        SelectionModel selectionModel = editor.getSelectionModel();
        String selectedText = selectionModel.getSelectedText();

        // Only enable when there is selected text
        e.getPresentation().setEnabledAndVisible(selectedText != null && !selectedText.isEmpty());
    }

    /**
     * Retrieves selected code information and formats it into the specified format.
     */
    private @Nullable String getSelectionInfo(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        Editor editor = e.getData(CommonDataKeys.EDITOR);

        if (project == null || editor == null) {
            showError(project, ClaudeCodeGuiBundle.message("send.cannotGetEditor"));
            return null;
        }

        SelectionModel selectionModel = editor.getSelectionModel();
        String selectedText = selectionModel.getSelectedText();

        // Check if there is any selected text
        if (selectedText == null || selectedText.trim().isEmpty()) {
            showInfo(project, ClaudeCodeGuiBundle.message("send.selectCodeFirst"));
            return null;
        }

        // Get the current file
        VirtualFile[] selectedFiles = FileEditorManager.getInstance(project).getSelectedFiles();
        if (selectedFiles.length == 0) {
            showError(project, ClaudeCodeGuiBundle.message("send.cannotGetFile"));
            return null;
        }
        VirtualFile virtualFile = selectedFiles[0];

        // Get the project-relative path
        String relativePath = getRelativePath(project, virtualFile);
        if (relativePath == null) {
            showError(project, ClaudeCodeGuiBundle.message("send.cannotGetFilePath"));
            return null;
        }

        // Get the line numbers for the selection range
        int startOffset = selectionModel.getSelectionStart();
        int endOffset = selectionModel.getSelectionEnd();

        int startLine = editor.getDocument().getLineNumber(startOffset) + 1; // +1 because line numbers are 1-based
        int endLine = editor.getDocument().getLineNumber(endOffset) + 1;

        // Format the output: @path#Lstart-Lend
        // For a single line, show only one line number
        String formattedPath;
        if (startLine == endLine) {
            formattedPath = "@" + relativePath + "#L" + startLine;
        } else {
            formattedPath = "@" + relativePath + "#L" + startLine + "-" + endLine;
        }

        return formattedPath;
    }

    /**
     * Gets the absolute path of the file (from the filesystem root).
     */
    private @Nullable String getRelativePath(@NotNull Project project, @NotNull VirtualFile file) {
        try {
            // Get the absolute path of the file
            String absolutePath = file.getPath();
            LOG.debug("文件绝对路径: " + absolutePath);
            return absolutePath;
        } catch (Exception ex) {
            LOG.error("获取文件路径异常: " + ex.getMessage(), ex);
            return null;
        }
    }

    /**
     * Sends the selection information to the plugin chat window.
     */
    private void sendToChatWindow(@NotNull Project project, @NotNull String text) {
        try {
            // Get the plugin tool window
            ToolWindowManager toolWindowManager = ToolWindowManager.getInstance(project);
            ToolWindow toolWindow = toolWindowManager.getToolWindow("CCG");

            if (toolWindow != null) {
                // If the window is not visible, activate it first and wait for it to open before sending content
                if (!toolWindow.isVisible()) {
                    // Activate the window
                    toolWindow.activate(() -> {
                        // After window activation, add a short delay to ensure the UI is fully loaded, then send content
                        ApplicationManager.getApplication().invokeLater(() -> {
                            try {
                                Thread.sleep(300); // Wait 300ms to ensure the UI is fully loaded
                                ClaudeSDKToolWindow.addSelectionFromExternal(project, text);
                                LOG.info("窗口已激活并发送内容到项目: " + project.getName());
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                        });
                    }, true);
                } else {
                    // Window is already open, send content directly
                    ClaudeSDKToolWindow.addSelectionFromExternal(project, text);
                    // Ensure the window gains focus
                    toolWindow.activate(null, true);
                    LOG.info("聊天窗口已激活并发送内容到项目: " + project.getName());
                }
            } else {
                showError(project, ClaudeCodeGuiBundle.message("send.toolWindowNotFound"));
            }

        } catch (Exception ex) {
            showError(project, ClaudeCodeGuiBundle.message("send.sendToChatFailed", ex.getMessage()));
            LOG.error("Error occurred", ex);
        }
    }

    /**
     * Displays an error message.
     */
    private void showError(@Nullable Project project, @NotNull String message) {
        LOG.error(message);
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                com.intellij.openapi.ui.Messages.showErrorDialog(project, message, ClaudeCodeGuiBundle.message("dialog.error.title"));
            });
        }
    }

    /**
     * Displays an informational message.
     */
    private void showInfo(@Nullable Project project, @NotNull String message) {
        LOG.info(message);
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                com.intellij.openapi.ui.Messages.showInfoMessage(project, message, ClaudeCodeGuiBundle.message("dialog.info.title"));
            });
        }
    }
}

