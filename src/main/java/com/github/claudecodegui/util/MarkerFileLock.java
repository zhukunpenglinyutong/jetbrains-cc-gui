package com.github.claudecodegui.util;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.UUID;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Cross-process lock for filesystem providers without file locks, such as JetBrains' IJent
 * filesystem for WSL paths: a {@code <file>.held} marker created with create-new semantics.
 *
 * <p>The holder rewrites its marker while it works, so only the marker of a process that stopped
 * doing so is treated as abandoned. Ages are measured on the filesystem's own clock, because a
 * WSL distribution can drift from the IDE host. A holder suspended for longer than the abandoned
 * age (for example by system sleep) can lose the lock. The marker does not exclude processes that
 * hold an OS lock on the file itself.
 */
public final class MarkerFileLock implements AutoCloseable {

    private static final Logger LOG = Logger.getInstance(MarkerFileLock.class);
    private static final String MARKER_SUFFIX = ".held";
    private static final String REMOVAL_GUARD_SUFFIX = ".break";
    private static final long RETRY_DELAY_MS = 50;
    private static final long ABANDONED_MARKER_MS = 30_000;
    private static final long REFRESH_MS = 5_000;

    private final Path marker;
    private final String owner;

    private ScheduledFuture<?> refresh;
    private boolean closed;

    private MarkerFileLock(Path marker, String owner) {
        this.marker = marker;
        this.owner = owner;
    }

    /** Returns the held lock, or null when another holder keeps it until the timeout. */
    public static MarkerFileLock acquire(Path lockFile, long timeoutMs) throws IOException {
        return acquire(lockFile, timeoutMs, ABANDONED_MARKER_MS, REFRESH_MS);
    }

    static MarkerFileLock acquire(Path lockFile, long timeoutMs, long abandonedMs, long refreshMs) throws IOException {
        Path marker = markerOf(lockFile);
        long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
        for (;;) {
            try {
                Files.createFile(marker);
                break;
            } catch (IOException held) {
                if (removeIfAbandoned(marker, abandonedMs)) {
                    continue;
                }
                if (System.nanoTime() >= deadline) {
                    return null;
                }
                try {
                    Thread.sleep(RETRY_DELAY_MS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted while waiting for the lock " + marker, e);
                }
            }
        }
        String owner = UUID.randomUUID().toString();
        try {
            Files.writeString(marker, owner, StandardCharsets.UTF_8);
        } catch (IOException e) {
            deleteQuietly(marker);
            throw e;
        }
        MarkerFileLock lock = new MarkerFileLock(marker, owner);
        lock.refresh = AppExecutorUtil.getAppScheduledExecutorService()
                .scheduleWithFixedDelay(lock::refreshMarker, refreshMs, refreshMs, TimeUnit.MILLISECONDS);
        return lock;
    }

    private synchronized void refreshMarker() {
        if (closed) {
            return;
        }
        try {
            if (owner.equals(Files.readString(marker, StandardCharsets.UTF_8))) {
                Files.writeString(marker, owner, StandardCharsets.UTF_8,
                        StandardOpenOption.WRITE, StandardOpenOption.TRUNCATE_EXISTING);
            }
        } catch (IOException e) {
            LOG.debug("[MarkerFileLock] Could not refresh the lock marker " + marker + ": " + e.getMessage());
        }
    }

    public static Path markerOf(Path lockFile) {
        return lockFile.resolveSibling(lockFile.getFileName() + MARKER_SUFFIX);
    }

    /**
     * Only the process that creates the removal guard may delete a marker, and it checks the age
     * again under the guard. Without it, a slower waiter could delete the marker a faster one had
     * just created, leaving two holders. A guard left by a crash is never removed automatically.
     */
    private static boolean removeIfAbandoned(Path marker, long abandonedMs) {
        if (!isAbandoned(marker, abandonedMs)) {
            return false;
        }
        Path guard = marker.resolveSibling(marker.getFileName() + REMOVAL_GUARD_SUFFIX);
        try {
            Files.createFile(guard);
        } catch (IOException busy) {
            if (isAbandoned(guard, abandonedMs)) {
                LOG.warn("[MarkerFileLock] Delete " + guard + " by hand: it blocks removal of " + marker);
            }
            return false;
        }
        try {
            if (isAbandoned(marker, abandonedMs) && Files.deleteIfExists(marker)) {
                LOG.warn("[MarkerFileLock] Removed the abandoned lock marker " + marker);
                return true;
            }
        } catch (IOException e) {
            LOG.debug("[MarkerFileLock] Could not remove " + marker + ": " + e.getMessage());
        } finally {
            deleteQuietly(guard);
        }
        return false;
    }

    private static boolean isAbandoned(Path file, long abandonedMs) {
        try {
            Path probe = Files.createTempFile(file.toAbsolutePath().getParent(),
                    file.getFileName().toString(), ".tmp");
            try {
                return Files.getLastModifiedTime(probe).toMillis()
                        - Files.getLastModifiedTime(file).toMillis() > abandonedMs;
            } finally {
                deleteQuietly(probe);
            }
        } catch (IOException e) {
            LOG.debug("[MarkerFileLock] Could not check the age of " + file + ": " + e.getMessage());
            return false;
        }
    }

    private static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            LOG.debug("[MarkerFileLock] Could not delete " + path + ": " + e.getMessage());
        }
    }

    /** Best effort: the guarded section already ran, so a failed release must not report it as failed. */
    @Override
    public synchronized void close() {
        closed = true;
        refresh.cancel(false);
        try {
            if (owner.equals(Files.readString(marker, StandardCharsets.UTF_8))) {
                Files.delete(marker);
            }
        } catch (IOException e) {
            LOG.warn("[MarkerFileLock] Could not release the lock marker " + marker + ": " + e.getMessage());
        }
    }
}
