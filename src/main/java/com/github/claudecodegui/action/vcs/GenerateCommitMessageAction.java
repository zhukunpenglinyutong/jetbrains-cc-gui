package com.github.claudecodegui.action.vcs;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.service.GitCommitMessageService;
import com.github.claudecodegui.settings.CodemossSettingsService;
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
import com.intellij.vcs.commit.CommitMessageUi;
import com.intellij.vcs.commit.CommitWorkflowUi;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

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

        // Get commit message setter (supports both old and new commit UIs)
        CommitMessageSetter commitMessageSetter = getCommitMessageSetter(e);

        // Get user-selected changes using the new method with proper fallback chain
        Collection<Change> changes = getUserSelectedChanges(e, project);

        // Check if we successfully obtained required objects
        if (commitMessageSetter == null) {
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

        // Save references for async callback
        final CommitMessageSetter finalCommitMessageSetter = commitMessageSetter;
        final Collection<Change> finalChanges = changes;

        // Show "generating..." placeholder in commit message box
        String generatingText = ClaudeCodeGuiBundle.message("commit.generating");
        commitMessageSetter.startLoading();
        commitMessageSetter.set(generatingText);
        ClaudeNotifier.setGenerating(project);

        // Generate commit message asynchronously
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                GitCommitMessageService service = new GitCommitMessageService(project);
                service.generateCommitMessage(finalChanges, new GitCommitMessageService.CommitMessageCallback() {
                    @Override
                    public void onSuccess(String commitMessage) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            // Set the generated commit message
                            finalCommitMessageSetter.stopLoading();
                            finalCommitMessageSetter.set(commitMessage);
                            ClaudeNotifier.clearStatus(project);
                            ClaudeNotifier.showSuccess(project, ClaudeCodeGuiBundle.message("commit.generateSuccess"));
                        });
                    }

                    @Override
                    public void onError(String error) {
                        ApplicationManager.getApplication().invokeLater(() -> {
                            // Clear placeholder text
                            finalCommitMessageSetter.stopLoading();
                            finalCommitMessageSetter.set("");
                            ClaudeNotifier.clearStatus(project);
                            ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + error);
                        });
                    }
                });
            } catch (Exception ex) {
                LOG.error("Failed to generate commit message", ex);
                ApplicationManager.getApplication().invokeLater(() -> {
                    // Clear placeholder text
                    finalCommitMessageSetter.stopLoading();
                    finalCommitMessageSetter.set("");
                    ClaudeNotifier.clearStatus(project);
                    ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + ex.getMessage());
                });
            }
        });
    }

    /**
     * Commit message setter abstraction for different commit UIs.
     */
    private interface CommitMessageSetter {
        void set(@NotNull String message);
        default void startLoading() {}
        default void stopLoading() {}
    }

    /**
     * Get commit message setter from available data sources.
     */
    @Nullable
    private CommitMessageSetter getCommitMessageSetter(@NotNull AnActionEvent e) {
        // Method 1: Newer commit UI (CommitWorkflowUi)
        CommitWorkflowUi workflowUi = e.getData(VcsDataKeys.COMMIT_WORKFLOW_UI);
        if (workflowUi != null) {
            CommitMessageUi commitMessageUi = workflowUi.getCommitMessageUi();
            if (commitMessageUi != null) {
                LOG.info("Got commit message setter from COMMIT_WORKFLOW_UI");
                return new CommitMessageSetter() {
                    @Override
                    public void set(@NotNull String message) {
                        commitMessageUi.setText(message);
                    }

                    @Override
                    public void startLoading() {
                        commitMessageUi.startLoading();
                    }

                    @Override
                    public void stopLoading() {
                        commitMessageUi.stopLoading();
                    }
                };
            }
        }

        // Method 2: Legacy commit UI (CommitMessageI)
        CommitMessageI messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
        if (messageControl != null) {
            LOG.info("Got commit message setter from COMMIT_MESSAGE_CONTROL");
            return new CommitMessageSetter() {
                @Override
                public void set(@NotNull String message) {
                    messageControl.setCommitMessage(message);
                }
            };
        }

        // Method 3: Fallback via workflow handler reflection (for compatibility)
        Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
        if (workflowHandler != null) {
            try {
                Method getUiMethod = workflowHandler.getClass().getMethod("getUi");
                Object uiObj = getUiMethod.invoke(workflowHandler);
                if (uiObj instanceof CommitWorkflowUi ui) {
                    CommitMessageUi commitMessageUi = ui.getCommitMessageUi();
                    if (commitMessageUi != null) {
                        LOG.info("Got commit message setter from COMMIT_WORKFLOW_HANDLER.getUi()");
                        return new CommitMessageSetter() {
                            @Override
                            public void set(@NotNull String message) {
                                commitMessageUi.setText(message);
                            }

                            @Override
                            public void startLoading() {
                                commitMessageUi.startLoading();
                            }

                            @Override
                            public void stopLoading() {
                                commitMessageUi.stopLoading();
                            }
                        };
                    }
                }
            } catch (Exception ex) {
                LOG.debug("Failed to get commit message setter from COMMIT_WORKFLOW_HANDLER: " + ex.getMessage());
            }
        }

        return null;
    }

    /**
     * Get user-selected changes from the commit dialog.
     * Uses a fallback chain to support different IDEA versions:
     * 1. COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges() - preferred, gets user-checked files
     * 2. CheckinProjectPanel.getSelectedChanges() - legacy fallback
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
