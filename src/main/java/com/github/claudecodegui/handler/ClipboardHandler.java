package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;

import javax.imageio.ImageIO;
import java.awt.Image;
import java.awt.Toolkit;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;
import java.awt.datatransfer.Transferable;
import java.awt.datatransfer.UnsupportedFlavorException;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Base64;
import java.util.Locale;

/**
 * Handler for clipboard operations from webview.
 * Security: rate limiting and size bounds protect against abuse from WebView JS.
 */
public class ClipboardHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ClipboardHandler.class);
    private static final String TYPE_READ_CLIPBOARD = "read_clipboard";
    private static final String TYPE_WRITE_CLIPBOARD = "write_clipboard";
    private static final String TYPE_WRITE_CLIPBOARD_IMAGE = "write_clipboard_image";
    private static final String[] SUPPORTED_TYPES = {
            TYPE_READ_CLIPBOARD,
            TYPE_WRITE_CLIPBOARD,
            TYPE_WRITE_CLIPBOARD_IMAGE
    };

    private static final long MIN_READ_INTERVAL_MS = 200;
    private static final int MAX_CLIPBOARD_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB
    private static final int MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB
    private static final int IMAGE_FETCH_TIMEOUT_MS = 8_000;

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
            case TYPE_READ_CLIPBOARD -> {
                handleReadClipboard();
                yield true;
            }
            case TYPE_WRITE_CLIPBOARD -> {
                handleWriteClipboard(content);
                yield true;
            }
            case TYPE_WRITE_CLIPBOARD_IMAGE -> {
                handleWriteClipboardImage(content);
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
                    if (isLocalFileUri(text)) {
                        text = "";
                    }
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

    private void handleWriteClipboardImage(String content) {
        String imageSrc = extractImageSource(content);
        if (imageSrc.isEmpty()) {
            LOG.warn("Clipboard image write rejected: empty image source");
            return;
        }

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                BufferedImage image = readImageFromSource(imageSrc);
                if (image == null) {
                    LOG.warn("Clipboard image write rejected: unsupported or unreadable image source");
                    return;
                }
                Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
                clipboard.setContents(new ImageTransferable(image), null);
            } catch (Exception e) {
                LOG.warn("Failed to write image to clipboard", e);
            }
        }, ModalityState.any());
    }

    private String extractImageSource(String content) {
        if (content == null) {
            return "";
        }
        String trimmed = content.trim();
        if (trimmed.isEmpty()) {
            return "";
        }

        // Prefer structured payloads from frontend: {"src":"..."}
        if (trimmed.startsWith("{")) {
            try {
                com.google.gson.JsonObject payload =
                        com.google.gson.JsonParser.parseString(trimmed).getAsJsonObject();
                if (payload.has("src") && payload.get("src").isJsonPrimitive()) {
                    String src = payload.get("src").getAsString();
                    return src != null ? src.trim() : "";
                }
            } catch (Exception ignored) {
                // Fall back to raw payload parsing below.
            }
        }

        return trimmed;
    }

    private boolean isLocalFileUri(String text) {
        if (text == null) {
            return false;
        }
        String normalized = text.trim().toLowerCase(Locale.ROOT);
        return normalized.startsWith("file://");
    }

    private BufferedImage readImageFromSource(String imageSrc) throws IOException {
        if (imageSrc.regionMatches(true, 0, "data:", 0, 5)) {
            return readImageFromDataUrl(imageSrc);
        }
        if (imageSrc.regionMatches(true, 0, "http://", 0, 7)
                || imageSrc.regionMatches(true, 0, "https://", 0, 8)) {
            return readImageFromHttp(imageSrc);
        }

        LOG.warn("Clipboard image write rejected: unsupported image source scheme");
        return null;
    }

    private BufferedImage readImageFromDataUrl(String dataUrl) throws IOException {
        int commaIndex = dataUrl.indexOf(',');
        if (commaIndex <= 0 || commaIndex >= dataUrl.length() - 1) {
            throw new IOException("Invalid data URL format");
        }

        String metadata = dataUrl.substring(5, commaIndex).toLowerCase(Locale.ROOT);
        if (!metadata.contains(";base64")) {
            throw new IOException("Only base64 data URLs are supported");
        }

        String base64Data = dataUrl.substring(commaIndex + 1);
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(base64Data);
        } catch (IllegalArgumentException ex) {
            throw new IOException("Invalid base64 image data", ex);
        }

        if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
            throw new IOException("Image data too large");
        }

        return decodeImageBytes(bytes);
    }

    private BufferedImage readImageFromHttp(String imageUrl) throws IOException {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(imageUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(IMAGE_FETCH_TIMEOUT_MS);
            connection.setReadTimeout(IMAGE_FETCH_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "CC-GUI/Clipboard");
            connection.connect();

            int responseCode = connection.getResponseCode();
            if (responseCode < 200 || responseCode >= 300) {
                throw new IOException("HTTP fetch failed with status " + responseCode);
            }

            int contentLength = connection.getContentLength();
            if (contentLength > MAX_CLIPBOARD_IMAGE_BYTES) {
                throw new IOException("Image response too large");
            }

            try (InputStream inputStream = connection.getInputStream()) {
                byte[] bytes = readBytesWithLimit(inputStream, MAX_CLIPBOARD_IMAGE_BYTES);
                return decodeImageBytes(bytes);
            }
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private byte[] readBytesWithLimit(InputStream inputStream, int maxBytes) throws IOException {
        try (ByteArrayOutputStream outputStream = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int totalRead = 0;
            int bytesRead;
            while ((bytesRead = inputStream.read(buffer)) != -1) {
                totalRead += bytesRead;
                if (totalRead > maxBytes) {
                    throw new IOException("Image data exceeds size limit");
                }
                outputStream.write(buffer, 0, bytesRead);
            }
            return outputStream.toByteArray();
        }
    }

    private BufferedImage decodeImageBytes(byte[] bytes) throws IOException {
        try (ByteArrayInputStream inputStream = new ByteArrayInputStream(bytes)) {
            BufferedImage image = ImageIO.read(inputStream);
            if (image == null) {
                throw new IOException("Unsupported image format");
            }
            return image;
        }
    }

    private static final class ImageTransferable implements Transferable {
        private static final DataFlavor[] FLAVORS = {DataFlavor.imageFlavor};

        private final Image image;

        private ImageTransferable(Image image) {
            this.image = image;
        }

        @Override
        public DataFlavor[] getTransferDataFlavors() {
            return FLAVORS.clone();
        }

        @Override
        public boolean isDataFlavorSupported(DataFlavor flavor) {
            return DataFlavor.imageFlavor.equals(flavor);
        }

        @Override
        public Object getTransferData(DataFlavor flavor) throws UnsupportedFlavorException {
            if (!isDataFlavorSupported(flavor)) {
                throw new UnsupportedFlavorException(flavor);
            }
            return image;
        }
    }
}
