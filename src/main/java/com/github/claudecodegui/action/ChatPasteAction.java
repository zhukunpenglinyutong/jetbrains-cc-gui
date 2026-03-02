package com.github.claudecodegui.action;

import com.github.claudecodegui.ClaudeChatWindow;
import com.google.gson.Gson;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.NotNull;
import com.intellij.openapi.project.Project;

import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;

/**
 * IDEA Action for Ctrl+V in the Claude chat tool window.
 * Reads system clipboard and inserts text at cursor in the focused contenteditable element.
 */
public class ChatPasteAction extends ChatToolWindowAction {

    private static final Logger LOG = Logger.getInstance(ChatPasteAction.class);
    private static final Gson GSON = new Gson();

    @Override
    protected void performAction(@NotNull AnActionEvent e, @NotNull Project project, @NotNull ClaudeChatWindow chatWindow) {
        try {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            String text = "";
            if (clipboard.isDataFlavorAvailable(DataFlavor.stringFlavor)) {
                text = (String) clipboard.getData(DataFlavor.stringFlavor);
                if (text == null) text = "";
            }
            if (text.isEmpty()) return;

            // Use Gson JSON encoding to safely embed clipboard text, preventing JS injection
            String jsonEncoded = GSON.toJson(text);
            chatWindow.executeJavaScriptCode(
                "(function(){" +
                "  var txt=" + jsonEncoded + ";" +
                "  var el=document.activeElement;" +
                "  if(el&&el.getAttribute('contenteditable')==='true'){" +
                "    document.execCommand('insertText',false,txt);" +
                "  } else if(window.onClipboardRead){" +
                "    window.onClipboardRead(txt);" +
                "  }" +
                "})()"
            );
        } catch (Exception ex) {
            LOG.warn("Failed to read clipboard for paste action", ex);
        }
    }
}
