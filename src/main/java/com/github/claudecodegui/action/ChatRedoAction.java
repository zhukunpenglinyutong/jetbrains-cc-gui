package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;

/**
 * IDEA Action for Ctrl+Shift+Z / Ctrl+Y in the Claude chat tool window.
 *
 * Mirrors {@link ChatUndoAction}: the IDE's Redo shortcut would otherwise act
 * on the host editor, so redo is forwarded to the webview's contenteditable
 * element instead.
 */
public class ChatRedoAction extends ChatToolWindowAction {

    private static final Logger LOG = Logger.getInstance(ChatRedoAction.class);

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        LOG.info("[ccgui-undo] ChatRedoAction fired");
        chatWindow.executeJavaScriptCode(
            "(function(){" +
            "  var el=document.activeElement;" +
            "  if(el&&el.getAttribute('contenteditable')==='true'){" +
            "    document.execCommand('redo');" +
            "  }" +
            "})()"
        );
    }
}
