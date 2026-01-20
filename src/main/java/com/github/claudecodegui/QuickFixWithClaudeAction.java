package com.github.claudecodegui;

import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.editor.Editor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.popup.JBPopup;
import com.intellij.openapi.ui.popup.JBPopupFactory;
import com.intellij.ui.components.JBLabel;
import com.intellij.ui.components.JBTextField;
import com.intellij.util.ui.JBUI;
import org.jetbrains.annotations.NotNull;

import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;

import javax.swing.*;
import java.awt.*;
import java.awt.event.ActionEvent;
import java.awt.event.KeyEvent;
import java.awt.event.KeyAdapter;
import java.util.LinkedList;
import java.util.List;

/**
 * Quick Fix with Claude - Áp dụng các thay đổi thông minh dựa trên PSI context
 */
public class QuickFixWithClaudeAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(QuickFixWithClaudeAction.class);
    private static final List<String> INPUT_HISTORY = new LinkedList<>();
    private static final int MAX_HISTORY_SIZE = 20;
    private int historyIndex = -1;
    private String currentInput = "";

    public QuickFixWithClaudeAction() {
        super(
            ClaudeCodeGuiBundle.message("action.quickFixWithClaude.text"),
            ClaudeCodeGuiBundle.message("action.quickFixWithClaude.description"),
            null
        );
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        Editor editor = e.getData(CommonDataKeys.EDITOR);
        if (project == null || editor == null) {
            return;
        }

        showQuickFixInput(project, editor);
    }

    private void showQuickFixInput(@NotNull Project project, @NotNull Editor editor) {
        // Reset history index for new invocation
        historyIndex = -1;
        currentInput = "";

        JPanel panel = new JPanel(new BorderLayout(0, 4));
        panel.setBorder(JBUI.Borders.empty(8));

        JBLabel label = new JBLabel(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.dialogLabel"));
        label.setBorder(JBUI.Borders.emptyBottom(4));
        panel.add(label, BorderLayout.NORTH);

        // Input panel with text field and navigation buttons
        JPanel inputPanel = new JPanel(new BorderLayout(4, 0));

        // Left panel with history navigation buttons
        JPanel navPanel = new JPanel(new GridLayout(2, 1, 0, 2));

        JButton historyUpButton = new JButton("▲");
        historyUpButton.setToolTipText("Previous in history (↑)");
        historyUpButton.setPreferredSize(new Dimension(28, 14));
        historyUpButton.setFont(new Font("SansSerif", Font.PLAIN, 8));

        JButton historyDownButton = new JButton("▼");
        historyDownButton.setToolTipText("Next in history (↓)");
        historyDownButton.setPreferredSize(new Dimension(28, 14));
        historyDownButton.setFont(new Font("SansSerif", Font.PLAIN, 8));

        navPanel.add(historyUpButton);
        navPanel.add(historyDownButton);

        // Right panel with action buttons
        JPanel actionPanel = new JPanel(new GridLayout(2, 1, 0, 2));

        JButton submitButton = new JButton("Submit ⏎");
        submitButton.setToolTipText("Submit (Enter)");

        JButton cancelButton = new JButton("Cancel ␛");
        cancelButton.setToolTipText("Cancel (Esc)");

        actionPanel.add(submitButton);
        actionPanel.add(cancelButton);

        // Center: text field - prefill with most recent history
        JBTextField textField = new JBTextField();
        textField.setPreferredSize(new Dimension(400, 28));

        // Prefill with the most recent input from history
        synchronized (INPUT_HISTORY) {
            if (!INPUT_HISTORY.isEmpty()) {
                textField.setText(INPUT_HISTORY.get(0));
                // Select all text so user can easily type to replace
                textField.selectAll();
                // Set historyIndex to 0 since we're showing the first item
                historyIndex = 0;
            }
        }

        inputPanel.add(navPanel, BorderLayout.WEST);
        inputPanel.add(textField, BorderLayout.CENTER);
        inputPanel.add(actionPanel, BorderLayout.EAST);

        panel.add(inputPanel, BorderLayout.CENTER);

        JBPopup popup = JBPopupFactory.getInstance()
                .createComponentPopupBuilder(panel, textField)
                .setRequestFocus(true)
                .setFocusable(true)
                .setResizable(true)
                .setMovable(true)
                .setTitle(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.dialogTitle"))
                .createPopup();

        // Submit action
        Runnable submitAction = () -> {
            String prompt = textField.getText().trim();
            if (!prompt.isEmpty()) {
                // Add to history
                synchronized (INPUT_HISTORY) {
                    INPUT_HISTORY.remove(prompt); // Remove duplicates
                    INPUT_HISTORY.add(0, prompt); // Add to front
                    if (INPUT_HISTORY.size() > MAX_HISTORY_SIZE) {
                        INPUT_HISTORY.remove(INPUT_HISTORY.size() - 1);
                    }
                }
                popup.closeOk(null);
                executeQuickFix(project, editor, prompt);
            }
        };

        // Cancel action
        Runnable cancelAction = popup::cancel;

        // History navigation actions
        Runnable historyUpAction = () -> {
            synchronized (INPUT_HISTORY) {
                if (!INPUT_HISTORY.isEmpty() && historyIndex < INPUT_HISTORY.size() - 1) {
                    if (historyIndex == -1) {
                        currentInput = textField.getText();
                    }
                    historyIndex++;
                    textField.setText(INPUT_HISTORY.get(historyIndex));
                }
            }
        };

        Runnable historyDownAction = () -> {
            synchronized (INPUT_HISTORY) {
                if (historyIndex > 0) {
                    historyIndex--;
                    textField.setText(INPUT_HISTORY.get(historyIndex));
                } else if (historyIndex == 0) {
                    historyIndex = -1;
                    textField.setText(currentInput);
                }
            }
        };

        // Button click handlers
        submitButton.addActionListener(e -> submitAction.run());
        cancelButton.addActionListener(e -> cancelAction.run());
        historyUpButton.addActionListener(e -> historyUpAction.run());
        historyDownButton.addActionListener(e -> historyDownAction.run());

        // Key listener for ENTER, ESC, and arrow keys for history navigation
        textField.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.VK_ENTER) {
                    submitAction.run();
                    e.consume();
                } else if (e.getKeyCode() == KeyEvent.VK_ESCAPE) {
                    cancelAction.run();
                    e.consume();
                } else if (e.getKeyCode() == KeyEvent.VK_UP) {
                    historyUpAction.run();
                    e.consume();
                } else if (e.getKeyCode() == KeyEvent.VK_DOWN) {
                    historyDownAction.run();
                    e.consume();
                }
            }
        });

        popup.showInBestPositionFor(editor);
    }

    private void executeQuickFix(@NotNull Project project, @NotNull Editor editor, @NotNull String userPrompt) {
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            ClaudeNotifier.showError(project, "CCG tool window not found");
            return;
        }

        // Show progress in status bar
        ClaudeNotifier.setWaiting(project);

        // 1. Create a new "Secondary" chat window specifically for this Quick Fix
        ClaudeSDKToolWindow.ClaudeChatWindow quickFixWindow = new ClaudeSDKToolWindow.ClaudeChatWindow(project, true);

        // 2. Add as a new tab in the tool window with "AIN" naming format
        ContentFactory contentFactory = ContentFactory.getInstance();
        String tabName = ClaudeSDKToolWindow.getNextTabName(toolWindow);
        Content content = contentFactory.createContent(quickFixWindow.getContent(), tabName, false);
        content.setCloseable(true);
        quickFixWindow.setParentContent(content);
        toolWindow.getContentManager().addContent(content);
        toolWindow.getContentManager().setSelectedContent(content);
        toolWindow.show(null);

        // 3. Send message and handle response for Diff View
        quickFixWindow.sendQuickFixMessage(userPrompt, true, new MessageCallback() {
            @Override
            public void onMessage(String type, String content) {}

            @Override
            public void onError(String error) {
                ApplicationManager.getApplication().invokeLater(() -> {
                    ClaudeNotifier.showError(project, "Quick Fix failed: " + error);
                    ClaudeNotifier.clearStatus(project);
                });
            }

            @Override
            public void onComplete(SDKResult result) {
                com.github.claudecodegui.service.QuickFixService.handleAIResponse(project, editor, result.finalResult);
            }
        });
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setEnabledAndVisible(true);
    }
}
