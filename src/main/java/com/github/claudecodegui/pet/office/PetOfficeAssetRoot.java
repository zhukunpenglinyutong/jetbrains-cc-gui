package com.github.claudecodegui.pet.office;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Objects;

/** Resolves only the canonical Codex home or its verified migration target. Call while holding a data read permit. */
public final class PetOfficeAssetRoot {
    private static final String STORAGE_MARKER = ".cc-gui-storage";

    private PetOfficeAssetRoot() { }

    public static Path resolvePets(Path userHome) throws IOException {
        Path home = userHome.toAbsolutePath().normalize();
        requirePlainDirectories(home);
        Path canonical = home.resolve(".codex");
        BasicFileAttributes before = attributes(canonical);
        Path physical = canonical.toRealPath();
        requirePlainDirectories(physical);
        if (!canonical.equals(physical)) {
            if (physical.getFileName() == null || !".codex".equals(physical.getFileName().toString()) || !validMarker(physical)) {
                throw new IOException("ASSET_ROOT_UNVERIFIED");
            }
        }
        BasicFileAttributes after = attributes(canonical);
        if (!Objects.equals(before.fileKey(), after.fileKey()) || !before.creationTime().equals(after.creationTime())
                || before.isSymbolicLink() != after.isSymbolicLink() || before.isOther() != after.isOther()
                || !physical.equals(canonical.toRealPath()) || !Files.isSameFile(canonical, physical)) {
            throw new IOException("ASSET_ROOT_CHANGED");
        }
        return physical.resolve("pets");
    }

    private static void requirePlainDirectories(Path path) throws IOException {
        Path current = path.getRoot();
        for (Path part : path) {
            current = current.resolve(part);
            BasicFileAttributes attributes = attributes(current);
            if (!attributes.isDirectory() || attributes.isSymbolicLink() || attributes.isOther()) {
                throw new IOException("ASSET_ROOT_UNVERIFIED");
            }
        }
        if (!path.equals(path.toRealPath())) {
            throw new IOException("ASSET_ROOT_UNVERIFIED");
        }
    }

    private static boolean validMarker(Path physical) throws IOException {
        Path marker = physical.resolve(STORAGE_MARKER);
        BasicFileAttributes before = attributes(marker);
        if (!before.isRegularFile() || before.isSymbolicLink() || before.isOther() || before.size() <= 0 || before.size() > 32) {
            return false;
        }
        byte[] bytes;
        try (InputStream input = Files.newInputStream(marker, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            bytes = input.readNBytes(33);
        }
        BasicFileAttributes after = attributes(marker);
        return bytes.length == before.size() && bytes.length <= 32
                && Objects.equals(before.fileKey(), after.fileKey()) && before.creationTime().equals(after.creationTime())
                && before.lastModifiedTime().equals(after.lastModifiedTime()) && before.size() == after.size()
                && after.isRegularFile() && !after.isSymbolicLink() && !after.isOther()
                && "codex".equals(new String(bytes, StandardCharsets.UTF_8).trim());
    }

    private static BasicFileAttributes attributes(Path path) throws IOException {
        return Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
    }
}
