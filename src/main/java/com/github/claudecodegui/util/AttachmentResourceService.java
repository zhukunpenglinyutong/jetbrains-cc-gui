package com.github.claudecodegui.util;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Registers persisted attachment files behind opaque JCEF-served URLs.
 */
public final class AttachmentResourceService {

    public static final String ATTACHMENT_RESOURCE_ORIGIN = "https://cc-gui-attachment.local";

    private static final String ATTACHMENT_RESOURCE_HOST = "cc-gui-attachment.local";

    /**
     * Bounded LRU registry of attachment resources. Capped so that a long-running
     * session that registers many attachments cannot grow this map without bound
     * (PR #1191 review H3). Older entries are evicted when capacity is exceeded;
     * the underlying files keep existing on disk and can be re-registered if
     * referenced again.
     */
    private static final int MAX_REGISTERED_RESOURCES = 1024;
    private static final Map<String, AttachmentResource> ATTACHMENT_RESOURCES =
            Collections.synchronizedMap(new LinkedHashMap<String, AttachmentResource>(64, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, AttachmentResource> eldest) {
                    return size() > MAX_REGISTERED_RESOURCES;
                }
            });

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
        String pathHint = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(canonicalPath.getBytes(StandardCharsets.UTF_8));
        String url = ATTACHMENT_RESOURCE_ORIGIN + "/" + token + extension + "?v=" + version + "&p=" + pathHint;
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
            resource = rebuildResourceFromUrl(token, fileName, uri.getRawQuery());
            if (resource == null) {
                return null;
            }
        }

        return resource;
    }

    private static AttachmentResource rebuildResourceFromUrl(String token, String fileName, String rawQuery) {
        try {
            Path hintedPath = pathHintFromQuery(rawQuery);
            if (matchesToken(hintedPath, token)) {
                return registerAttachmentFile(hintedPath.toFile(), null);
            }

            Path storeDir = AttachmentStorageService.getInstance().getStoreDir();
            if (storeDir == null || !Files.isDirectory(storeDir)) {
                return null;
            }

            Path candidate = storeDir.resolve(fileName);
            if (matchesToken(candidate, token)) {
                return registerAttachmentFile(candidate.toFile(), null);
            }

            try (Stream<Path> stream = Files.list(storeDir)) {
                Path matched = stream
                        .filter(Files::isRegularFile)
                        .filter(path -> matchesToken(path, token))
                        .findFirst()
                        .orElse(null);
                if (matched == null) {
                    return null;
                }
                return registerAttachmentFile(matched.toFile(), null);
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private static Path pathHintFromQuery(String rawQuery) {
        if (rawQuery == null || rawQuery.isBlank()) {
            return null;
        }
        String[] pairs = rawQuery.split("&");
        for (String pair : pairs) {
            int separator = pair.indexOf('=');
            String key = separator >= 0 ? pair.substring(0, separator) : pair;
            if (!"p".equals(key)) {
                continue;
            }
            String encodedPath = separator >= 0 ? pair.substring(separator + 1) : "";
            if (encodedPath.isBlank()) {
                return null;
            }
            try {
                byte[] decoded = Base64.getUrlDecoder().decode(encodedPath);
                return Path.of(new String(decoded, StandardCharsets.UTF_8));
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
        return null;
    }

    private static boolean matchesToken(Path candidate, String token) {
        if (candidate == null || token == null || token.isBlank()) {
            return false;
        }
        try {
            File canonicalFile = candidate.toFile().getCanonicalFile();
            if (!canonicalFile.isFile()) {
                return false;
            }
            String canonicalPath = canonicalFile.getPath();
            long lastModified = canonicalFile.lastModified();
            long length = canonicalFile.length();
            return token.equals(tokenFor(canonicalPath, lastModified, length));
        } catch (IOException e) {
            return false;
        }
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
