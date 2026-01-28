package com.github.claudecodegui;

import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.service.GitCommitMessageService;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.CheckinProjectPanel;
import com.intellij.openapi.vcs.CommitMessageI;
import com.intellij.openapi.vcs.VcsDataKeys;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.openapi.vcs.changes.ChangeListManager;
import com.intellij.openapi.vcs.ui.Refreshable;
import org.jetbrains.annotations.NotNull;

import java.util.Collection;

/**
 * Generate Commit Message with AI Action
 * 使用 AI 生成 Git commit message
 */
public class GenerateCommitMessageAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(GenerateCommitMessageAction.class);

    public GenerateCommitMessageAction() {
        super();
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        LOG.info("GenerateCommitMessageAction triggered");

        Project project = e.getProject();
        if (project == null) {
            LOG.warn("Project is null");
            return;
        }

        LOG.info("Project: " + project.getName());

        // 尝试多种方式获取 Commit Panel 和 Changes
        CommitMessageI commitMessagePanel = null;
        Collection<Change> changes = null;

        // 方式 1: 使用 COMMIT_WORKFLOW_HANDLER (新版本 IDEA)
        Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
        LOG.info("COMMIT_WORKFLOW_HANDLER: " + (workflowHandler != null ? workflowHandler.getClass().getName() : "null"));

        if (workflowHandler instanceof CommitMessageI) {
            commitMessagePanel = (CommitMessageI) workflowHandler;
            LOG.info("Successfully obtained CommitMessageI from COMMIT_WORKFLOW_HANDLER");
        }

        // 方式 2: 使用 COMMIT_MESSAGE_CONTROL
        Object messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
        LOG.info("COMMIT_MESSAGE_CONTROL: " + (messageControl != null ? messageControl.getClass().getName() : "null"));

        if (messageControl instanceof CheckinProjectPanel) {
            CheckinProjectPanel checkinPanel = (CheckinProjectPanel) messageControl;
            changes = checkinPanel.getSelectedChanges();
            LOG.info("Got changes from CheckinProjectPanel: " + changes.size());

            if (commitMessagePanel == null && messageControl instanceof CommitMessageI) {
                commitMessagePanel = (CommitMessageI) messageControl;
                LOG.info("Successfully obtained CommitMessageI from COMMIT_MESSAGE_CONTROL (CheckinProjectPanel)");
            }
        }

        // 方式 3: 直接检查 COMMIT_MESSAGE_CONTROL 是否为 CommitMessageI (新版 IDEA 中 CommitMessage 实现了此接口)
        if (commitMessagePanel == null && messageControl instanceof CommitMessageI) {
            commitMessagePanel = (CommitMessageI) messageControl;
            LOG.info("Successfully obtained CommitMessageI from COMMIT_MESSAGE_CONTROL directly");
        }

        // 方式 4: 使用 VcsDataKeys.CHANGES 直接获取 changes
        if (changes == null || changes.isEmpty()) {
            Change[] changesArray = e.getData(VcsDataKeys.CHANGES);
            if (changesArray != null && changesArray.length > 0) {
                changes = java.util.Arrays.asList(changesArray);
                LOG.info("Got changes from VcsDataKeys.CHANGES: " + changes.size());
            }
        }

        // 方式 5: 使用 ChangeListManager 获取所有 changes (作为兜底方案)
        if (changes == null || changes.isEmpty()) {
            ChangeListManager changeListManager = ChangeListManager.getInstance(project);
            Collection<Change> allChanges = changeListManager.getAllChanges();
            if (allChanges != null && !allChanges.isEmpty()) {
                changes = allChanges;
                LOG.info("Got changes from ChangeListManager.getAllChanges: " + changes.size());
            }
        }

        // 检查是否成功获取必需的对象
        if (commitMessagePanel == null) {
            LOG.error("Cannot access commit message panel");
            ClaudeNotifier.showWarning(project, ClaudeCodeGuiBundle.message("commit.cannotAccessPanel"));
            return;
        }

        if (changes == null || changes.isEmpty()) {
            LOG.warn("No changes selected");
            ClaudeNotifier.showWarning(project, ClaudeCodeGuiBundle.message("commit.noChanges"));
            return;
        }

        LOG.info("Successfully obtained CommitMessageI and changes, proceeding to generate commit message");

        // 保存 commitMessagePanel 的引用，用于后续设置消息
        final CommitMessageI finalCommitMessagePanel = commitMessagePanel;
        final Collection<Change> finalChanges = changes;

        // 在提交消息框中显示"正在生成中..."占位文案
        String generatingText = ClaudeCodeGuiBundle.message("commit.generating");
        commitMessagePanel.setCommitMessage(generatingText);

        // 异步生成 commit message
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                GitCommitMessageService service = new GitCommitMessageService(project);
                service.generateCommitMessage(finalChanges, new GitCommitMessageService.CommitMessageCallback() {
                    @Override
                    public void onSuccess(String commitMessage) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            // 设置生成的 commit message
                            finalCommitMessagePanel.setCommitMessage(commitMessage);
                            ClaudeNotifier.showSuccess(project, ClaudeCodeGuiBundle.message("commit.generateSuccess"));
                        });
                    }

                    @Override
                    public void onError(String error) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            // 清空占位文案
                            finalCommitMessagePanel.setCommitMessage("");
                            ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + error);
                        });
                    }
                });
            } catch (Exception ex) {
                LOG.error("Failed to generate commit message", ex);
                ApplicationManager.getApplication().invokeLater(() -> {
                    // 清空占位文案
                    finalCommitMessagePanel.setCommitMessage("");
                    ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + ex.getMessage());
                });
            }
        });
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        boolean enabled = project != null;

        // 调试日志：记录 update 被调用
        if (LOG.isDebugEnabled()) {
            LOG.debug("GenerateCommitMessageAction.update called, project=" + (project != null ? project.getName() : "null"));

            // 记录所有可用的 DataKeys
            Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
            Object messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);

            LOG.debug("Available DataKeys:");
            LOG.debug("  - COMMIT_WORKFLOW_HANDLER: " + (workflowHandler != null ? workflowHandler.getClass().getName() : "null"));
            LOG.debug("  - COMMIT_MESSAGE_CONTROL: " + (messageControl != null ? messageControl.getClass().getName() : "null"));
        }

        // 设置国际化的文案
        e.getPresentation().setText(ClaudeCodeGuiBundle.message("action.generateCommitMessage.text"));
        e.getPresentation().setDescription(ClaudeCodeGuiBundle.message("action.generateCommitMessage.description"));
        e.getPresentation().setEnabledAndVisible(enabled);
    }
}
