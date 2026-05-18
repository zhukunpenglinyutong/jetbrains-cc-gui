package com.github.claudecodegui.util;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.imageio.ImageIO;

/**
 * Persists attachment files and tracks session-to-resource references.
 */
public final class AttachmentStorageService {

    private static final Logger LOG = Logger.getInstance(AttachmentStorageService.class);
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final int THUMBNAIL_MAX_EDGE = 360;

    private static final AttachmentStorageService INSTANCE = new AttachmentStorageService(new ConfigPathManager());

    private final ConfigPathManager pathManager;
    private final Path attachmentRoot;
    private final Path storeDir;
    private final Path indexDir;
    private final Path pendingDir;

    private AttachmentStorageService(ConfigPathManager pathManager) {
        this.pathManager = pathManager;
        Path configDir = pathManager.getConfigDir();
        this.attachmentRoot = configDir.resolve("attachments");
        this.storeDir = attachmentRoot.resolve("store");
        this.indexDir = attachmentRoot.resolve("index");
        this.pendingDir = attachmentRoot.resolve("pending");
    }

    public static AttachmentStorageService getInstance() {
        return INSTANCE;
    }

    public PersistedAttachment persistImageAttachment(
            String provider,
            String sessionKey,
            String fileName,
            String mediaType,
            String base64Data
    ) {
        if (base64Data == null || base64Data.isBlank()) {
            return null;
        }

        try {
            ensureDirectories();
            byte[] bytes = Base64.getDecoder().decode(base64Data);
            String hash = sha256(bytes);
            String extension = extensionFor(mediaType, fileName);

            Path originalPath = storeDir.resolve(hash + extension);
            if (!Files.exists(originalPath)) {
                Files.write(originalPath, bytes);
            }

            Path thumbnailPath = createThumbnail(hash, extension, mediaType, bytes, originalPath);
            boolean hasDedicatedThumbnail = thumbnailPath != null && !thumbnailPath.equals(originalPath);
            String originalMediaType = normalizeMediaType(mediaType, extension);
            String thumbnailMediaType = hasDedicatedThumbnail
                    ? normalizeMediaType("image/jpeg", ".jpg")
                    : originalMediaType;

            AttachmentResourceService.AttachmentResource originalResource =
                    AttachmentResourceService.registerAttachmentFile(originalPath.toFile(), originalMediaType);
            AttachmentResourceService.AttachmentResource thumbnailResource = hasDedicatedThumbnail
                    ? AttachmentResourceService.registerAttachmentFile(thumbnailPath.toFile(), thumbnailMediaType)
                    : null;

            AttachmentRecord record = new AttachmentRecord(
                    hash,
                    fileName,
                    originalMediaType,
                    originalPath.getFileName().toString(),
                    hasDedicatedThumbnail ? thumbnailPath.getFileName().toString() : null
            );
            appendRecord(provider, sessionKey, record);

            return new PersistedAttachment(
                    hash,
                    originalPath.toString(),
                    originalResource.url(),
                    thumbnailResource != null ? thumbnailResource.url() : originalResource.url(),
                    originalMediaType
            );
        } catch (Exception e) {
            LOG.warn("[AttachmentStorage] Failed to persist image attachment: " + e.getMessage(), e);
            return null;
        }
    }

    public void promotePendingSession(String provider, String pendingKey, String sessionId) {
        if (provider == null || provider.isBlank() || pendingKey == null || pendingKey.isBlank()
                || sessionId == null || sessionId.isBlank() || pendingKey.equals(sessionId)) {
            return;
        }

        try {
            ensureDirectories();
            Path pendingFile = indexPath(provider, pendingKey);
            if (!Files.exists(pendingFile)) {
                return;
            }

            Path targetFile = indexPath(provider, sessionId);
            JsonObject merged = mergeIndexes(readIndex(pendingFile), readIndex(targetFile));
            writeIndex(targetFile, merged);
            Files.deleteIfExists(pendingFile);
        } catch (Exception e) {
            LOG.warn("[AttachmentStorage] Failed to promote pending session index: " + e.getMessage(), e);
        }
    }

    public List<AttachmentRecord> loadSessionRecords(String provider, String sessionId) {
        try {
            ensureDirectories();
            JsonObject root = readIndex(indexPath(provider, sessionId));
            return parseRecords(root);
        } catch (Exception e) {
            LOG.warn("[AttachmentStorage] Failed to load session attachment index: " + e.getMessage(), e);
            return List.of();
        }
    }

