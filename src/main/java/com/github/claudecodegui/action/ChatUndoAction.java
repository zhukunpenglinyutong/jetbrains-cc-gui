package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

/**
 * IDEA Action for Ctrl+Z in the Claude chat tool window.
 *
 * Without this action the IDE's built-in Undo shortcut wins before the JCEF
 * webview sees the key, so Ctrl+Z reverts the last editor change instead of
 * the text just typed in the chat input. Forwards undo to the webview's
 * contenteditable element, which owns the native browser undo stack.
 */
public class ChatUndoAction extends ChatToolWindowAction {

    private static final Logger LOG = Logger.getInstance(ChatUndoAction.class);

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        LOG.info("[ccgui-undo] ChatUndoAction fired");
        chatWindow.executeJavaScriptCode(
            "(function(){" +
            "  var el=document.activeElement;" +
            "  if(el&&el.getAttribute('contenteditable')==='true'){" +
            "    document.execCommand('undo');" +
            "  }" +
            "})()"
        );
    }
}
