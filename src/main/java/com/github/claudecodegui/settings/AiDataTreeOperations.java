package com.github.claudecodegui.settings;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.FileVisitOption;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.DosFileAttributeView;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import com.github.claudecodegui.settings.AiDataDirectoryManager.AiDataDirectoryException;
import com.github.claudecodegui.settings.AiDataDirectoryManager.ManifestEntry;
import com.github.claudecodegui.settings.AiDataDirectoryManager.CancellationChecker;
import com.github.claudecodegui.settings.AiDataDirectoryManager.DirectoryLinkCreator;
import com.github.claudecodegui.settings.AiDataDirectoryManager.PathDeleter;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.STORAGE_MARKER;
import static com.github.claudecodegui.settings.AiDataDirectoryManager.NO_CANCELLATION;
import static com.github.claudecodegui.settings.AiDataDirectoryLinks.isDirectDirectoryLink;
import static com.github.claudecodegui.settings.AiDataDirectoryLinks.deleteDirectoryLink;

/** Copies data, verifies manifests and deletes owned trees while preserving link boundaries. */
final class AiDataTreeOperations {

    private AiDataTreeOperations() { }

    static Map<Path, Path> copyDirectory(
            Path source, Path target, CancellationChecker cancellationChecker, DirectoryLinkCreator linkCreator) throws IOException {
        Map<Path, Path> directoryLinks = new LinkedHashMap<>();
        Map<Path, Path> internalDirectoryLinks = new LinkedHashMap<>();
        Files.walkFileTree(source, EnumSet.noneOf(FileVisitOption.class), Integer.MAX_VALUE,
                new SimpleFileVisitor<>() {
                    @Override
                    public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes)
                            throws IOException {
                        cancellationChecker.check();
                        if (!directory.equals(source)) {
                            Path destination = target.resolve(source.relativize(directory));
                            if (isDirectDirectoryLink(directory)) {
                                Path resolved = directory.toRealPath();
                                directoryLinks.put(destination, relocatedLinkTarget(source, target, resolved));
                                rememberInternalDirectoryLink(
                                        source, target, destination, resolved, internalDirectoryLinks);
                                return FileVisitResult.SKIP_SUBTREE;
                            }
                            if (attributes.isOther()) {
                                throw new AiDataDirectoryException("UNSUPPORTED_SOURCE_ENTRY");
                            }
                            Files.createDirectory(destination);
                        }
                        return FileVisitResult.CONTINUE;
                    }

                    @Override
                    public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                        cancellationChecker.check();
                        Path destination = target.resolve(source.relativize(file));
                        if (attributes.isSymbolicLink()) {
                            Files.createSymbolicLink(destination,
                                    relocatedSymbolicLinkTarget(source, target, file, destination));
                        } else if (isDirectDirectoryLink(file)) {
                            Path resolved = file.toRealPath();
                            directoryLinks.put(destination, relocatedLinkTarget(source, target, resolved));
                            rememberInternalDirectoryLink(
                                    source, target, destination, resolved, internalDirectoryLinks);
                        } else if (attributes.isRegularFile()) {
                            Files.copy(file, destination, StandardCopyOption.COPY_ATTRIBUTES);
                        } else {
                            throw new AiDataDirectoryException("UNSUPPORTED_SOURCE_ENTRY");
                        }
                        cancellationChecker.check();
                        return FileVisitResult.CONTINUE;
                    }
                });
        for (Map.Entry<Path, Path> link : directoryLinks.entrySet()) {
            cancellationChecker.check();
            linkCreator.create(link.getKey(), link.getValue());
        }
        return internalDirectoryLinks;
    }

    private static void rememberInternalDirectoryLink(
            Path source, Path target, Path destination, Path resolved,
            Map<Path, Path> internalDirectoryLinks) {
        if (resolved.startsWith(source)) {
            internalDirectoryLinks.put(target.relativize(destination), source.relativize(resolved));
        }
    }

    private static Path relocatedSymbolicLinkTarget(Path source, Path target, Path link, Path destination)
            throws IOException {
        Path resolved = resolveSymbolicLink(link);
        if (!resolved.startsWith(source)) {
            return resolved;
        }
        Path relocated = target.resolve(source.relativize(resolved)).normalize();
        return destination.getParent().relativize(relocated);
    }

    private static Path resolveSymbolicLink(Path link) throws IOException {
        Path configured = Files.readSymbolicLink(link);
        if (configured.isAbsolute()) {
            return configured.normalize();
        }
        return link.getParent().resolve(configured).toAbsolutePath().normalize();
    }

    private static Path relocatedLinkTarget(Path source, Path target, Path resolved) {
        return resolved.startsWith(source)
                ? target.resolve(source.relativize(resolved)).normalize()
                : resolved;
    }

    static Map<String, ManifestEntry> buildManifest(Path root) throws IOException {
        return buildManifest(root, null, null, NO_CANCELLATION);
    }

    private static Map<String, ManifestEntry> buildManifest(
            Path root, Path originalRoot, Path relocatedRoot, CancellationChecker cancellationChecker)
            throws IOException {
        Map<String, ManifestEntry> result = new LinkedHashMap<>();
        Files.walkFileTree(root, EnumSet.noneOf(FileVisitOption.class), Integer.MAX_VALUE,
                new SimpleFileVisitor<>() {
                    @Override
                    public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes)
                            throws IOException {
                        cancellationChecker.check();
                        if (directory.equals(root)) {
                            return FileVisitResult.CONTINUE;
                        }
                        String relative = manifestPath(root, directory);
                        if (isDirectDirectoryLink(directory)) {
                            Path resolved = relocatedManifestTarget(
                                    directory.toRealPath(), root, originalRoot, relocatedRoot);
                            result.put(relative, new ManifestEntry(
                                    "directory-link", 0L,
                                    linkFingerprint(root, resolved)));
                            return FileVisitResult.SKIP_SUBTREE;
                        }
                        if (attributes.isOther()) {
                            throw new AiDataDirectoryException("UNSUPPORTED_SOURCE_ENTRY");
                        }
                        result.put(relative, new ManifestEntry("directory", 0L, ""));
                        return FileVisitResult.CONTINUE;
                    }

                    @Override
                    public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                        cancellationChecker.check();
                        String relative = manifestPath(root, file);
                        if (attributes.isSymbolicLink()) {
                            Path resolved = relocatedManifestTarget(
                                    resolveSymbolicLink(file), root, originalRoot, relocatedRoot);
                            result.put(relative, new ManifestEntry(
                                    "link", 0L, linkFingerprint(root, resolved)));
                        } else if (isDirectDirectoryLink(file)) {
                            Path resolved = relocatedManifestTarget(
                                    file.toRealPath(), root, originalRoot, relocatedRoot);
                            result.put(relative, new ManifestEntry(
                                    "directory-link", 0L,
                                    linkFingerprint(root, resolved)));
                        } else if (attributes.isRegularFile()) {
                            result.put(relative, new ManifestEntry(
                                    "file", attributes.size(), sha256(file, cancellationChecker)));
                        } else {
                            throw new AiDataDirectoryException("UNSUPPORTED_SOURCE_ENTRY");
                        }
                        cancellationChecker.check();
                        return FileVisitResult.CONTINUE;
                    }
                });
        return result;
    }

    static Map<String, ManifestEntry> buildDataManifest(Path root) throws IOException {
        return buildDataManifest(root, NO_CANCELLATION);
    }

    static Map<String, ManifestEntry> buildDataManifest(
            Path root, CancellationChecker cancellationChecker) throws IOException {
        Map<String, ManifestEntry> result = buildManifest(root, null, null, cancellationChecker);
        result.remove(STORAGE_MARKER);
        return result;
    }

    static Map<String, ManifestEntry> buildDataManifest(
            Path root, Path originalRoot, Path relocatedRoot) throws IOException {
        return buildDataManifest(root, originalRoot, relocatedRoot, NO_CANCELLATION);
    }

    static Map<String, ManifestEntry> buildDataManifest(
            Path root, Path originalRoot, Path relocatedRoot,
            CancellationChecker cancellationChecker) throws IOException {
        Map<String, ManifestEntry> result = buildManifest(root, originalRoot, relocatedRoot, cancellationChecker);
        result.remove(STORAGE_MARKER);
        return result;
    }

    private static Path relocatedManifestTarget(
            Path resolved, Path root, Path originalRoot, Path relocatedRoot) {
        Path normalized = resolved.toAbsolutePath().normalize();
        if (relocatedRoot != null && normalized.startsWith(relocatedRoot)) {
            return root.resolve(relocatedRoot.relativize(normalized)).normalize();
        }
        if (originalRoot != null && normalized.startsWith(originalRoot)) {
            return root.resolve(originalRoot.relativize(normalized)).normalize();
        }
        return normalized;
    }

    private static String linkFingerprint(Path root, Path resolvedTarget) {
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Path normalizedTarget = resolvedTarget.toAbsolutePath().normalize();
        if (normalizedTarget.startsWith(normalizedRoot)) {
            return "internal:" + manifestPath(normalizedRoot, normalizedTarget);
        }
        return "external:" + normalizedTarget;
    }

    private static String manifestPath(Path root, Path path) {
        return root.relativize(path).toString().replace('\\', '/');
    }

    private static String sha256(Path path, CancellationChecker cancellationChecker) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream input = Files.newInputStream(path)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    cancellationChecker.check();
                    digest.update(buffer, 0, read);
                }
            }
            cancellationChecker.check();
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    static void deleteTree(Path root) throws IOException {
        deleteTree(root, AiDataTreeOperations::deleteWritablePath);
    }

    static void deleteTree(Path root, PathDeleter pathDeleter) throws IOException {
        if (!Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (isDirectDirectoryLink(root)) {
            deleteDirectoryLink(root);
            return;
        }
        Path storageMarker = root.resolve(STORAGE_MARKER);
        byte[] storageMarkerContent = Files.isRegularFile(storageMarker, LinkOption.NOFOLLOW_LINKS)
                && !Files.isSymbolicLink(storageMarker) ? Files.readAllBytes(storageMarker) : null;
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path directory, BasicFileAttributes attributes)
                    throws IOException {
                if (!directory.equals(root) && isDirectDirectoryLink(directory)) {
                    deleteDirectoryLink(directory);
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attributes) throws IOException {
                if (!file.equals(storageMarker)) {
                    if (attributes.isSymbolicLink()) {
                        Files.deleteIfExists(file);
                    } else {
                        pathDeleter.delete(file);
                    }
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path directory, IOException error) throws IOException {
                if (error != null) {
                    throw error;
                }
                if (directory.equals(root) && Files.exists(storageMarker, LinkOption.NOFOLLOW_LINKS)) {
                    pathDeleter.delete(storageMarker);
                }
                try {
                    pathDeleter.delete(directory);
                } catch (IOException deleteError) {
                    if (directory.equals(root) && storageMarkerContent != null
                            && Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)
                            && !Files.exists(storageMarker, LinkOption.NOFOLLOW_LINKS)) {
                        try {
                            Files.write(storageMarker, storageMarkerContent, StandardOpenOption.CREATE_NEW);
                        } catch (IOException restoreError) {
                            deleteError.addSuppressed(restoreError);
                        }
                    }
                    throw deleteError;
                }
                return FileVisitResult.CONTINUE;
            }
        });
    }

    static void deleteWritablePath(Path path) throws IOException {
        DosFileAttributeView attributes = Files.getFileAttributeView(
                path, DosFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
        if (attributes != null && attributes.readAttributes().isReadOnly()) {
            attributes.setReadOnly(false);
        }
        Files.delete(path);
    }

    static boolean hasStorageMarker(Path directory, String id) {
        Path marker = directory.resolve(STORAGE_MARKER);
        try {
            return Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS)
                    && !Files.isSymbolicLink(marker)
                    && Files.size(marker) <= 32L
                    && id.equals(Files.readString(marker, StandardCharsets.UTF_8).trim());
        } catch (IOException error) {
            return false;
        }
    }

}
