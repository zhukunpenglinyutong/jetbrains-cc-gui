package com.github.claudecodegui.handler.history;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Creation of the scratch files the session converters work through.
 *
 * <p>Both converters copy a session into a backup and a temp file next to it, which
 * means full copies of the user's prompts end up in those files. They are created
 * through this helper so that no caller can accidentally get the default-permission
 * variant.
 */
final class SessionTempFiles {

    /**
     * {@code rw-------}. The converters are the only readers of these files, and the
     * data inside is the entire session transcript.
     */
    private static final Set<PosixFilePermission> OWNER_ONLY =
            PosixFilePermissions.fromString("rw-------");

    private static final FileAttribute<?>[] OWNER_ONLY_ATTRIBUTE = {
            PosixFilePermissions.asFileAttribute(OWNER_ONLY)
    };

    private SessionTempFiles() {
    }

    private static final String BACKUP_PREFIX = ".backup.";
    private static final String CONVERT_PREFIX = ".convert.";
    private static final String TMP_SUFFIX = ".tmp";

    /**
     * Remove stale temporary files from a previous crashed run.
     *
     * <p>The worker thread may be killed mid-flight at JVM exit, leaving behind
     * {@code *.backup.*.tmp} and {@code *.convert.*.tmp} files (each up to 64 MB).
     * This method scans the session directory for such files and deletes them
     * before a new conversion run starts.
     *
     * @param sessionDir directory containing session files.
     */
    static void cleanupStaleTempFiles(Path sessionDir) {
        if (!Files.isDirectory(sessionDir)) {
            return;
        }
        try (Stream<Path> files = Files.list(sessionDir)) {
            files.filter(path -> {
                String name = path.getFileName().toString();
                return (name.contains(BACKUP_PREFIX) || name.contains(CONVERT_PREFIX))
                        && name.endsWith(TMP_SUFFIX);
            }).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException e) {
                    // Ignore: best effort cleanup
                }
            });
        } catch (IOException e) {
            // Ignore: best effort cleanup
        }
    }

    /**
     * Create a temp file in {@code directory} that only the current user can read.
     *
     * <p>{@link Files#createTempFile(Path, String, String, FileAttribute[])} without
     * attributes applies the process umask, which is {@code 0644} on a default
     * Linux/macOS shell — unlike {@link java.io.File#createTempFile}, which always
     * forces {@code 0600}. These files hold a verbatim copy of a session, so the
     * looser default is not acceptable.
     *
     * <p>On a filesystem without POSIX permissions (Windows, some network shares) the
     * attribute is rejected with {@link UnsupportedOperationException}. That is a
     * permissions model we cannot express there anyway, so fall back to the plain call
     * instead of failing the whole conversion.
     *
     * @param directory directory to create the file in; must exist.
     * @param prefix file name prefix, at least three characters.
     * @param suffix file name suffix.
     * @return the path of the newly created, empty file.
     * @throws IOException if the file could not be created.
     */
    static Path createPrivateTempFile(Path directory, String prefix, String suffix) throws IOException {
        try {
            return Files.createTempFile(directory, prefix, suffix, OWNER_ONLY_ATTRIBUTE);
        } catch (UnsupportedOperationException e) {
            return Files.createTempFile(directory, prefix, suffix);
        }
    }
}
