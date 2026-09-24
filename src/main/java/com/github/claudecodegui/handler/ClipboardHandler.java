package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;

import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import javax.imageio.ImageIO;

/**
 * Handler for clipboard operations from webview.
 * Security: rate limiting and size bounds protect against abuse from WebView JS.
 */
public class ClipboardHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ClipboardHandler.class);
    private static final String[] SUPPORTED_TYPES = {"read_clipboard", "write_clipboard", "paste_image"};

    private static final long MIN_READ_INTERVAL_MS = 200;
    private static final int MAX_CLIPBOARD_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB
    private static final int MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB base64 limit

    private volatile long lastReadTime = 0;

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
            case "read_clipboard" -> {
                handleReadClipboard();
                yield true;
            }
            case "write_clipboard" -> {
                handleWriteClipboard(content);
                yield true;
            }
            case "paste_image" -> {
                handlePasteImage();
                yield true;
            }
            default -> false;
        };
    }

    private void handleReadClipboard() {
        // Rate limiting to prevent clipboard-monitoring abuse (checked synchronously before dispatch)
        long now = System.currentTimeMillis();
        if (now - lastReadTime < MIN_READ_INTERVAL_MS) {
            LOG.debug("Clipboard read rate-limited");
            callJavaScript("window.onClipboardRead", "");
            return;
        }
        lastReadTime = now;

        // Dispatch clipboard access to EDT to avoid blocking the CEF browser thread.
        // Use ModalityState.any() so copy works even when a modal dialog (e.g. PermissionDialog) is open.
        ApplicationManager.getApplication().invokeLater(() -> {
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
        }, ModalityState.any());
    }

    private void handleWriteClipboard(String content) {
        if (content != null && content.length() > MAX_CLIPBOARD_WRITE_SIZE) {
            LOG.warn("Clipboard write rejected: content too large (" + content.length() + " chars)");
            return;
        }
        // Dispatch clipboard access to EDT to avoid blocking the CEF browser thread.
        // Use ModalityState.any() so copy works even when a modal dialog (e.g. PermissionDialog) is open.
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
                clipboard.setContents(new StringSelection(content), null);
            } catch (Exception e) {
                LOG.warn("Failed to write clipboard", e);
            }
        }, ModalityState.any());
    }

    private void handlePasteImage() {
        try {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            if (!clipboard.isDataFlavorAvailable(DataFlavor.imageFlavor)) {
                return;
            }
            Image image = (Image) clipboard.getData(DataFlavor.imageFlavor);
            if (image == null) {
                return;
            }

            BufferedImage buffered;
            if (image instanceof BufferedImage) {
                buffered = (BufferedImage) image;
            } else {
                buffered = new BufferedImage(
                        image.getWidth(null), image.getHeight(null), BufferedImage.TYPE_INT_ARGB);
                Graphics2D g = buffered.createGraphics();
                g.drawImage(image, 0, 0, null);
                g.dispose();
            }

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            ImageIO.write(buffered, "png", baos);
            byte[] bytes = baos.toByteArray();

            if (bytes.length == 0) {
                LOG.warn("Clipboard image produced empty PNG");
                return;
            }

            String base64 = Base64.getEncoder().encodeToString(bytes);
            if (base64.length() > MAX_IMAGE_SIZE) {
                LOG.warn("Clipboard image too large (" + base64.length() + " chars), skipping");
                return;
            }

            String js = "window.dispatchEvent(new CustomEvent('java-paste-image', " +
                    "{ detail: { base64: '" + base64 + "', mediaType: 'image/png' } }));";
            executeJavaScript(js);
        } catch (Exception e) {
            LOG.warn("Failed to read clipboard image", e);
        }
    }
}
