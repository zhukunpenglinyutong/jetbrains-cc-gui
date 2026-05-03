package com.github.claudecodegui.action;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.google.gson.Gson;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.NotNull;
import com.intellij.openapi.project.Project;

import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.io.ByteArrayOutputStream;
import java.util.Base64;

/**
 * IDEA Action for Ctrl+V in the Claude chat tool window.
 * Reads system clipboard and inserts text at the cursor in the focused element,
 * supporting contenteditable divs, input fields, and textareas.
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
                if (isLocalFileUri(text)) text = "";
            }
            if (text.isEmpty()) {
                // No text in clipboard - check for image data
                if (clipboard.isDataFlavorAvailable(DataFlavor.imageFlavor)) {
                    BufferedImage image = (BufferedImage) clipboard.getData(DataFlavor.imageFlavor);
                    if (image != null) {
                        try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                            ImageIO.write(image, "png", baos);
                            String base64 = Base64.getEncoder().encodeToString(baos.toByteArray());
                            // Use Gson JSON encoding to safely embed base64 data, consistent with text paste below
                            String jsonBase64 = GSON.toJson(base64);
                            chatWindow.executeJavaScriptCode(
                                "(function(){" +
                                "  window.dispatchEvent(new CustomEvent('java-paste-image',{detail:{base64:" + jsonBase64 + ",mediaType:'image/png'}}));" +
                                "})()"
                            );
                        }
                    }
                }
                return;
            }

            // Use Gson JSON encoding to safely embed clipboard text, preventing JS injection
            String jsonEncoded = GSON.toJson(text);
            chatWindow.executeJavaScriptCode(
                "(function(){" +
                "  var txt=" + jsonEncoded + ";" +
                "  var el=document.activeElement;" +
                "  if(el&&el.getAttribute('contenteditable')==='true'){" +
                "    document.execCommand('insertText',false,txt);" +
                "  } else if(el&&(el.tagName==='INPUT'||el.tagName==='TEXTAREA')){" +
                "    var s=el.selectionStart,e=el.selectionEnd;" +
                "    el.setRangeText(txt,s,e,'end');" +
                "    el.dispatchEvent(new Event('input',{bubbles:true}));" +
                "  } else if(window.onClipboardRead){" +
                "    var cb=window.onClipboardRead;" +
                "    window.onClipboardRead=undefined;" +
                "    cb(txt);" +
                "  }" +
                "})()"
            );
        } catch (Exception ex) {
            LOG.warn("Failed to read clipboard for paste action", ex);
        }
    }

    private static boolean isLocalFileUri(String text) {
        if (text == null) {
            return false;
        }
        String normalized = text.trim().toLowerCase();
        return normalized.startsWith("file://");
    }
}
