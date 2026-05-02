package com.github.claudecodegui.action.vcs;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.DialogWrapper;
import com.intellij.ui.components.JBLabel;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;

/**
 * Dialog showing progress during commit message generation.
 * Displays a progress bar with animation, timer, and status messages.
 */
public class CommitGenerationProgressDialog extends DialogWrapper implements Disposable {

    private final Project project;
    private final JBLabel statusLabel;
    private final JBLabel timerLabel;
    private final JBLabel modelLabel;
    private final JProgressBar progressBar;
    private final Timer timer;
    private long startTime;
    private boolean isCompleted = false;

    public CommitGenerationProgressDialog(@Nullable Project project, @NotNull String modelName) {
        super(project, false);
        this.project = project;

        setTitle(ClaudeCodeGuiBundle.message("commit.progress.title"));
        setModal(true);
        setResizable(false);

        // Initialize UI components
        statusLabel = new JBLabel(ClaudeCodeGuiBundle.message("commit.progress.initializing"));
        statusLabel.setBorder(JBUI.Borders.empty(5));

        timerLabel = new JBLabel("00:00");
        timerLabel.setBorder(JBUI.Borders.empty(5));

        modelLabel = new JBLabel("<html><b>" + ClaudeCodeGuiBundle.message("commit.progress.model") + ":</b> " + escapeHtml(modelName) + "</html>");
        modelLabel.setBorder(JBUI.Borders.empty(5));

        progressBar = new JProgressBar(0, 100);
        progressBar.setIndeterminate(true); // Use indeterminate progress for unknown duration
        progressBar.setBorder(JBUI.Borders.empty(5));

        // Timer for updating elapsed time (updates every 100ms)
        timer = new Timer(100, new ActionListener() {
            @Override
            public void actionPerformed(ActionEvent e) {
                updateTimer();
            }
        });

        init();
    }

    @Override
    protected @Nullable JComponent createCenterPanel() {
        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBorder(JBUI.Borders.empty(15));
        panel.setPreferredSize(new Dimension(400, 150));

        GridBagConstraints gbc = new GridBagConstraints();
        gbc.fill = GridBagConstraints.HORIZONTAL;
        gbc.insets = JBUI.insets(5);

        // Row 0: Model info
        gbc.gridx = 0;
        gbc.gridy = 0;
        gbc.gridwidth = 2;
        panel.add(modelLabel, gbc);

        // Row 1: Status label
        gbc.gridx = 0;
        gbc.gridy = 1;
        gbc.gridwidth = 2;
        panel.add(statusLabel, gbc);

        // Row 2: Progress bar
        gbc.gridx = 0;
        gbc.gridy = 2;
        gbc.gridwidth = 2;
        gbc.weightx = 1.0;
        panel.add(progressBar, gbc);

        // Row 3: Timer and hint
        gbc.gridx = 0;
        gbc.gridy = 3;
        gbc.gridwidth = 1;
        gbc.weightx = 0.0;
        panel.add(timerLabel, gbc);

        JLabel hintLabel = new JBLabel("<html><i>" + ClaudeCodeGuiBundle.message("commit.progress.hint") + "</i></html>");
        hintLabel.setBorder(JBUI.Borders.empty(5, 5, 5, 15));
        gbc.gridx = 1;
        gbc.gridy = 3;
        gbc.weightx = 1.0;
        panel.add(hintLabel, gbc);

        return panel;
    }

    @NotNull
    @Override
    protected Action[] createActions() {
        // Add a cancel button only
        return new Action[]{getCancelAction()};
    }

    /**
     * Start showing the progress dialog and timer.
     */
    public void start() {
        startTime = System.currentTimeMillis();
        timer.start();
        show(); // This is blocking
    }

    /**
     * Complete the progress dialog with success.
     */
    public void complete() {
        isCompleted = true;
        timer.stop();
        updateStatus(ClaudeCodeGuiBundle.message("commit.progress.complete"));
        progressBar.setIndeterminate(false);
        progressBar.setValue(100);

        // Auto-close after a short delay
        Timer closeTimer = new Timer(500, e -> {
            close(OK_EXIT_CODE);
        });
        closeTimer.setRepeats(false);
        closeTimer.start();
    }

    /**
     * Show error state.
     */
    public void error(String message) {
        isCompleted = true;
        timer.stop();
        updateStatus(ClaudeCodeGuiBundle.message("commit.progress.error") + ": " + message);
        progressBar.setIndeterminate(false);
        progressBar.setValue(0);
    }

    /**
     * Update the status message.
     */
    public void updateStatus(String status) {
        statusLabel.setText(status);
    }

    /**
     * Update the timer display.
     */
    private void updateTimer() {
        long elapsed = System.currentTimeMillis() - startTime;
        int seconds = (int) (elapsed / 1000);
        int minutes = seconds / 60;
        seconds = seconds % 60;

        String timeText = String.format("%02d:%02d", minutes, seconds);

        // Add visual indicator for long-running operations
        if (elapsed > 10000) { // More than 10 seconds
            timeText += " (" + ClaudeCodeGuiBundle.message("commit.progress.takingTime") + ")";
        }

        timerLabel.setText(timeText);
    }

    /**
     * Escape HTML special characters.
     */
    private String escapeHtml(String text) {
        if (text == null) {
            return "";
        }
        return text.replace("&", "&amp;")
                   .replace("<", "&lt;")
                   .replace(">", "&gt;")
                   .replace("\"", "&quot;")
                   .replace("'", "&#39;");
    }

    @Override
    public void dispose() {
        timer.stop();
        super.dispose();
    }
}
