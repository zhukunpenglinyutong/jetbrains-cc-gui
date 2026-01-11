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
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;

/**
 * Quick Fix with Claude - Áp dụng các thay đổi thông minh dựa trên PSI context
 */
public class QuickFixWithClaudeAction extends AnAction implements DumbAware {

    private static final Logger LOG = Logger.getInstance(QuickFixWithClaudeAction.class);

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
        JPanel panel = new JPanel(new BorderLayout());
        panel.setBorder(JBUI.Borders.empty(8));

        JBLabel label = new JBLabel(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.dialogLabel"));
        label.setBorder(JBUI.Borders.emptyBottom(4));
        panel.add(label, BorderLayout.NORTH);

        JBTextField textField = new JBTextField();
        textField.setPreferredSize(new Dimension(450, 30));
        panel.add(textField, BorderLayout.CENTER);

        JBPopup popup = JBPopupFactory.getInstance()
                .createComponentPopupBuilder(panel, textField)
                .setRequestFocus(true)
                .setFocusable(true)
                .setResizable(true)
                .setMovable(true)
                .setTitle(ClaudeCodeGuiBundle.message("action.quickFixWithClaude.dialogTitle"))
                .createPopup();

        textField.addKeyListener(new KeyAdapter() {
            @Override
            public void keyPressed(KeyEvent e) {
                if (e.getKeyCode() == KeyEvent.VK_ENTER) {
                    String prompt = textField.getText().trim();
                    if (!prompt.isEmpty()) {
                        popup.closeOk(null);
                        executeQuickFix(project, editor, prompt);
                    }
                } else if (e.getKeyCode() == KeyEvent.VK_ESCAPE) {
                    popup.cancel();
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
