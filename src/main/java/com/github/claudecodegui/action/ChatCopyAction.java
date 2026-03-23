package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.actionSystem.AnActionEvent;
import org.jetbrains.annotations.NotNull;
import com.intellij.openapi.project.Project;

/**
 * IDEA Action for Ctrl+C in the Claude chat tool window.
 * Forwards copy operation to WebView via execContextAction callback.
 */
public class ChatCopyAction extends ChatToolWindowAction {

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        chatWindow.executeJavaScriptCode("if(window.execContextAction) window.execContextAction('copy')");
    }
}
