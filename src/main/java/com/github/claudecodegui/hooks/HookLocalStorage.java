package com.github.claudecodegui.hooks;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** Private per-user hook state; project configuration never contains recovery copies. */
final class HookLocalStorage {

    private static final java.util.Map<Path, java.util.concurrent.Semaphore> LOCAL_LOCKS = new java.util.concurrent.ConcurrentHashMap<>();

    private HookLocalStorage() {
    }

    static Path directory(Path userHome, String kind, Path source) {
        Path identity = source.toAbsolutePath().normalize();
        try {
            identity = identity.toRealPath();
        } catch (IOException ignored) {
            // A missing config still needs a stable bucket for creating its first state entry.
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.toString().getBytes(StandardCharsets.UTF_8));
            return userHome.toAbsolutePath().normalize().resolve(".cc-gui").resolve("hooks")
                    .resolve(kind).resolve(HexFormat.of().formatHex(digest));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    static void prepare(Path userHome, Path directory) throws IOException {
        Path home = userHome.toAbsolutePath().normalize();
        if (!directory.startsWith(home.resolve(".cc-gui").resolve("hooks"))) {
            throw new IOException("Invalid private hook storage path");
        }
        Path current = home;
        for (Path component : home.relativize(directory)) {
            current = current.resolve(component);
            if (!Files.exists(current, LinkOption.NOFOLLOW_LINKS)) {
                try {
                    try {
                        Files.createDirectory(current, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
                    } catch (UnsupportedOperationException ignored) {
                        Files.createDirectory(current);
                    }
                } catch (java.nio.file.FileAlreadyExistsException ignored) {
                    // Another source can initialize the shared parent concurrently.
                }
            }
            BasicFileAttributes attributes = Files.readAttributes(current, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isDirectory() || attributes.isSymbolicLink() || attributes.isOther()) {
                throw new IOException("Private hook storage must not be redirected");
            }
            if (Files.getFileAttributeView(current, PosixFileAttributeView.class) != null) {
                Files.setPosixFilePermissions(current, PosixFilePermissions.fromString("rwx------"));
            }
        }
    }

    static void restrictFile(Path file) throws IOException {
        if (Files.getFileAttributeView(file, PosixFileAttributeView.class) != null) {
            Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-------"));
        }
    }

    /** Local contenders must not open/close an inode already locked by this JVM on POSIX. */
    static SourceLock tryLock(Path file) throws IOException {
        Path identity = file.getParent().toRealPath().resolve(file.getFileName());
        var local = LOCAL_LOCKS.computeIfAbsent(identity, ignored -> new java.util.concurrent.Semaphore(1));
        if (!local.tryAcquire()) {
            return null;
        }
        java.nio.channels.FileChannel channel = null;
        java.nio.channels.FileLock lock = null;
        boolean retained = false;
        try {
            channel = java.nio.channels.FileChannel.open(file, java.nio.file.StandardOpenOption.CREATE,
                    java.nio.file.StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
            try {
                lock = channel.tryLock();
            } catch (java.nio.channels.OverlappingFileLockException error) {
                return null;
            }
            if (lock == null) {
                return null;
            }
            restrictFile(file);
            retained = true;
            return new SourceLock(channel, lock, local);
        } finally {
            if (!retained) {
                try {
                    if (lock != null) {
                        lock.release();
                    }
                } finally {
                    try {
                        if (channel != null) {
                            channel.close();
                        }
                    } finally {
                        local.release();
                    }
                }
            }
        }
    }

    static final class SourceLock implements AutoCloseable {
        private final java.nio.channels.FileChannel channel;
        private final java.nio.channels.FileLock lock;
        private final java.util.concurrent.Semaphore local;
        private final java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();

        private SourceLock(java.nio.channels.FileChannel channel, java.nio.channels.FileLock lock, java.util.concurrent.Semaphore local) {
            this.channel = channel;
            this.lock = lock;
            this.local = local;
        }

        @Override
        public void close() throws IOException {
            if (closed.compareAndSet(false, true)) {
                try {
                    lock.release();
                } finally {
                    try {
                        channel.close();
                    } finally {
                        local.release();
                    }
                }
            }
        }
    }
}