    public void deleteSessionRecords(String provider, String sessionId) {
        try {
            ensureDirectories();
            Path target = indexPath(provider, sessionId);
            Files.deleteIfExists(target);
        } catch (Exception e) {
            LOG.warn("[AttachmentStorage] Failed to delete session attachment index: " + e.getMessage(), e);
        }
    }

    public void cleanupOrphanedResources(Set<String> stillReferencedHashes) {
        try {
            ensureDirectories();
            if (!Files.exists(storeDir)) {
                return;
            }

            try (var stream = Files.list(storeDir)) {
                stream.filter(Files::isRegularFile).forEach(path -> {
                    String fileName = path.getFileName().toString();
                    String hash = stripKnownSuffix(fileName);
                    if (stillReferencedHashes.contains(hash)) {
                        return;
                    }
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException e) {
                        LOG.warn("[AttachmentStorage] Failed to delete orphaned resource: " + fileName, e);
                    }
                });
            }
        } catch (Exception e) {
            LOG.warn("[AttachmentStorage] Failed to cleanup orphaned resources: " + e.getMessage(), e);
        }
    }

    public Set<String> collectAllReferencedHashes() {
        Set<String> hashes = new LinkedHashSet<>();
        try {
            ensureDirectories();
            collectHashesFromIndexDir(indexDir, hashes);
            collectHashesFromFlatDir(pendingDir, hashes);
        } catch (Exception e) {
            LOG.warn("[AttachmentStorage] Failed to collect referenced hashes: " + e.getMessage(), e);
        }
        return hashes;
    }

    public JsonObject createImageBlockFromPath(String imagePath) {
        if (imagePath == null || imagePath.isBlank()) {
            return null;
        }

        try {
            Path path = Path.of(imagePath);
            if (!Files.isRegularFile(path)) {
                return null;
            }

            String mediaType = Files.probeContentType(path);
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = normalizeMediaType(null, extensionFor(null, path.getFileName() != null ? path.getFileName().toString() : ""));
            }

            AttachmentResourceService.AttachmentResource original =
                    AttachmentResourceService.registerAttachmentFile(path.toFile(), mediaType);
            Path thumbnailPath = resolveThumbnailPath(path);
            AttachmentResourceService.AttachmentResource thumbnail = null;
            if (thumbnailPath != null && Files.isRegularFile(thumbnailPath)) {
                thumbnail = AttachmentResourceService.registerAttachmentFile(thumbnailPath.toFile(), "image/jpeg");
            }
            JsonObject imageBlock = new JsonObject();
            imageBlock.addProperty("type", "image");
            imageBlock.addProperty("src", thumbnail != null ? thumbnail.url() : original.url());
            imageBlock.addProperty("previewSrc", original.url());
            imageBlock.addProperty("thumbnailSrc", thumbnail != null ? thumbnail.url() : original.url());
            imageBlock.addProperty("mediaType", mediaType);
            imageBlock.addProperty("alt", path.getFileName() != null ? path.getFileName().toString() : "image");
            return imageBlock;
        } catch (Exception e) {
            LOG.warn("[AttachmentStorage] Failed to create image block from path: " + imagePath, e);
            return null;
        }
    }

    private void ensureDirectories() throws IOException {
        pathManager.ensureConfigDirectory();
        Files.createDirectories(attachmentRoot);
        Files.createDirectories(storeDir);
        Files.createDirectories(indexDir);
        Files.createDirectories(pendingDir);
    }

    private Path createThumbnail(String hash, String extension, String mediaType, byte[] bytes, Path originalPath) {
        if (mediaType != null && mediaType.toLowerCase(Locale.ROOT).contains("svg")) {
            return null;
        }

        try (InputStream input = new ByteArrayInputStream(bytes)) {
            BufferedImage source = ImageIO.read(input);
            if (source == null) {
                return null;
            }

            int width = source.getWidth();
            int height = source.getHeight();
            int maxEdge = Math.max(width, height);
            if (maxEdge <= THUMBNAIL_MAX_EDGE) {
                return originalPath;
            }

            double scale = (double) THUMBNAIL_MAX_EDGE / (double) maxEdge;
            int targetWidth = Math.max(1, (int) Math.round(width * scale));
            int targetHeight = Math.max(1, (int) Math.round(height * scale));
            BufferedImage thumbnail = new BufferedImage(targetWidth, targetHeight, BufferedImage.TYPE_INT_RGB);
            Graphics2D graphics = thumbnail.createGraphics();
            try {
                graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
                graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
                graphics.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
                graphics.drawImage(source, 0, 0, targetWidth, targetHeight, null);
            } finally {
                graphics.dispose();
            }

            Path thumbnailPath = storeDir.resolve(hash + ".thumb.jpg");
            if (!Files.exists(thumbnailPath)) {
                ImageIO.write(thumbnail, "jpg", thumbnailPath.toFile());
            }
            return thumbnailPath;
        } catch (Exception e) {
            LOG.debug("[AttachmentStorage] Thumbnail generation skipped: " + e.getMessage());
            return originalPath;
        }
    }

    private void appendRecord(String provider, String sessionKey, AttachmentRecord record) throws IOException {
        Path target = indexPath(provider, sessionKey);
        JsonObject root = readIndex(target);
        JsonArray items = root.has("items") && root.get("items").isJsonArray()
                ? root.getAsJsonArray("items")
                : new JsonArray();

        boolean exists = false;
        for (JsonElement item : items) {
            if (!item.isJsonObject()) {
                continue;
            }
            JsonObject obj = item.getAsJsonObject();
            if (record.hash().equals(getString(obj, "hash"))) {
                exists = true;
                break;
            }
        }
        if (!exists) {
            items.add(record.toJson());
        }

        root.addProperty("provider", provider);
        root.addProperty("sessionKey", sessionKey);
        root.add("items", items);
        writeIndex(target, root);
    }

    private void collectHashesFromIndexDir(Path rootDir, Set<String> hashes) throws IOException {
        if (!Files.exists(rootDir)) {
            return;
        }
        try (var providerDirs = Files.list(rootDir)) {
            providerDirs.filter(Files::isDirectory).forEach(providerDir -> {
                try (var files = Files.list(providerDir)) {
                    files.filter(Files::isRegularFile).forEach(indexFile -> {
                        try {
                            for (AttachmentRecord record : parseRecords(readIndex(indexFile))) {
                                hashes.add(record.hash());
                            }
                        } catch (Exception e) {
                            LOG.debug("[AttachmentStorage] Skip unreadable index " + indexFile + ": " + e.getMessage());
                        }
                    });
                } catch (IOException e) {
                    LOG.debug("[AttachmentStorage] Failed to list provider index dir: " + e.getMessage());
                }
            });
        }
    }

    private void collectHashesFromFlatDir(Path rootDir, Set<String> hashes) throws IOException {
        if (!Files.exists(rootDir)) {
            return;
        }
        try (var files = Files.list(rootDir)) {
            files.filter(Files::isRegularFile).forEach(indexFile -> {
                try {
                    for (AttachmentRecord record : parseRecords(readIndex(indexFile))) {
                        hashes.add(record.hash());
                    }
                } catch (Exception e) {
                    LOG.debug("[AttachmentStorage] Skip unreadable pending index " + indexFile + ": " + e.getMessage());
                }
            });
        }
    }

    private Path indexPath(String provider, String sessionKey) {
        String providerKey = (provider == null || provider.isBlank()) ? "claude" : provider;
        Path root = sessionKey != null && sessionKey.startsWith("epoch-") ? pendingDir : indexDir.resolve(providerKey);
        return root.resolve(sessionKey + ".json");
    }

    private JsonObject readIndex(Path path) throws IOException {
        if (!Files.exists(path)) {
            return new JsonObject();
        }
        String content = Files.readString(path, StandardCharsets.UTF_8);
        JsonElement parsed = JsonParser.parseString(content);
        return parsed != null && parsed.isJsonObject() ? parsed.getAsJsonObject() : new JsonObject();
    }

    private void writeIndex(Path path, JsonObject root) throws IOException {
        Files.createDirectories(path.getParent());
        Files.writeString(path, GSON.toJson(root), StandardCharsets.UTF_8);
    }

    private JsonObject mergeIndexes(JsonObject left, JsonObject right) {
        JsonObject merged = new JsonObject();
        JsonArray items = new JsonArray();
        Map<String, JsonObject> dedup = new LinkedHashMap<>();

        for (AttachmentRecord record : parseRecords(left)) {
            dedup.put(record.hash(), record.toJson());
        }
        for (AttachmentRecord record : parseRecords(right)) {
            dedup.put(record.hash(), record.toJson());
        }
        for (JsonObject item : dedup.values()) {
            items.add(item);
        }
        merged.add("items", items);
        return merged;
    }

    private List<AttachmentRecord> parseRecords(JsonObject root) {
        if (root == null || !root.has("items") || !root.get("items").isJsonArray()) {
            return List.of();
        }
        List<AttachmentRecord> records = new ArrayList<>();
        for (JsonElement item : root.getAsJsonArray("items")) {
            if (!item.isJsonObject()) {
                continue;
            }
            JsonObject obj = item.getAsJsonObject();
            String hash = getString(obj, "hash");
            String fileName = getString(obj, "fileName");
            String mediaType = getString(obj, "mediaType");
            String storedFileName = getString(obj, "storedFileName");
            String thumbnailFileName = getString(obj, "thumbnailFileName");
            if (hash != null && storedFileName != null) {
                records.add(new AttachmentRecord(hash, fileName, mediaType, storedFileName, thumbnailFileName));
            }
        }
        return records;
    }

    private String sha256(byte[] bytes) throws NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(bytes);
        StringBuilder builder = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
            builder.append(String.format("%02x", b));
        }
        return builder.toString();
    }

    private String extensionFor(String mediaType, String fileName) {
        String lowerName = fileName != null ? fileName.toLowerCase(Locale.ROOT) : "";
        int dot = lowerName.lastIndexOf('.');
        if (dot >= 0 && dot < lowerName.length() - 1) {
            String ext = lowerName.substring(dot);
            if (ext.length() <= 8) {
                return ext;
            }
        }
        if (mediaType == null) {
            return ".png";
        }
        String normalized = mediaType.toLowerCase(Locale.ROOT);
        if (normalized.contains("jpeg") || normalized.contains("jpg")) { return ".jpg"; }
        if (normalized.contains("gif")) { return ".gif"; }
        if (normalized.contains("webp")) { return ".webp"; }
        if (normalized.contains("bmp")) { return ".bmp"; }
        if (normalized.contains("svg")) { return ".svg"; }
        return ".png";
    }

    private String normalizeMediaType(String mediaType, String extension) {
        if (mediaType != null && !mediaType.isBlank()) {
            return mediaType;
        }
        switch (extension.toLowerCase(Locale.ROOT)) {
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".gif":
                return "image/gif";
            case ".webp":
                return "image/webp";
            case ".bmp":
                return "image/bmp";
            case ".svg":
                return "image/svg+xml";
            case ".png":
            default:
                return "image/png";
        }
    }

    private String stripKnownSuffix(String fileName) {
        if (fileName.endsWith(".thumb.jpg")) {
            return fileName.substring(0, fileName.length() - ".thumb.jpg".length());
        }
        int dot = fileName.indexOf('.');
        return dot > 0 ? fileName.substring(0, dot) : fileName;
    }

    private Path resolveThumbnailPath(Path originalPath) {
        if (originalPath == null || originalPath.getFileName() == null) {
            return null;
        }
        String fileName = originalPath.getFileName().toString();
        if (fileName.endsWith(".thumb.jpg")) {
            return originalPath;
        }
        String hash = stripKnownSuffix(fileName);
        Path sibling = originalPath.getParent() != null
                ? originalPath.getParent().resolve(hash + ".thumb.jpg")
                : null;
        return sibling != null && Files.isRegularFile(sibling) ? sibling : null;
    }

    private String getString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    public record PersistedAttachment(
            String hash,
            String localPath,
            String resourceUrl,
            String thumbnailUrl,
            String mediaType
    ) {
    }

    public record AttachmentRecord(
            String hash,
            String fileName,
            String mediaType,
            String storedFileName,
            String thumbnailFileName
    ) {
        JsonObject toJson() {
            JsonObject object = new JsonObject();
            object.addProperty("hash", hash);
            object.addProperty("fileName", fileName);
            object.addProperty("mediaType", mediaType);
            object.addProperty("storedFileName", storedFileName);
            if (thumbnailFileName != null) {
                object.addProperty("thumbnailFileName", thumbnailFileName);
            }
            return object;
        }
    }
}
