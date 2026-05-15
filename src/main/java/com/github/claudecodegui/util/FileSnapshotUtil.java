package com.github.claudecodegui.util;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

/**
 * Conservative project text snapshot utilities for sub-agent edit scopes.
 */
public final class FileSnapshotUtil {

    private static final long MAX_FILE_BYTES = 1024 * 1024;
    private static final long MAX_TOTAL_BYTES = 32L * 1024L * 1024L;
    private static final int MAX_FILES = 5000;

    private FileSnapshotUtil() {
    }

    public static Map<String, FileSnapshot> captureProjectSnapshot(Project project) {
        if (project == null || project.getBasePath() == null) {
            return Map.of();
        }
        return captureDirectorySnapshot(Path.of(project.getBasePath()));
    }

    public static Map<String, FileSnapshot> captureDirectorySnapshot(Path root) {
        if (root == null || !Files.isDirectory(root)) {
            return Map.of();
        }
        Map<String, FileSnapshot> snapshots = new HashMap<>();
        try {
            Path realRoot = root.toRealPath().normalize();
            AtomicLong totalBytes = new AtomicLong();
            try (Stream<Path> stream = Files.walk(realRoot)) {
                stream
                        .filter(path -> !Files.isSymbolicLink(path))
                        .filter(path -> Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
                        .filter(path -> isWithin(realRoot, path))
                        .filter(path -> !isExcluded(realRoot, path))
                        .limit(MAX_FILES)
                        .forEach(path -> readSnapshot(realRoot, path).ifPresent(snapshot -> {
                            if (totalBytes.get() + snapshot.length() <= MAX_TOTAL_BYTES) {
                                snapshots.put(snapshot.path(), snapshot);
                                totalBytes.addAndGet(snapshot.length());
                            }
                        }));
            }
        } catch (IOException e) {
            return snapshots;
        }
        return snapshots;
    }

    public static java.util.Optional<FileSnapshot> readSnapshot(Path path) {
        return readSnapshot(null, path);
    }

    private static java.util.Optional<FileSnapshot> readSnapshot(Path root, Path path) {
        try {
            if (path == null || Files.isSymbolicLink(path) || !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                return java.util.Optional.empty();
            }
            Path realPath = path.toRealPath(LinkOption.NOFOLLOW_LINKS).normalize();
            if (root != null && !isWithin(root, realPath)) {
                return java.util.Optional.empty();
            }
            if (Files.isSymbolicLink(realPath) || !Files.isRegularFile(realPath, LinkOption.NOFOLLOW_LINKS)) {
                return java.util.Optional.empty();
            }
            long length = Files.size(realPath);
            if (length > MAX_FILE_BYTES) {
                return java.util.Optional.empty();
            }
            byte[] bytes;
            try (InputStream inputStream = Files.newInputStream(realPath, LinkOption.NOFOLLOW_LINKS)) {
                bytes = inputStream.readNBytes((int) MAX_FILE_BYTES + 1);
            }
            if (bytes.length > MAX_FILE_BYTES) {
                return java.util.Optional.empty();
            }
            boolean binary = isBinary(bytes);
            Charset charset = resolveCharset(realPath);
            String content = binary ? "" : new String(bytes, charset);
            return java.util.Optional.of(new FileSnapshot(
                    realPath.toAbsolutePath().normalize().toString(),
                    true,
                    binary,
                    content,
                    length,
                    Files.getLastModifiedTime(realPath).toMillis(),
                    sha256(bytes)
            ));
        } catch (IOException e) {
            return java.util.Optional.empty();
        }
    }

    public static FileSnapshot nonExistingSnapshot(String path) {
        String normalizedPath;
        try {
            normalizedPath = Path.of(path).toAbsolutePath().normalize().toString();
        } catch (Exception e) {
            normalizedPath = path;
        }
        return new FileSnapshot(normalizedPath, false, false, "", 0L, 0L, "");
    }

    private static Charset resolveCharset(Path path) {
        try {
            VirtualFile virtualFile = LocalFileSystem.getInstance().findFileByNioFile(path);
            if (virtualFile != null && virtualFile.getCharset() != null) {
                return virtualFile.getCharset();
            }
        } catch (Exception ignored) {
        }
        return StandardCharsets.UTF_8;
    }

    private static boolean isExcluded(Path root, Path path) {
        Path relative;
        try {
            relative = root.relativize(path);
        } catch (IllegalArgumentException e) {
            return true;
        }
        for (Path part : relative) {
            String name = part.toString();
            if (name.equals(".git") || name.equals(".idea") || name.equals("build")
                    || name.equals("out") || name.equals("node_modules") || name.equals("dist")) {
                return true;
            }
        }
        return false;
    }

    private static boolean isWithin(Path root, Path path) {
        try {
            Path normalizedRoot = root.normalize();
            Path normalizedPath = path.toAbsolutePath().normalize();
            return normalizedPath.startsWith(normalizedRoot);
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean isBinary(byte[] bytes) {
        int limit = Math.min(bytes.length, 8192);
        for (int i = 0; i < limit; i++) {
            if (bytes[i] == 0) {
                return true;
            }
        }
        return false;
    }

    private static String sha256(byte[] bytes) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            return Integer.toHexString(java.util.Arrays.hashCode(bytes));
        }
    }

    public record FileSnapshot(
            String path,
            boolean existed,
            boolean binary,
            String content,
            long length,
            long modifiedAtMillis,
            String contentHash
    ) {
    }
}
