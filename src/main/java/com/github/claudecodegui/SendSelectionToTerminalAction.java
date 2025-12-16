package com.github.claudecodegui;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ReadAction;
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
 * 将选中的代码发送到插件聊天窗口的Action
 * 支持跨平台快捷键：Mac(Cmd+Option+K) 和 Windows/Linux(Ctrl+Alt+K)
 * 实现 DumbAware 接口允许在索引构建期间使用此功能
 */
public class SendSelectionToTerminalAction extends AnAction implements DumbAware {

    /**
     * 执行Action的主要逻辑
     */
    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }

        try {
            // 使用 ReadAction.nonBlocking() 在后台线程中安全地获取文件信息
            ReadAction
                .nonBlocking(() -> {
                    // 在后台线程中获取选中代码和文件信息
                    return getSelectionInfo(e);
                })
                .finishOnUiThread(com.intellij.openapi.application.ModalityState.defaultModalityState(), selectionInfo -> {
                    if (selectionInfo == null) {
                        return; // 错误信息已在方法内显示
                    }

                    // 发送到插件的聊天窗口（在 UI 线程执行）
                    sendToChatWindow(project, selectionInfo);
                    System.out.println("[SendSelectionToTerminalAction] 已添加到待发送: " + selectionInfo);
                })
                .submit(AppExecutorUtil.getAppExecutorService());

        } catch (Exception ex) {
            showError(project, "发送失败: " + ex.getMessage());
            System.err.println("[SendSelectionToTerminalAction] Error: " + ex.getMessage());
            ex.printStackTrace();
        }
    }

    /**
     * 更新Action的可用性状态
     * 只有在有编辑器、有文件打开、有选中内容时才启用
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

        // 只有选中内容时才启用
        e.getPresentation().setEnabledAndVisible(selectedText != null && !selectedText.isEmpty());
    }

    /**
     * 获取选中的代码信息并格式化为指定格式
     */
    private @Nullable String getSelectionInfo(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        Editor editor = e.getData(CommonDataKeys.EDITOR);

        if (project == null || editor == null) {
            showError(project, "无法获取编辑器信息");
            return null;
        }

        SelectionModel selectionModel = editor.getSelectionModel();
        String selectedText = selectionModel.getSelectedText();

        // 检查是否有选中内容
        if (selectedText == null || selectedText.trim().isEmpty()) {
            showInfo(project, "请先选中要发送的代码");
            return null;
        }

        // 获取当前文件
        VirtualFile[] selectedFiles = FileEditorManager.getInstance(project).getSelectedFiles();
        if (selectedFiles.length == 0) {
            showError(project, "无法获取当前文件");
            return null;
        }
        VirtualFile virtualFile = selectedFiles[0];

        // 获取相对项目路径
        String relativePath = getRelativePath(project, virtualFile);
        if (relativePath == null) {
            showError(project, "无法确定文件路径");
            return null;
        }

        // 获取选中范围的行号
        int startOffset = selectionModel.getSelectionStart();
        int endOffset = selectionModel.getSelectionEnd();

        int startLine = editor.getDocument().getLineNumber(startOffset) + 1; // +1 因为行号从1开始
        int endLine = editor.getDocument().getLineNumber(endOffset) + 1;

        // 格式化输出：@path#Lstart-Lend
        // 如果是单行，只显示一个行号
        String formattedPath;
        if (startLine == endLine) {
            formattedPath = "@" + relativePath + "#L" + startLine;
        } else {
            formattedPath = "@" + relativePath + "#L" + startLine + "-" + endLine;
        }

        return formattedPath;
    }

    /**
     * 获取文件的绝对路径（从电脑根目录开始）
     */
    private @Nullable String getRelativePath(@NotNull Project project, @NotNull VirtualFile file) {
        try {
            // 获取文件的绝对路径
            String absolutePath = file.getPath();
            System.out.println("[SendSelectionToTerminalAction] 文件绝对路径: " + absolutePath);
            return absolutePath;
        } catch (Exception ex) {
            System.err.println("[SendSelectionToTerminalAction] 获取文件路径异常: " + ex.getMessage());
            ex.printStackTrace();
            return null;
        }
    }

    /**
     * 发送选中信息到插件的聊天窗口
     */
    private void sendToChatWindow(@NotNull Project project, @NotNull String text) {
        try {
            // 获取插件的工具窗口
            ToolWindowManager toolWindowManager = ToolWindowManager.getInstance(project);
            ToolWindow toolWindow = toolWindowManager.getToolWindow("Claude Code GUI");

            if (toolWindow != null) {
                // 如果窗口未激活，先激活窗口，等待窗口打开后再发送内容
                if (!toolWindow.isVisible()) {
                    // 激活窗口
                    toolWindow.activate(() -> {
                        // 窗口激活后，延迟一小段时间确保界面加载完成，然后发送内容
                        ApplicationManager.getApplication().invokeLater(() -> {
                            try {
                                Thread.sleep(300); // 等待300ms确保界面加载完成
                                ClaudeSDKToolWindow.addSelectionFromExternal(project, text);
                                System.out.println("[SendSelectionToTerminalAction] 窗口已激活并发送内容到项目: " + project.getName());
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                        });
                    }, true);
                } else {
                    // 窗口已经打开，直接发送内容
                    ClaudeSDKToolWindow.addSelectionFromExternal(project, text);
                    // 确保窗口获得焦点
                    toolWindow.activate(null, true);
                    System.out.println("[SendSelectionToTerminalAction] 聊天窗口已激活并发送内容到项目: " + project.getName());
                }
            } else {
                showError(project, "找不到 Claude Code GUI 工具窗口");
            }

        } catch (Exception ex) {
            showError(project, "发送到聊天窗口失败: " + ex.getMessage());
            ex.printStackTrace();
        }
    }

    /**
     * 显示错误信息
     */
    private void showError(@Nullable Project project, @NotNull String message) {
        System.err.println("[SendSelectionToTerminalAction] " + message);
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                com.intellij.openapi.ui.Messages.showErrorDialog(project, message, "错误");
            });
        }
    }

    /**
     * 显示信息提示
     */
    private void showInfo(@Nullable Project project, @NotNull String message) {
        System.out.println("[SendSelectionToTerminalAction] " + message);
        if (project != null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                com.intellij.openapi.ui.Messages.showInfoMessage(project, message, "提示");
            });
        }
    }
}

