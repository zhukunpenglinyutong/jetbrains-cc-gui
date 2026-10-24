package com.github.claudecodegui.storage;

import com.sun.jna.Library;
import com.sun.jna.Native;
import com.sun.jna.Platform;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Map;

/** Matches Rust's native file locks: LockFileEx on Windows, flock on Linux/macOS. */
final class CodexStorageFileLock implements AutoCloseable {
    private final FileChannel channel;
    private final FileLock lock;
    private final int descriptor;
    private boolean closed;

    private CodexStorageFileLock(FileChannel channel, FileLock lock, int descriptor) {
        this.channel = channel;
        this.lock = lock;
        this.descriptor = descriptor;
    }

    private interface Posix extends Library {
        Posix INSTANCE = Native.load(Platform.C_LIBRARY_NAME, Posix.class,
                Map.of(Library.OPTION_STRING_ENCODING, "UTF-8"));
        // The creation mode uses the variadic ABI, which differs on macOS ARM64.
        int open(String path, int flags, Object... mode);
        int flock(int descriptor, int operation);
        int close(int descriptor);
    }

    /** Returns null on contention, without waiting for or interrupting a native writer. */
    static CodexStorageFileLock tryAcquire(CodexStoragePaths paths, Path file, boolean create) throws IOException {
        paths.revalidate();
        Path normalized = file.toAbsolutePath().normalize();
        if (!normalized.startsWith(paths.root()) || !normalized.getParent().toRealPath().equals(normalized.getParent())) {
            throw new IOException("UNSAFE_STORAGE_PATH");
        }
        if (Files.exists(normalized, LinkOption.NOFOLLOW_LINKS)) {
            paths.existingFile(normalized);
        } else if (!create) {
            throw new NoSuchFileException(normalized.toString());
        }
        if (Platform.isWindows()) {
            FileChannel channel = create
                    ? FileChannel.open(normalized, StandardOpenOption.CREATE, StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)
                    : FileChannel.open(normalized, StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
            boolean retained = false;
            try {
                FileLock lock = channel.tryLock();
                if (lock == null) {
                    return null;
                }
                retained = true;
                return new CodexStorageFileLock(channel, lock, -1);
            } catch (OverlappingFileLockException error) {
                return null;
            } finally {
                if (!retained) {
                    channel.close();
                }
            }
        }
        if (!Platform.isLinux() && !Platform.isMac()) {
            throw new IOException("MAINTENANCE_PLATFORM_UNSUPPORTED");
        }
        try {
            return tryAcquirePosix(paths, normalized, create);
        } catch (LinkageError error) {
            throw new IOException("MAINTENANCE_PLATFORM_UNSUPPORTED", error);
        }
    }

    private static CodexStorageFileLock tryAcquirePosix(CodexStoragePaths paths, Path file, boolean create) throws IOException {
        // O_RDWR | O_NOFOLLOW | O_CLOEXEC; creation uses owner-only permissions.
        int flags = 2 | (Platform.isMac() ? 0x100 | 0x1000000 : 0x20000 | 0x80000);
        if (create) {
            flags |= Platform.isMac() ? 0x200 : 0x40;
        }
        int descriptor = Posix.INSTANCE.open(file.toString(), flags, 0600);
        if (descriptor < 0) {
            if (Native.getLastError() == 2) {
                throw new NoSuchFileException(file.toString());
            }
            throw new IOException("NATIVE_WRITER_LOCK_FAILED");
        }
        boolean retained = false;
        try {
            if (Posix.INSTANCE.flock(descriptor, 2 | 4) != 0) { // LOCK_EX | LOCK_NB
                int error = Native.getLastError();
                if (error == (Platform.isMac() ? 35 : 11)) { // EWOULDBLOCK
                    return null;
                }
                throw new IOException("NATIVE_WRITER_LOCK_FAILED");
            }
            paths.existingFile(file);
            paths.revalidate();
            retained = true;
            return new CodexStorageFileLock(null, null, descriptor);
        } finally {
            if (!retained) {
                Posix.INSTANCE.close(descriptor);
            }
        }
    }

    @Override
    public void close() throws IOException {
        if (closed) {
            return;
        }
        closed = true;
        if (channel != null) {
            try {
                lock.close();
            } finally {
                channel.close();
            }
        } else if (Posix.INSTANCE.close(descriptor) != 0) {
            // Closing the descriptor releases flock, including on abnormal process exit.
            throw new IOException("NATIVE_WRITER_LOCK_FAILED");
        }
    }
}
