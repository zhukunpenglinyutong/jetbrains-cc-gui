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
 * Registers custom UI font files behind opaque JCEF-served URLs.
 */
public final class UiFontResourceService {

    public static final String FONT_RESOURCE_ORIGIN = "https://cc-gui-font.local";

    private static final String FONT_RESOURCE_HOST = "cc-gui-font.local";
    private static final ConcurrentMap<String, FontResource> FONT_RESOURCES = new ConcurrentHashMap<>();

    private UiFontResourceService() {
    }

    public static FontResource registerFontFile(File fontFile) throws IOException {
        File canonicalFile = fontFile.getCanonicalFile();
        long length = canonicalFile.length();
        long lastModified = canonicalFile.lastModified();
        String canonicalPath = canonicalFile.getPath();
        String extension = extensionForPath(canonicalPath);
        String token = tokenFor(canonicalPath, lastModified, length);
        String version = lastModified + "-" + length;
        String url = FONT_RESOURCE_ORIGIN + "/" + token + extension + "?v=" + version;
        FontResource resource = new FontResource(
                canonicalFile.toPath(),
                length,
                lastModified,
                mimeTypeForExtension(extension),
                fontFormatForExtension(extension),
                url
        );
        FONT_RESOURCES.put(token, resource);
        return resource;
    }

    public static boolean isUiFontUrl(String url) {
        URI uri = parseUri(url);
        return uri != null
                && "https".equalsIgnoreCase(uri.getScheme())
                && FONT_RESOURCE_HOST.equalsIgnoreCase(uri.getHost());
    }

    public static FontResource resolveFontUrl(String url) {
        if (!isUiFontUrl(url)) {
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
        FontResource resource = FONT_RESOURCES.get(token);
        if (resource == null || !resource.isCurrent()) {
            FONT_RESOURCES.remove(token);
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
        return lowerPath.endsWith(".otf") ? ".otf" : ".ttf";
    }

    private static String mimeTypeForExtension(String extension) {
        return ".otf".equals(extension) ? "font/opentype" : "font/truetype";
    }

    private static String fontFormatForExtension(String extension) {
        return ".otf".equals(extension) ? "opentype" : "truetype";
    }

    public record FontResource(
            Path path,
            long length,
            long lastModified,
            String mimeType,
            String fontFormat,
            String url
    ) {
        boolean isCurrent() {
            File file = path.toFile();
            // Tolerate up to 2s of mtime drift to absorb cross-FS precision differences
            // (e.g., FAT/exFAT 2s granularity, network filesystem rounding).
            return file.isFile()
                    && file.canRead()
                    && file.length() == length
                    && Math.abs(file.lastModified() - lastModified) < 2000L;
        }
    }
}
