package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.application.ModalityState;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.awt.*;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import java.util.UUID;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.Supplier;
import javax.imageio.ImageIO;

/**
 * Handler for clipboard operations from webview.
 * Native image reads run on the EDT; raster conversion and encoding run in the background.
 * Security: rate limiting and size bounds protect against abuse from WebView JS.
 */
public class ClipboardHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(ClipboardHandler.class);
    private static final Gson GSON = new Gson();
    private static final String[] SUPPORTED_TYPES = {"read_clipboard", "write_clipboard", "paste_image", "paste_image_scope"};

    private static final long MIN_READ_INTERVAL_MS = 200;
    private static final int MAX_CLIPBOARD_WRITE_SIZE = 10 * 1024 * 1024; // 10 MB
    private static final int MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB base64 limit
    private static final long MAX_IMAGE_PIXELS = 16L * 1024 * 1024;
    private static final int MAX_PENDING_IMAGES = 2;
    private static final int MAX_IMAGE_REQUEST_LENGTH = 1024;
    private static final long SNAPSHOT_TIMEOUT_SECONDS = 30;

    private final Consumer<Runnable> clipboardScheduler;
    private final Executor imageEncoder;
    private final Supplier<Image> clipboardImageReader;
    private final Function<Runnable, Runnable> expirationScheduler;
    private final Semaphore imageSlots = new Semaphore(MAX_PENDING_IMAGES);
    private final Map<String, ImageOffer> imageOffers = new ConcurrentHashMap<>();
    private volatile boolean disposed;
    private volatile String imageScopeId;
    private volatile long lastReadTime = 0;

    /**
     * Create a clipboard handler that keeps native reads and image encoding off the JCEF thread.
     */
    public ClipboardHandler(HandlerContext context) {
        this(context,
                task -> ApplicationManager.getApplication().invokeLater(task, ModalityState.any()),
                task -> AppExecutorUtil.getAppExecutorService().execute(task),
                ClipboardHandler::readClipboardImage,
                task -> {
                    var expiry = AppExecutorUtil.getAppScheduledExecutorService()
                            .schedule(task, SNAPSHOT_TIMEOUT_SECONDS, TimeUnit.SECONDS);
                    return () -> expiry.cancel(false);
                });
    }

    ClipboardHandler(HandlerContext context, Consumer<Runnable> clipboardScheduler,
                     Executor imageEncoder, Supplier<Image> clipboardImageReader,
                     Function<Runnable, Runnable> expirationScheduler) {
        super(context);
        this.clipboardScheduler = clipboardScheduler;
        this.imageEncoder = imageEncoder;
        this.clipboardImageReader = clipboardImageReader;
        this.expirationScheduler = expirationScheduler;
    }

    /**
     * Return the clipboard operations accepted by this handler.
     */
    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    /**
     * Schedule the requested clipboard operation without waiting for native image access.
     */
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
                this.handlePasteImage(content);
                yield true;
            }
            case "paste_image_scope" -> {
                this.publishImageScope(content);
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

    private void publishImageScope(String scopeId) {
        if (this.disposed || (scopeId != null && scopeId.length() > 128)) {
            return;
        }
        this.imageScopeId = scopeId == null || scopeId.isEmpty() ? null : scopeId;
        for (Map.Entry<String, ImageOffer> entry : this.imageOffers.entrySet()) {
            if (!entry.getValue().scopeId.equals(this.imageScopeId)) {
                this.discardOffer(entry.getKey());
            }
        }
    }

    private boolean recognizesImageScope(String scopeId) {
        return scopeId != null && scopeId.equals(this.imageScopeId) && !this.disposed && !this.context.isDisposed();
    }

    private void handlePasteImage(String requestId) {
        // Claims contain only opaque ids; oversized metadata must not allocate a JSON tree or a large JS reply.
        if (requestId != null && requestId.length() > MAX_IMAGE_REQUEST_LENGTH) {
            LOG.warn("Clipboard image request metadata exceeds its limit");
            return;
        }
        // Bind the reply before yielding: encoding may finish after a page reload or browser replacement.
        Consumer<String> reply = this.context.captureJavaScriptExecutor();
        if (requestId != null && requestId.startsWith("{")) {
            String ownedId = null;
            ImageOffer claimed = null;
            try {
                JsonObject request = JsonParser.parseString(requestId).getAsJsonObject();
                ownedId = request.get("requestId").getAsString();
                String snapshotId = request.get("snapshotId").getAsString();
                String scopeId = request.get("scopeId").getAsString();
                claimed = this.imageOffers.remove(snapshotId);
                if (claimed == null) {
                    this.dispatchImageReply(reply, ownedId, null);
                } else {
                    claimed.cancelExpiry.run();
                    if (!claimed.scopeId.equals(scopeId) || !this.recognizesImageScope(scopeId)) {
                        claimed.release.run();
                        this.dispatchImageReply(reply, ownedId, null);
                    } else {
                        this.encodeAndReply(claimed.reply, ownedId, claimed.image, claimed.release);
                    }
                }
            } catch (RuntimeException e) {
                if (claimed != null) {
                    claimed.release.run();
                }
                this.dispatchImageReply(reply, ownedId, null);
                LOG.warn("Invalid clipboard snapshot claim", e);
            }
            return;
        }
        if (this.disposed || this.context.isDisposed() || !this.imageSlots.tryAcquire()) {
            this.dispatchImageReply(reply, requestId, null);
            return;
        }
        Runnable release = this.releaseOnce();
        try {
            this.clipboardScheduler.accept(() -> {
                if (this.disposed || this.context.isDisposed()) {
                    release.run();
                    return;
                }
                try {
                    Image image = this.clipboardImageReader.get();
                    if (image == null) {
                        release.run();
                        this.dispatchImageReply(reply, requestId, null);
                    } else {
                        this.encodeAndReply(reply, requestId, image, release);
                    }
                } catch (Exception e) {
                    release.run();
                    LOG.warn("Failed to schedule clipboard image encoding", e);
                    this.dispatchImageReply(reply, requestId, null);
                }
            });
        } catch (Exception e) {
            release.run();
            LOG.warn("Failed to schedule clipboard image read", e);
            this.dispatchImageReply(reply, requestId, null);
        }
    }

    /** Capture the macOS hook's clipboard on its first EDT handoff, before requesting draft ownership. */
    public void captureClipboardPaste() {
        String scopeId = this.imageScopeId;
        Consumer<String> reply = this.context.captureJavaScriptExecutor();
        if (!this.recognizesImageScope(scopeId) || !this.imageSlots.tryAcquire()) {
            return;
        }
        Runnable release = this.releaseOnce();
        try {
            this.clipboardScheduler.accept(() -> {
                try {
                    if (!this.recognizesImageScope(scopeId)) {
                        release.run();
                        return;
                    }
                    this.offerImage(this.clipboardImageReader.get(), reply, release, scopeId);
                } catch (RuntimeException e) {
                    release.run();
                    LOG.warn("Failed to capture clipboard paste", e);
                }
            });
        } catch (RuntimeException e) {
            release.run();
            LOG.warn("Failed to schedule clipboard paste capture", e);
        }
    }

    /** Preserve an image already read by an IDE action while the frontend claims its draft. */
    public boolean offerImagePaste(Image image) {
        String scopeId = this.imageScopeId;
        if (!this.recognizesImageScope(scopeId) || !this.imageSlots.tryAcquire()) {
            return false;
        }
        Runnable release = this.releaseOnce();
        try {
            return this.offerImage(image, this.context.captureJavaScriptExecutor(), release, scopeId);
        } catch (RuntimeException e) {
            release.run();
            LOG.warn("Failed to capture clipboard reply ownership", e);
            return false;
        }
    }

    private boolean offerImage(Image image, Consumer<String> reply, Runnable release, String scopeId) {
        if (image == null || !this.recognizesImageScope(scopeId)) {
            release.run();
            return false;
        }
        String snapshotId = UUID.randomUUID().toString();
        ImageOffer offer = new ImageOffer(image, reply, release, scopeId);
        this.imageOffers.put(snapshotId, offer);
        try {
            offer.cancelExpiry = this.expirationScheduler.apply(() -> this.discardOffer(snapshotId));
            if (!this.recognizesImageScope(scopeId)) {
                this.discardOffer(snapshotId);
                return false;
            }
            reply.accept("window.dispatchEvent(new CustomEvent('java-request-paste-image', "
                    + "{ detail: { snapshotId: " + GSON.toJson(snapshotId)
                    + ", scopeId: " + GSON.toJson(scopeId) + " } }));");
            return true;
        } catch (RuntimeException e) {
            this.discardOffer(snapshotId);
            LOG.warn("Failed to offer clipboard snapshot", e);
            return false;
        }
    }

    private void encodeAndReply(Consumer<String> reply, String requestId, Image image, Runnable release) {
        try {
            this.imageEncoder.execute(() -> {
                try {
                    this.dispatchImageReply(reply, requestId, this.encodeImage(image));
                } finally {
                    release.run();
                }
            });
        } catch (RuntimeException e) {
            release.run();
            this.dispatchImageReply(reply, requestId, null);
            LOG.warn("Failed to schedule clipboard encoding", e);
        }
    }

    private Runnable releaseOnce() {
        AtomicBoolean released = new AtomicBoolean();
        return () -> {
            if (released.compareAndSet(false, true)) {
                this.imageSlots.release();
            }
        };
    }

    private void discardOffer(String snapshotId) {
        ImageOffer offer = this.imageOffers.remove(snapshotId);
        if (offer != null) {
            offer.cancelExpiry.run();
            offer.release.run();
        }
    }

    /** Release unclaimed native images when their chat window closes. */
    public void dispose() {
        this.disposed = true;
        this.imageScopeId = null;
        for (String snapshotId : this.imageOffers.keySet()) {
            this.discardOffer(snapshotId);
        }
    }

    private static final class ImageOffer {
        private final Image image;
        private final Consumer<String> reply;
        private final Runnable release;
        private final String scopeId;
        private volatile Runnable cancelExpiry = () -> { };

        private ImageOffer(Image image, Consumer<String> reply, Runnable release, String scopeId) {
            this.image = image;
            this.reply = reply;
            this.release = release;
            this.scopeId = scopeId;
        }
    }

    private void dispatchImageReply(Consumer<String> reply, String requestId, String base64) {
        if (base64 == null && (requestId == null || requestId.isEmpty())) {
            return;
        }
        // JSON encoding keeps an opaque request id safe when it crosses back into JavaScript.
        String encodedImage = base64 == null ? "null" : "'" + base64 + "'";
        reply.accept("window.dispatchEvent(new CustomEvent('java-paste-image', "
                + "{ detail: { base64: " + encodedImage + ", mediaType: 'image/png', requestId: "
                + GSON.toJson(requestId) + " } }));");
    }

    private static Image readClipboardImage() {
        try {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            if (clipboard.isDataFlavorAvailable(DataFlavor.imageFlavor)) {
                Object image = clipboard.getData(DataFlavor.imageFlavor);
                if (image instanceof Image) {
                    return (Image) image;
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to read clipboard image", e);
        }
        return null;
    }

    private String encodeImage(Image image) {
        if (this.disposed || this.context.isDisposed()) {
            return null;
        }
        try {
            BufferedImage buffered = toBufferedImage(image);
            if (buffered == null) {
                return null;
            }
            try (ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
                if (!ImageIO.write(buffered, "png", baos) || baos.size() == 0) {
                    LOG.warn("Clipboard image produced empty PNG");
                    return null;
                }
                // Bound the encoded payload before allocating its Base64 representation.
                long base64Length = ((baos.size() + 2L) / 3) * 4;
                if (base64Length > MAX_IMAGE_SIZE) {
                    LOG.warn("Clipboard image too large (" + base64Length + " chars), skipping");
                    return null;
                }
                return Base64.getEncoder().encodeToString(baos.toByteArray());
            }
        } catch (Exception e) {
            LOG.warn("Failed to encode clipboard image", e);
            return null;
        }
    }

    private static BufferedImage toBufferedImage(Image image) {
        // macOS screenshots can use MultiResolutionCachedImage instead of BufferedImage.
        int width = image.getWidth(null);
        int height = image.getHeight(null);
        if (width <= 0 || height <= 0 || (long) width * height > MAX_IMAGE_PIXELS) {
            return null;
        }
        if (image instanceof BufferedImage) {
            return (BufferedImage) image;
        }
        BufferedImage buffered = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
        Graphics2D graphics = buffered.createGraphics();
        try {
            graphics.drawImage(image, 0, 0, null);
        } finally {
            graphics.dispose();
        }
        return buffered;
    }
}
