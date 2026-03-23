package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.actionSystem.AnActionEvent;
import org.jetbrains.annotations.NotNull;
import com.intellij.openapi.project.Project;

/**
 * IDEA Action for inserting a newline in the Claude chat tool window input.
 * Shortcut is dynamically managed: Ctrl+Enter when sendShortcut=enter, removed when cmdEnter mode.
 */
public class ChatNewlineAction extends ChatToolWindowAction {

    public static final String ACTION_ID = "ClaudeCodeGUI.ChatNewlineAction";

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        chatWindow.executeJavaScriptCode("if(window.execContextAction) window.execContextAction('newline')");
    }
}
