package com.github.claudecodegui.action.vcs;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.service.GitCommitMessageService;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.Presentation;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.IconLoader;
import com.intellij.openapi.vcs.CheckinProjectPanel;
import com.intellij.openapi.vcs.CommitMessageI;
import com.intellij.openapi.vcs.VcsDataKeys;
import com.intellij.openapi.vcs.changes.Change;
import com.intellij.ui.JBColor;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.Icon;
import javax.swing.SwingUtilities;
import java.awt.Color;
import java.awt.Component;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Action to generate Git commit messages using AI.
 */
public class GenerateCommitMessageAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(GenerateCommitMessageAction.class);
    private static final ConcurrentMap<String, GenerationSession> IN_FLIGHT_PROJECTS = new ConcurrentHashMap<>();
    private static final javax.swing.Icon ACTION_ICON = IconLoader.getIcon("/icons/logo-16.png", GenerateCommitMessageAction.class);
    private static final Icon LOADING_ICON = new StopSquareIcon();
    private static final int GENERATION_TIMEOUT_SECONDS = 120;

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

        CommitMessageI commitMessagePanel = getCommitMessagePanel(e);

        if (commitMessagePanel == null) {
            LOG.error("Cannot access commit message panel");
            ClaudeNotifier.showWarning(project, ClaudeCodeGuiBundle.message("commit.cannotAccessPanel"));
            return;
        }

        String projectKey = project.getBasePath() != null ? project.getBasePath() : project.getName();
        GenerationSession existing = IN_FLIGHT_PROJECTS.get(projectKey);
        if (existing != null) {
            existing.cancel(true);
            return;
        }

        try {
            final CommitMessageI finalCommitMessagePanel = commitMessagePanel;
            final Project finalProject = project;
            final String finalProjectKey = projectKey;
            final Presentation finalPresentation = e.getPresentation();
            final Object workflowHandler = e.getData(VcsDataKeys.COMMIT_WORKFLOW_HANDLER);
            final Object messageControl = e.getData(VcsDataKeys.COMMIT_MESSAGE_CONTROL);
            final Change[] selectedChanges = e.getData(VcsDataKeys.CHANGES);
            final String generatingText = ClaudeCodeGuiBundle.message("commit.generating");
            final String originalMessage = readCommitMessage(finalCommitMessagePanel);

            finalPresentation.setIcon(LOADING_ICON);
            finalPresentation.setEnabled(true);
            GenerationSession session = new GenerationSession(
                    finalProjectKey,
                    finalProject,
                    finalCommitMessagePanel,
                    finalPresentation,
                    originalMessage
            );
            if (IN_FLIGHT_PROJECTS.putIfAbsent(finalProjectKey, session) != null) {
                LOG.info("Commit message generation already running for project: " + finalProjectKey);
                return;
            }

            session.showGeneratingText(generatingText);

            session.timeout = com.intellij.util.concurrency.AppExecutorUtil.getAppScheduledExecutorService().schedule(
                    () -> session.timeout(),
                    GENERATION_TIMEOUT_SECONDS,
                    TimeUnit.SECONDS
            );

            Future<?> worker = ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    Collection<Change> changes = getUserSelectedChanges(
                            workflowHandler,
                            messageControl,
                            selectedChanges,
                            finalProject
                    );
                    if (changes == null || changes.isEmpty()) {
                        LOG.warn("No changes selected");
                        session.warnAndRestore(ClaudeCodeGuiBundle.message("commit.noChanges"));
                        return;
                    }

                    LOG.info("Successfully obtained CommitMessageI and changes, proceeding to generate commit message");

                    GitCommitMessageService service = new GitCommitMessageService(finalProject);
                    service.generateCommitMessage(changes, new GitCommitMessageService.CommitMessageCallback() {
                        @Override
                        public void onPartial(String commitMessage) {
                            session.updatePartial(commitMessage);
                        }

                        @Override
                        public void onSuccess(String commitMessage) {
                            session.succeed(commitMessage, ClaudeCodeGuiBundle.message("commit.generateSuccess"));
                        }

                        @Override
                        public void onError(String error) {
                            if (GitCommitMessageService.GENERATION_CANCELLED_ERROR.equalsIgnoreCase(error)) {
                                session.cancelled();
                                return;
                            }
                            session.failAndRestore(ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + error);
                        }
                    });
                } catch (Exception ex) {
                    LOG.error("Failed to generate commit message", ex);
                    session.failAndRestore(ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + ex.getMessage());
                }
            });
            session.worker = worker;
            if (session.finished.get()) {
                session.cancelWorker();
            }
        } catch (Exception ex) {
            LOG.error("Failed to start commit message generation", ex);
            IN_FLIGHT_PROJECTS.remove(projectKey);
            e.getPresentation().setIcon(ACTION_ICON);
            e.getPresentation().setEnabled(true);
            ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed") + ": " + ex.getMessage());
        }
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
     *
     * Empty included/selected lists are authoritative. If the user unchecked every
     * file in the commit dialog, do not fall back to unrelated/all changes.
     */
    @Nullable
    private Collection<Change> getUserSelectedChanges(
            Object workflowHandler,
            Object messageControl,
            Change[] changesArray,
            @NotNull Project project
    ) {
        Collection<Change> changes;

        // Method 1: Try COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges() via reflection
        // This is the preferred method as it returns only user-checked files in the commit dialog
        if (workflowHandler != null) {
            changes = getIncludedChangesViaReflection(workflowHandler);
            if (changes != null) {
                LOG.info("Got " + changes.size() + " included changes from COMMIT_WORKFLOW_HANDLER.ui.getIncludedChanges()");
                return changes;
            }
        }

        // Method 2: Try CheckinProjectPanel.getSelectedChanges() (legacy)
        if (messageControl instanceof CheckinProjectPanel checkinPanel) {
            changes = checkinPanel.getSelectedChanges();
            if (changes != null) {
                LOG.info("Got " + changes.size() + " selected changes from CheckinProjectPanel.getSelectedChanges() (fallback)");
                return changes;
            }
        }

        // Method 3: Try VcsDataKeys.CHANGES
        if (changesArray != null && changesArray.length > 0) {
            changes = java.util.Arrays.asList(changesArray);
            LOG.info("Got " + changes.size() + " changes from VcsDataKeys.CHANGES (fallback)");
            return changes;
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
        if (project != null) {
            String projectKey = project.getBasePath() != null ? project.getBasePath() : project.getName();
            if (IN_FLIGHT_PROJECTS.containsKey(projectKey)) {
                e.getPresentation().setIcon(LOADING_ICON);
            } else {
                e.getPresentation().setIcon(ACTION_ICON);
            }
        }
    }

    private String readCommitMessage(@NotNull CommitMessageI panel) {
        for (String methodName : new String[]{"getCommitMessage", "getComment"}) {
            try {
                Method method = panel.getClass().getMethod(methodName);
                Object result = method.invoke(panel);
                if (result instanceof String) {
                    return (String) result;
                }
            } catch (Exception ignored) {
                // Keep trying older/newer API shapes.
            }
        }
        return "";
    }

    private void restoreActionState(@NotNull Presentation presentation, @NotNull String projectKey) {
        IN_FLIGHT_PROJECTS.remove(projectKey);
        presentation.setIcon(ACTION_ICON);
        presentation.setEnabled(true);
    }

    private static void runUiUpdate(@NotNull Runnable runnable) {
        if (SwingUtilities.isEventDispatchThread()) {
            runnable.run();
            return;
        }
        ApplicationManager.getApplication().invokeLater(runnable);
    }

    private static final class StopSquareIcon implements Icon {
        private static final int SIZE = 16;
        private static final int STOP_SIZE = 8;
        private static final Color STOP_COLOR = new JBColor(new Color(0x4E, 0x54, 0x5F), new Color(0xB7, 0xBA, 0xC2));

        @Override
        public void paintIcon(Component c, Graphics g, int x, int y) {
            Graphics2D g2 = (Graphics2D) g.create();
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                g2.setColor(STOP_COLOR);
                int iconSize = getIconWidth();
                int size = JBUI.scale(STOP_SIZE);
                int offset = (iconSize - size) / 2;
                int drawX = x + offset;
                int drawY = y + offset;
                g2.fillRect(drawX, drawY, size, size);
            } finally {
                g2.dispose();
            }
        }

        @Override
        public int getIconWidth() {
            return JBUI.scale(SIZE);
        }

        @Override
        public int getIconHeight() {
            return JBUI.scale(SIZE);
        }
    }

    private final class GenerationSession {
        private final String projectKey;
        private final Project project;
        private final CommitMessageI panel;
        private final Presentation presentation;
        private final String originalMessage;
        private final AtomicBoolean finished = new AtomicBoolean(false);
        private final AtomicInteger visualPos = new AtomicInteger(0);
        private final StringBuilder streamed = new StringBuilder();
        private volatile Future<?> worker;
        private volatile ScheduledFuture<?> timeout;
        private volatile ScheduledFuture<?> streamTicker;

        private GenerationSession(String projectKey, Project project, CommitMessageI panel, Presentation presentation,
                                  String originalMessage) {
            this.projectKey = projectKey;
            this.project = project;
            this.panel = panel;
            this.presentation = presentation;
            this.originalMessage = originalMessage == null ? "" : originalMessage;
        }

        private void updatePartial(String text) {
            if (text == null || text.isEmpty() || finished.get()) {
                return;
            }
            synchronized (streamed) {
                streamed.setLength(0);
                streamed.append(text);
            }
        }

        private void showGeneratingText(String text) {
            runUiUpdate(() -> {
                if (!finished.get()) {
                    panel.setCommitMessage(text);
                }
            });
            streamTicker = com.intellij.util.concurrency.AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(() -> {
                if (finished.get()) {
                    return;
                }
                String snapshot;
                synchronized (streamed) {
                    snapshot = streamed.toString();
                }
                if (snapshot.isEmpty()) {
                    return;
                }
                int pos = visualPos.get();
                int total = snapshot.length();
                if (total <= pos) {
                    return;
                }
                int buffered = total - pos;
                int advance = Math.max(1, buffered / 3);
                int newPos = Math.min(total, pos + advance);
                visualPos.set(newPos);
                String toShow = snapshot.substring(0, newPos);
                runUiUpdate(() -> {
                    if (!finished.get()) {
                        panel.setCommitMessage(toShow);
                    }
                });
            }, 0, 20, TimeUnit.MILLISECONDS);
        }

        private void succeed(String commitMessage, String successMessage) {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            cancelTimeout();
            cancelStreamTicker();
            runUiUpdate(() -> {
                panel.setCommitMessage(commitMessage);
                ClaudeNotifier.showSuccess(project, successMessage);
                restoreActionState(presentation, projectKey);
            });
        }

        private void failAndRestore(String message) {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            cancelWorker();
            cancelTimeout();
            cancelStreamTicker();
            runUiUpdate(() -> {
                panel.setCommitMessage("");
                ClaudeNotifier.showError(project, message);
                restoreActionState(presentation, projectKey);
            });
        }

        private void warnAndRestore(String message) {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            cancelWorker();
            cancelTimeout();
            cancelStreamTicker();
            runUiUpdate(() -> {
                panel.setCommitMessage(originalMessage);
                ClaudeNotifier.showWarning(project, message);
                restoreActionState(presentation, projectKey);
            });
        }

        private void timeout() {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            cancelWorker();
            cancelStreamTicker();
            runUiUpdate(() -> {
                panel.setCommitMessage(originalMessage);
                ClaudeNotifier.showError(project, ClaudeCodeGuiBundle.message("commit.generateFailed")
                        + ": " + ClaudeCodeGuiBundle.message("commit.timeout"));
                restoreActionState(presentation, projectKey);
            });
        }

        private void cancelled() {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            cancelWorker();
            cancelTimeout();
            cancelStreamTicker();
            runUiUpdate(() -> {
                panel.setCommitMessage(originalMessage);
                ClaudeNotifier.showWarning(project, ClaudeCodeGuiBundle.message("commit.cancelled"));
                restoreActionState(presentation, projectKey);
            });
        }

        private void cancel(boolean notifyUser) {
            if (!finished.compareAndSet(false, true)) {
                return;
            }
            cancelWorker();
            cancelTimeout();
            cancelStreamTicker();
            runUiUpdate(() -> {
                panel.setCommitMessage(originalMessage);
                restoreActionState(presentation, projectKey);
                if (notifyUser) {
                    ClaudeNotifier.showWarning(project, ClaudeCodeGuiBundle.message("commit.cancelled"));
                }
            });
        }

        private void cancelWorker() {
            Future<?> currentWorker = worker;
            if (currentWorker != null) {
                currentWorker.cancel(true);
            }
        }

        private void cancelTimeout() {
            ScheduledFuture<?> currentTimeout = timeout;
            if (currentTimeout != null) {
                currentTimeout.cancel(false);
            }
        }

        private void cancelStreamTicker() {
            ScheduledFuture<?> currentStreamTicker = streamTicker;
            if (currentStreamTicker != null) {
                currentStreamTicker.cancel(false);
            }
        }
    }
}
