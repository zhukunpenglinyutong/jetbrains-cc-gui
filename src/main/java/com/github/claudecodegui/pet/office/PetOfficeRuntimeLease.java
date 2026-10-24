package com.github.claudecodegui.pet.office;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.Optional;

/** Non-blocking ownership primitive. The caller verifies the runtime root ACL. */
public final class PetOfficeRuntimeLease implements AutoCloseable {
    private final FileChannel channel;
    private final FileLock lock;

    private PetOfficeRuntimeLease(FileChannel channel, FileLock lock) {
        this.channel = channel;
        this.lock = lock;
    }

    public static Optional<PetOfficeRuntimeLease> tryAcquire(Path directory) throws IOException {
        BasicFileAttributes attributes = Files.readAttributes(directory, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!attributes.isDirectory() || attributes.isSymbolicLink() || attributes.isOther()) {
            throw new IOException("OFFICE_RUNTIME_DIRECTORY_INVALID");
        }
        Path path = directory.resolve("runtime.lock");
        if (Files.exists(path, LinkOption.NOFOLLOW_LINKS) && !Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("OFFICE_LOCK_INVALID");
        }
        FileChannel channel = FileChannel.open(path, StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        try {
            FileLock lock = channel.tryLock();
            if (lock == null) {
                channel.close();
                return Optional.empty();
            }
            return Optional.of(new PetOfficeRuntimeLease(channel, lock));
        } catch (OverlappingFileLockException occupied) {
            channel.close();
            return Optional.empty();
        } catch (IOException | RuntimeException failure) {
            channel.close();
            throw failure;
        }
    }

    public boolean isValid() {
        return lock.isValid() && channel.isOpen();
    }

    @Override
    public synchronized void close() throws IOException {
        try {
            if (lock.isValid()) {
                lock.release();
            }
        } finally {
            channel.close();
        }
    }
}
