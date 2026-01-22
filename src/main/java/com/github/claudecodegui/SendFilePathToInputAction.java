package com.github.claudecodegui;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;

/**
 * 从文件树发送文件路径到 CCG 输入框的 Action
 * 在项目文件树右键菜单中显示
 * 实现 DumbAware 接口允许在索引构建期间使用此功能
 */
public class SendFilePathToInputAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(SendFilePathToInputAction.class);

    /**
     * 构造函数 - 设置本地化的Action文本和描述
     */
    public SendFilePathToInputAction() {
        super(
            ClaudeCodeGuiBundle.message("action.sendFilePath.text"),
            ClaudeCodeGuiBundle.message("action.sendFilePath.description"),
            null
        );
    }

    /**
     * 指定 Action 更新线程为后台线程
     * 这允许在 update() 方法中安全地访问 VirtualFile 等数据
     */
    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    /**
     * 执行Action的主要逻辑
     */
    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }

        // 获取选中的文件
        VirtualFile[] files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY);
        if (files == null || files.length == 0) {
            VirtualFile file = e.getData(CommonDataKeys.VIRTUAL_FILE);
            if (file != null) {
                files = new VirtualFile[]{file};
            }
        }

        if (files == null || files.length == 0) {
            LOG.warn("No files selected");
            return;
        }

        // 构建文件路径字符串（支持多选）
        StringBuilder pathBuilder = new StringBuilder();
        for (int i = 0; i < files.length; i++) {
            if (i > 0) {
                pathBuilder.append(" ");
            }
            // 添加 @ 前缀和绝对路径
            pathBuilder.append("@").append(files[i].getPath());
        }

        String filePaths = pathBuilder.toString();
        LOG.info("Sending file paths to input: " + filePaths);

        // 发送到聊天窗口
        sendToChatWindow(project, filePaths);
    }

    /**
     * 更新Action的可用性状态
     * 只有在有选中文件时才启用
     */
    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            e.getPresentation().setEnabledAndVisible(false);
            return;
        }

        // 检查是否有选中的文件
        VirtualFile[] files = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY);
        if (files == null || files.length == 0) {
            VirtualFile file = e.getData(CommonDataKeys.VIRTUAL_FILE);
            if (file == null) {
                e.getPresentation().setEnabledAndVisible(false);
                return;
            }
        }

        e.getPresentation().setEnabledAndVisible(true);
    }

    /**
     * 发送文件路径到插件的聊天窗口输入框
     */
    private void sendToChatWindow(@NotNull Project project, @NotNull String filePaths) {
        try {
            // 获取插件的工具窗口
            ToolWindowManager toolWindowManager = ToolWindowManager.getInstance(project);
            ToolWindow toolWindow = toolWindowManager.getToolWindow("CCG");

            if (toolWindow != null) {
                // 如果窗口未激活，先激活窗口，等待窗口打开后再发送内容
                if (!toolWindow.isVisible()) {
                    // 激活窗口
                    toolWindow.activate(() -> {
                        // 窗口激活后，延迟一小段时间确保界面加载完成，然后发送内容
                        ApplicationManager.getApplication().invokeLater(() -> {
                            try {
                                Thread.sleep(300); // 等待300ms确保界面加载完成
                                ClaudeSDKToolWindow.addSelectionFromExternal(project, filePaths);
                                LOG.info("Window activated and sent file paths to project: " + project.getName());
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            }
                        });
                    }, true);
                } else {
                    // 窗口已经打开，直接发送内容
                    ClaudeSDKToolWindow.addSelectionFromExternal(project, filePaths);
                    // 确保窗口获得焦点
                    toolWindow.activate(null, true);
                    LOG.info("Chat window activated and sent file paths to project: " + project.getName());
                }
            } else {
                LOG.error("CCG tool window not found");
            }

        } catch (Exception ex) {
            LOG.error("Failed to send to chat window: " + ex.getMessage(), ex);
        }
    }
}
