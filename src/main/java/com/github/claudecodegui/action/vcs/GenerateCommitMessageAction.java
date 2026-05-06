package com.github.claudecodegui.action.vcs;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.service.GitCommitMessageService;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.notification.Notification;
import com.intellij.notification.NotificationAction;
import com.intellij.notification.NotificationGroupManager;
import com.intellij.notification.NotificationType;
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
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * Action to generate Git commit messages using AI.
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

        // Get CommitMessageI for setting the commit message
        CommitMessageI commitMessagePanel = getCommitMessagePanel(e);

        // Get user-selected changes using the new method with proper fallback chain
        Collection<Change> changes = getUserSelectedChanges(e, project);

        // Check if we successfully obtained required objects
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

        // Start generation with system notification cancel support
        final Notification[] notificationHolder = {null};
        startGeneration(project, commitMessagePanel, changes, notificationHolder);
    }

    /**
     * Show retry notification with options to retry.
     */
    private void showRetryNotification(
            @NotNull Project project,
            @NotNull CommitMessageI commitMessagePanel,
            @NotNull Collection<Change> changes,
            @NotNull Notification[] notificationHolder) {

        ApplicationManager.getApplication().invokeLater(() -> {
            Notification notification = NotificationGroupManager.getInstance()
                .getNotificationGroup("CC GUI Notifications")
                .createNotification(
                    ClaudeCodeGuiBundle.message("commit.progress.cancelRetry"),
                    NotificationType.WARNING
                );

            notification.addAction(new NotificationAction(ClaudeCodeGuiBundle.message("commit.progress.retry")) {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e, @NotNull Notification notification) {
                    notification.expire();
                    startGeneration(project, commitMessagePanel, changes, notificationHolder);
                }
            });

            notification.notify(project);
        });
    }

    /**
     * Start the commit message generation process with notification cancel support.
     */
    private void startGeneration(
            @NotNull Project project,
            @NotNull CommitMessageI commitMessagePanel,
            @NotNull Collection<Change> changes,
            @NotNull Notification[] notificationHolder) {

        final CommitMessageI finalCommitMessagePanel = commitMessagePanel;
        final Collection<Change> finalChanges = changes;
        final long[] startTime = {System.currentTimeMillis()};
        final Timer[] timerHolder = {null};
        final String[] lastProgressMessage = {""};
        final boolean[] hasValidCommit = {false};
        final boolean[] isCancelled = {false};

        // Get model info before starting generation
        final String[] modelInfo = {""};
        try {
            GitCommitMessageService tempService = new GitCommitMessageService(project);
            modelInfo[0] = tempService.getModelDisplayText();
        } catch (Exception e) {
            LOG.warn("Failed to get model info", e);
            modelInfo[0] = "🤖 " + ClaudeCodeGuiBundle.message("commit.progress.unknownModel");
        }
        final String finalModelInfo = modelInfo[0];

        // Set initial status with model info
        ApplicationManager.getApplication().invokeLater(() -> {
            String initializingText = ClaudeCodeGuiBundle.message("commit.progress.initializing") + "...";
            lastProgressMessage[0] = initializingText;
            String initialStatus = finalModelInfo + "\n\n" + initializingText;
            finalCommitMessagePanel.setCommitMessage(initialStatus);
        });

        // Create timer for progress display
        Timer timer = new Timer(1000, new ActionListener() {
            @Override
            public void actionPerformed(ActionEvent e) {
                if (isCancelled[0]) {
                    return;
                }

                if (!hasValidCommit[0]) {
                    long elapsed = System.currentTimeMillis() - startTime[0];
                    int seconds = (int) (elapsed / 1000);
                    int minutes = seconds / 60;
                    seconds = seconds % 60;

                    String timeText = String.format("%02d:%02d", minutes, seconds);
                    String hint = ClaudeCodeGuiBundle.message("commit.progress.hint");
                    if (elapsed > 10000) {
                        hint = ClaudeCodeGuiBundle.message("commit.progress.takingTime");
                    }

                    // Keep model info at the top, then progress/hint/timer
                    String status = finalModelInfo + "\n\n" + lastProgressMessage[0] + "\n\n" + hint + "\n" +
                                   String.format("⏱ %s", timeText);

                    finalCommitMessagePanel.setCommitMessage(status);
                }
            }
        });
        timerHolder[0] = timer;
        timer.start();

        // Show notification with cancel button
        ApplicationManager.getApplication().invokeLater(() -> {
            Notification notification = NotificationGroupManager.getInstance()
                .getNotificationGroup("CC GUI Notifications")
                .createNotification(
                    ClaudeCodeGuiBundle.message("commit.generating"),
                    NotificationType.INFORMATION
                );
            notification.addAction(new NotificationAction(ClaudeCodeGuiBundle.message("commit.progress.cancel")) {
                @Override
                public void actionPerformed(@NotNull AnActionEvent e, @NotNull Notification notification) {
                    isCancelled[0] = true;
                    if (timerHolder[0] != null) {
                        timerHolder[0].stop();
                    }

                    finalCommitMessagePanel.setCommitMessage(ClaudeCodeGuiBundle.message("commit.progress.initializing") +
                        "... " + ClaudeCodeGuiBundle.message("commit.progress.cancel"));

                    notification.expire();
                    showRetryNotification(project, finalCommitMessagePanel, finalChanges, notificationHolder);
                }
            });
            notificationHolder[0] = notification;
            notification.notify(project);
        });

        // Generate commit message
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                GitCommitMessageService service = new GitCommitMessageService(project);
                service.generateCommitMessage(finalChanges, new GitCommitMessageService.CommitMessageCallback() {
                    @Override
                    public void onProgress(String partialMessage) {
                        if (isCancelled[0]) return;

                        ApplicationManager.getApplication().invokeLater(() -> {
                            lastProgressMessage[0] = partialMessage;

                            if (partialMessage != null && !partialMessage.isEmpty() &&
                                !partialMessage.contains("...") &&
                                (partialMessage.matches("^(feat|fix|refactor|docs|test|chore|perf|ci|style|build|revert)(\\(.+\\))?:.*") ||
                                 partialMessage.contains("\n"))) {
                                hasValidCommit[0] = true;
                            }

                            finalCommitMessagePanel.setCommitMessage(partialMessage);
                        });
                    }

                    @Override
                    public void onSuccess(String commitMessage) {
                        if (isCancelled[0]) return;

                        if (timerHolder[0] != null) {
                            timerHolder[0].stop();
                        }
                        if (notificationHolder[0] != null) {
                            notificationHolder[0].expire();
                        }
                        hasValidCommit[0] = true;

                        ApplicationManager.getApplication().invokeLater(() -> {
                            finalCommitMessagePanel.setCommitMessage(commitMessage);
                            ClaudeNotifier.showSuccess(project, ClaudeCodeGuiBundle.message("commit.generateSuccess"));
                        });
                    }

                    @Override
                    public void onError(String error) {
                        if (isCancelled[0]) return;

                        if (timerHolder[0] != null) {
                            timerHolder[0].stop();
                        }
                        if (notificationHolder[0] != null) {
                            notificationHolder[0].expire();
                        }

                        ApplicationManager.getApplication().invokeLater(() -> {
                            finalCommitMessagePanel.setCommitMessage(ClaudeCodeGuiBundle.message("commit.progress.error") + ": " + error);
                            ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + error);
                        });
                    }
                });
            } catch (Exception ex) {
                if (timerHolder[0] != null) {
                    timerHolder[0].stop();
                }
                if (notificationHolder[0] != null) {
                    notificationHolder[0].expire();
                }

                LOG.error("Failed to generate commit message", ex);
                ApplicationManager.getApplication().invokeLater(() -> {
                    finalCommitMessagePanel.setCommitMessage(ClaudeCodeGuiBundle.message("commit.progress.error") + ": " + ex.getMessage());
                    ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + ex.getMessage());
                });
            }
        });
    }

    /**
     * Get CommitMessageI from available data sources.
     */
    @Nullable
    private CommitMessageI getCommitMessagePanel(@NotNull AnActionEvent e) {
        // Try COMMIT_WORKFLOW_HANDLER first (newer IDEA versions)
        Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
        if (workflowHandler instanceof CommitMessageI) {
            LOG.info("Got CommitMessageI from COMMIT_WORKFLOW_HANDLER");
            return (CommitMessageI) workflowHandler;
        }

        // Try COMMIT_MESSAGE_CONTROL
        CommitMessageI messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
        if (messageControl != null) {
            LOG.info("Got CommitMessageI from COMMIT_MESSAGE_CONTROL");
            return messageControl;
        }

        return null;
    }

    /**
     * Get user-selected changes from the commit dialog.
     * Uses a fallback chain to support different IDEA versions:
     * 1. COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges() - preferred, gets user-checked files
     * 2. CheckinProjectPanel.getSelectedChanges() - legacy fallback
     * 3. VcsDataKeys.CHANGES - context-based fallback
     * 4. ChangeListManager.getAllChanges() - last resort fallback
     */
    @Nullable
    private Collection<Change> getUserSelectedChanges(@NotNull AnActionEvent e, @NotNull Project project) {
        Collection<Change> changes;

        // Method 1: Try COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges() via reflection
        // This is the preferred method as it returns only user-checked files in the commit dialog
        Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
        if (workflowHandler != null) {
            changes = getIncludedChangesViaReflection(workflowHandler);
            if (changes != null && !changes.isEmpty()) {
                LOG.info("Got " + changes.size() + " changes from COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges()");
                return changes;
            }
        }

        // Method 2: Try CheckinProjectPanel.getSelectedChanges() (legacy)
        Object messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
        if (messageControl instanceof CheckinProjectPanel checkinPanel) {
            changes = checkinPanel.getSelectedChanges();
            if (changes != null && !changes.isEmpty()) {
                LOG.info("Got " + changes.size() + " changes from CheckinProjectPanel.getSelectedChanges() (fallback)");
                return changes;
            }
        }

        // Method 3: Try VcsDataKeys.CHANGES
        Change[] changesArray = e.getData(VcsDataKeys.CHANGES);
        if (changesArray != null && changesArray.length > 0) {
            changes = java.util.Arrays.asList(changesArray);
            LOG.info("Got " + changes.size() + " changes from VcsDataKeys.CHANGES (fallback)");
            return changes;
        }

        // Method 4: Last resort - get all changes from ChangeListManager
        ChangeListManager changeListManager = ChangeListManager.getInstance(project);
        Collection<Change> allChanges = changeListManager.getAllChanges();
        if (!allChanges.isEmpty()) {
            LOG.info("Got " + allChanges.size() + " changes from ChangeListManager.getAllChanges() (last resort fallback)");
            return allChanges;
        }

        LOG.warn("Failed to get changes from any data source");
        return null;
    }

    /**
     * Get included changes from AbstractCommitWorkflowHandler via reflection.
     * This method uses reflection to call handler.ui.getIncludedChanges() which returns
     * only the files that the user has checked in the commit dialog.
     * <p>
     * The reflection approach is necessary because:
     * - AbstractCommitWorkflowHandler.ui.getIncludedChanges() was introduced in newer IDEA versions
     * - Direct method call would cause ClassNotFoundException in older IDEA versions
     * - This allows graceful degradation when the API is unavailable
     */
    @Nullable
    private Collection<Change> getIncludedChangesViaReflection(@NotNull Object workflowHandler) {
        try {
            // Get the 'ui' property from AbstractCommitWorkflowHandler
            // The ui property is of type CommitWorkflowUi which has getIncludedChanges() method
            Method getUiMethod = workflowHandler.getClass().getMethod("getUi");
            Object ui = getUiMethod.invoke(workflowHandler);

            if (ui == null) {
                LOG.debug("workflowHandler.getUi() returned null");
                return null;
            }

            // Call getIncludedChanges() on the ui object
            // This returns List<Change> containing only user-checked files
            Method getIncludedChangesMethod = ui.getClass().getMethod("getIncludedChanges");
            Object result = getIncludedChangesMethod.invoke(ui);

            if (result instanceof Collection<?> col) {
                List<Change> changes = new ArrayList<>();
                for (Object item : col) {
                    if (item instanceof Change change) {
                        changes.add(change);
                    }
                }
                LOG.debug("Successfully retrieved " + changes.size() + " included changes via reflection");
                return changes;
            }

            return null;
        } catch (NoSuchMethodException e) {
            // Expected on older IDEA versions that don't have this API
            LOG.debug("getIncludedChanges() method not available (older IDEA version): " + e.getMessage());
            return null;
        } catch (Exception e) {
            // Log other reflection errors for debugging
            LOG.debug("Failed to get included changes via reflection: " + e.getMessage());
            return null;
        }
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        boolean enabled = project != null;

        // Check if commit generation feature is enabled in settings
        if (enabled) {
            try {
                enabled = new CodemossSettingsService().getCommitGenerationEnabled();
            } catch (Exception ex) {
                LOG.debug("Failed to check commit generation enabled setting: " + ex.getMessage());
            }
        }

        // Debug: log when update is called
        if (LOG.isDebugEnabled()) {
            LOG.debug("GenerateCommitMessageAction.update called, project=" + (project != null ? project.getName() : "null"));

            // Log available DataKeys
            Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
            Object messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);

            LOG.debug("Available DataKeys:");
            LOG.debug("  - COMMIT_WORKFLOW_HANDLER: " + (workflowHandler != null ? workflowHandler.getClass().getName() : "null"));
            LOG.debug("  - COMMIT_MESSAGE_CONTROL: " + (messageControl != null ? messageControl.getClass().getName() : "null"));
        }

        // Set localized text
        e.getPresentation().setText(ClaudeCodeGuiBundle.message("action.generateCommitMessage.text"));
        e.getPresentation().setDescription(ClaudeCodeGuiBundle.message("action.generateCommitMessage.description"));
        e.getPresentation().setEnabledAndVisible(enabled);
    }
}
