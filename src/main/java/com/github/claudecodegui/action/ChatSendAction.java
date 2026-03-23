package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.actionSystem.AnActionEvent;
import org.jetbrains.annotations.NotNull;
import com.intellij.openapi.project.Project;

/**
 * IDEA Action for send message in the Claude chat tool window.
 * Shortcut is dynamically managed: Ctrl+Enter when sendShortcut=cmdEnter, removed when enter mode.
 */
public class ChatSendAction extends ChatToolWindowAction {

    public static final String ACTION_ID = "ClaudeCodeGUI.ChatSendAction";

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        chatWindow.executeJavaScriptCode("if(window.execContextAction) window.execContextAction('send')");
    }
}
