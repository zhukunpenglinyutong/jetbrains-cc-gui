package com.github.claudecodegui.storage;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/** Uses Codex's native writer/publication lock namespace, in addition to IDE admission and SQLite locks. */
final class CodexStorageWriterLease implements AutoCloseable {
    private final List<CodexStorageFileLock> locks = new ArrayList<>();

    static CodexStorageWriterLease acquire(CodexStoragePaths paths) throws IOException {
        return acquire(paths, true);
    }

    static CodexStorageWriterLease acquireForHistoryDeletion(CodexStoragePaths paths) throws IOException {
        return acquire(paths, false);
    }

    private static CodexStorageWriterLease acquire(CodexStoragePaths paths, boolean requireAllIdle) throws IOException {
        CodexStorageWriterLease lease = new CodexStorageWriterLease();
        try {
            paths.revalidate();
            Path temporary = lease.directory(paths, ".tmp");
            lease.lock(paths, temporary.resolve("rollout-maintenance.lock"), true);
            Path writers = lease.directory(paths, "thread-writer-locks");
            lease.lock(paths, writers.resolve(".coordination.lock"), true);
            // Coordination excludes new writers and publication until all source work is finished.
            // Full maintenance requires every writer to be idle. History deletion checks its resolved family below.
            if (requireAllIdle) {
                try (var files = Files.list(writers)) {
                    for (Path file : files.filter(path -> !path.getFileName().toString().equals(".coordination.lock")
                            && path.getFileName().toString().endsWith(".lock")).sorted().toList()) {
                        if (active(paths, file)) {
                            throw new IOException("DATABASE_BUSY");
                        }
                    }
                }
            }
            return lease;
        } catch (IOException | RuntimeException error) {
            try {
                lease.close();
            } catch (IOException closeError) {
                error.addSuppressed(closeError);
            }
            throw error;
        }
    }

    void requireIdleSessions(CodexStoragePaths paths, Collection<String> ids) throws IOException {
        // Coordination remains held, so a new writer cannot enter between this check and deletion.
        for (String id : ids) {
            CodexStoragePaths.requireSessionId(id);
            if (active(paths, paths.root().resolve("thread-writer-locks").resolve(id + ".lock"))) {
                throw new IOException("SESSION_WRITER_BUSY");
            }
        }
    }

    private Path directory(CodexStoragePaths paths, String name) throws IOException {
        Path directory = paths.root().resolve(name);
        Files.createDirectories(directory);
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS) || !directory.toRealPath().equals(directory)) {
            throw new IOException("UNSAFE_STORAGE_PATH");
        }
        return directory;
    }

    static java.util.Set<String> occupiedSessions(CodexStoragePaths paths) throws IOException {
        var result = new java.util.LinkedHashSet<String>();
        Path directory = paths.root().resolve("thread-writer-locks");
        if (!Files.exists(directory, LinkOption.NOFOLLOW_LINKS)) {
            return result;
        }
        if (!directory.toRealPath().equals(directory)) {
            throw new IOException("UNSAFE_STORAGE_PATH");
        }
        try (var files = Files.list(directory)) {
            for (Path file : files.filter(path -> !path.getFileName().toString().equals(".coordination.lock")
                    && path.getFileName().toString().endsWith(".lock")).toList()) {
                if (active(paths, file)) {
                    String name = file.getFileName().toString();
                    String id = name.substring(0, name.length() - ".lock".length());
                    CodexStoragePaths.requireSessionId(id);
                    result.add(id);
                }
            }
        }
        return result;
    }

    /** Observes existing lock files without creating native directories or retaining writer ownership. */
    static String maintenanceUnavailableReason(CodexStoragePaths paths) throws IOException {
        String publication = deletionUnavailableReason(paths);
        return publication == null && !occupiedSessions(paths).isEmpty() ? "SESSION_WRITER_BUSY" : publication;
    }

    /** A writer for another thread does not prevent selected-session deletion. */
    static String deletionUnavailableReason(CodexStoragePaths paths) throws IOException {
        paths.revalidate();
        for (String name : List.of(".tmp/rollout-maintenance.lock", "thread-writer-locks/.coordination.lock")) {
            Path file = paths.root().resolve(name);
            if (Files.exists(file, LinkOption.NOFOLLOW_LINKS) && active(paths, file)) {
                return "DATABASE_BUSY";
            }
        }
        return null;
    }

    private static boolean active(CodexStoragePaths paths, Path file) throws IOException {
        try (CodexStorageFileLock lock = CodexStorageFileLock.tryAcquire(paths, file, false)) {
            return lock == null;
        } catch (java.nio.file.NoSuchFileException ignored) {
            return false;
        }
    }

    private void lock(CodexStoragePaths paths, Path file, boolean create) throws IOException {
        CodexStorageFileLock lock = CodexStorageFileLock.tryAcquire(paths, file, create);
        if (lock == null) {
            throw new IOException("DATABASE_BUSY");
        }
        locks.add(lock);
    }

    @Override
    public void close() throws IOException {
        IOException failure = null;
        for (int i = locks.size() - 1; i >= 0; i--) {
            try {
                locks.get(i).close();
            } catch (IOException error) {
                failure = error;
            }
        }
        if (failure != null) {
            throw failure;
        }
    }
}
