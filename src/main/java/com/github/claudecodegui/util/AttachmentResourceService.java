package com.github.claudecodegui.util;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Registers persisted attachment files behind opaque JCEF-served URLs.
 */
public final class AttachmentResourceService {

    public static final String ATTACHMENT_RESOURCE_ORIGIN = "https://cc-gui-attachment.local";

    private static final String ATTACHMENT_RESOURCE_HOST = "cc-gui-attachment.local";
    private static final ConcurrentMap<String, AttachmentResource> ATTACHMENT_RESOURCES = new ConcurrentHashMap<>();

    private AttachmentResourceService() {
    }

    public static AttachmentResource registerAttachmentFile(File attachmentFile, String mimeType) throws IOException {
        File canonicalFile = attachmentFile.getCanonicalFile();
        long length = canonicalFile.length();
        long lastModified = canonicalFile.lastModified();
        String canonicalPath = canonicalFile.getPath();
        String extension = extensionForPath(canonicalPath);
        String token = tokenFor(canonicalPath, lastModified, length);
        String version = lastModified + "-" + length;
        String url = ATTACHMENT_RESOURCE_ORIGIN + "/" + token + extension + "?v=" + version;
        AttachmentResource resource = new AttachmentResource(
                canonicalFile.toPath(),
                length,
                lastModified,
                mimeType != null && !mimeType.isBlank() ? mimeType : mimeTypeForExtension(extension),
                url
        );
        ATTACHMENT_RESOURCES.put(token, resource);
        return resource;
    }

    public static boolean isAttachmentUrl(String url) {
        URI uri = parseUri(url);
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && ATTACHMENT_RESOURCE_HOST.equalsIgnoreCase(uri.getHost());
    }

    public static AttachmentResource resolveAttachmentUrl(String url) {
        if (!isAttachmentUrl(url)) {
            return null;
        }

        URI uri = parseUri(url);
        if (uri == null) {
            return null;
        }

        String path = uri.getPath();
        if (path == null || path.length() <= 1) {
            return null;
        }

        String fileName = path.substring(path.lastIndexOf('/') + 1);
        int extensionStart = fileName.indexOf('.');
        String token = extensionStart > 0 ? fileName.substring(0, extensionStart) : fileName;
        AttachmentResource resource = ATTACHMENT_RESOURCES.get(token);
        if (resource == null || !resource.isCurrent()) {
            ATTACHMENT_RESOURCES.remove(token);
            return null;
        }

        return resource;
    }

    private static URI parseUri(String url) {
        if (url == null || url.isEmpty()) {
            return null;
        }

        try {
            return URI.create(url);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String tokenFor(String canonicalPath, long lastModified, long length) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            String source = canonicalPath + '\n' + lastModified + '\n' + length;
            byte[] hash = digest.digest(source.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(hash).substring(0, 32);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 digest is unavailable", e);
        }
    }

    private static String extensionForPath(String path) {
        String lowerPath = path.toLowerCase(Locale.ROOT);
        int dot = lowerPath.lastIndexOf('.');
        return dot >= 0 ? lowerPath.substring(dot) : ".bin";
    }

    private static String mimeTypeForExtension(String extension) {
        switch (extension) {
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

    public record AttachmentResource(
            Path path,
            long length,
            long lastModified,
            String mimeType,
            String url
    ) {
        boolean isCurrent() {
            File file = path.toFile();
            return file.isFile()
                    && file.canRead()
                    && file.length() == length
                    && Math.abs(file.lastModified() - lastModified) < 2000L;
        }
    }
}
