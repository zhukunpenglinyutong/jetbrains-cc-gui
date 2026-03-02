package com.github.claudecodegui.handler;

import com.intellij.openapi.diagnostic.Logger;

import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;

/**
 * Handler for clipboard operations from webview.
 */
public class ClipboardHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ClipboardHandler.class);
    private static final String[] SUPPORTED_TYPES = {"read_clipboard", "write_clipboard"};

    public ClipboardHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        return switch (type) {
            case "read_clipboard" -> { handleReadClipboard(); yield true; }
            case "write_clipboard" -> { handleWriteClipboard(content); yield true; }
            default -> false;
        };
    }

    private void handleReadClipboard() {
        try {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            if (clipboard.isDataFlavorAvailable(DataFlavor.stringFlavor)) {
                String text = (String) clipboard.getData(DataFlavor.stringFlavor);
                callJavaScript("window.onClipboardRead", escapeJs(text != null ? text : ""));
            } else {
                callJavaScript("window.onClipboardRead", "");
            }
        } catch (Exception e) {
            LOG.warn("Failed to read clipboard", e);
            callJavaScript("window.onClipboardRead", "");
        }
    }

    private void handleWriteClipboard(String content) {
        try {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            clipboard.setContents(new StringSelection(content), null);
        } catch (Exception e) {
            LOG.warn("Failed to write clipboard", e);
        }
    }
}
