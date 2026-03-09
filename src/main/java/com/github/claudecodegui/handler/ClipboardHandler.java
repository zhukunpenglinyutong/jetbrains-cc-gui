package com.github.claudecodegui.handler;

import com.intellij.openapi.diagnostic.Logger;

import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;

/**
 * Handler for clipboard operations from webview.
 * Security: rate limiting and size bounds protect against abuse from WebView JS.
 */
public class ClipboardHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ClipboardHandler.class);
    private static final String[] SUPPORTED_TYPES = {"read_clipboard", "write_clipboard"};

    private static final long MIN_READ_INTERVAL_MS = 200;
    private static final int MAX_CLIPBOARD_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB

    private long lastReadTime = 0;

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
        // Rate limiting to prevent clipboard-monitoring abuse
        long now = System.currentTimeMillis();
        if (now - lastReadTime < MIN_READ_INTERVAL_MS) {
            LOG.debug("Clipboard read rate-limited");
            callJavaScript("window.onClipboardRead", "");
            return;
        }
        lastReadTime = now;

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
        if (content != null && content.length() > MAX_CLIPBOARD_WRITE_SIZE) {
            LOG.warn("Clipboard write rejected: content too large (" + content.length() + " chars)");
            return;
        }
        try {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            clipboard.setContents(new StringSelection(content), null);
        } catch (Exception e) {
            LOG.warn("Failed to write clipboard", e);
        }
    }
}
