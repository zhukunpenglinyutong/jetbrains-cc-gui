package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.UUID;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** Provides cross-JVM coordination for AI data migration operations. */
public final class AiDataMigrationCoordinator {

    static final int PROTOCOL_VERSION = 1;
    private static final String LOCK_FILE = "migration.lock";
    private static final String OWNER_FILE = "migration-owner.json";
    private static final String CANCEL_FILE = "migration-cancel.json";
    private static final java.util.logging.Logger LOG = java.util.logging.Logger.getLogger(AiDataMigrationCoordinator.class.getName());
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Map<Path, SharedProcessLock> SHARED_PROCESS_LOCKS = new ConcurrentHashMap<>();

    private final Path coordinationDirectory;

    public AiDataMigrationCoordinator(Path coordinationDirectory) {
        this.coordinationDirectory = coordinationDirectory.toAbsolutePath().normalize();
    }

    public static Path defaultCoordinationDirectory() {
        return Path.of(com.github.claudecodegui.util.PlatformUtils.getHomeDirectory())
                .toAbsolutePath().normalize().resolve(".cc-gui").resolve("ai-data-coordination");
    }

    public LockHandle tryAcquire(String operation) throws IOException {
        prepareDirectory();
        SharedProcessLock shared = lockState();
        synchronized (shared) {
            // On POSIX even closing a failed contender's descriptor may drop this JVM's locks.
            // Reject local contention before opening another descriptor for the same inode.
            if (shared.exclusive || shared.references > 0) {
                return null;
            }
            FileChannel channel = FileChannel.open(lockPath(),
                    StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
            FileLock lock = null;
            try {
                try {
                    lock = channel.tryLock();
                } catch (OverlappingFileLockException error) {
                    channel.close();
                    return null;
                }
                if (lock == null) {
                    channel.close();
                    return null;
                }
                String ownerId = UUID.randomUUID().toString();
                Files.deleteIfExists(coordinationDirectory.resolve(CANCEL_FILE));
                writeOwner(ownerId, operation);
                shared.exclusive = true;
                return new LockHandle(channel, lock, ownerId, shared);
            } catch (IOException | RuntimeException error) {
                try {
                    if (lock != null) {
                        lock.release();
                    }
                } catch (IOException releaseError) {
                    error.addSuppressed(releaseError);
                }
                try {
                    channel.close();
                } catch (IOException closeError) {
                    error.addSuppressed(closeError);
                }
                throw error;
            }
        }
    }

    private SharedProcessLock lockState() throws IOException {
        Path identity = coordinationDirectory.toRealPath().resolve(LOCK_FILE);
        return SHARED_PROCESS_LOCKS.computeIfAbsent(identity, ignored -> new SharedProcessLock());
    }

    public ProcessLock tryAcquireProcessLock() throws IOException {
        return tryAcquireSharedLock();
    }

    /** Maintenance may resume its own pending journal while keeping directory migration excluded. */
    public ProcessLock tryAcquireMaintenanceReadLock() throws IOException {
        return tryAcquireSharedLock();
    }

    private ProcessLock tryAcquireSharedLock() throws IOException {
        prepareDirectory();
        Path path = lockPath();
        SharedProcessLock shared = lockState();
        synchronized (shared) {
            if (shared.exclusive) {
                return null;
            }
            if (shared.references > 0) {
                requireRecoveredMigration();
                shared.references++;
                return new ProcessLock(shared);
            }
            FileChannel channel = FileChannel.open(path, StandardOpenOption.CREATE, StandardOpenOption.READ,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
            try {
                FileLock lock;
                try {
                    lock = channel.tryLock(0L, Long.MAX_VALUE, true);
                } catch (OverlappingFileLockException error) {
                    channel.close();
                    return null;
                }
                if (lock == null) {
                    channel.close();
                    return null;
                }
                requireRecoveredMigration();
                shared.channel = channel;
                shared.lock = lock;
                shared.references = 1;
                return new ProcessLock(shared);
            } catch (IOException | RuntimeException error) {
                channel.close();
                throw error;
            }
        }
    }

    private void requireRecoveredMigration() throws IOException {
        Path journal = coordinationDirectory.resolve("state").resolve("migration-journal.json");
        if (Files.exists(journal, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("AI_DATA_RECOVERY_REQUIRED");
        }
    }

    JsonObject readOwner() {
        if (!Files.isRegularFile(ownerPath(), LinkOption.NOFOLLOW_LINKS)) {
            return null;
        }
        try {
            if (Files.size(ownerPath()) > 4096L) {
                return null;
            }
            JsonElement value = JsonParser.parseString(Files.readString(ownerPath(), StandardCharsets.UTF_8));
            if (!value.isJsonObject()) {
                return null;
            }
            JsonObject owner = value.getAsJsonObject();
            if (!owner.has("protocolVersion")
                    || owner.get("protocolVersion").getAsInt() != PROTOCOL_VERSION
                    || !owner.has("ownerId") || !owner.get("ownerId").isJsonPrimitive()
                    || !owner.getAsJsonPrimitive("ownerId").isString()) {
                return null;
            }
            return owner;
        } catch (IOException | RuntimeException error) {
            return null;
        }
    }

    JsonObject readActiveOwner() {
        JsonObject owner = readOwner();
        if (owner == null || !owner.has("pid") || !owner.has("processStartedAt")) {
            return null;
        }
        try {
            ProcessHandle process = ProcessHandle.of(owner.get("pid").getAsLong()).orElse(null);
            if (process == null || !process.isAlive()) {
                return null;
            }
            String startedAt = owner.get("processStartedAt").getAsString();
            return process.info().startInstant().filter(start -> start.toString().equals(startedAt))
                    .map(start -> owner).orElse(null);
        } catch (RuntimeException error) {
            return null;
        }
    }

    /** A waiting IDE requests rollback of the current owner, never of a later migration. */
    public void requestMigrationCancellation() throws IOException {
        JsonObject owner = readActiveOwner();
        if (owner == null || owner.has("committed") && owner.get("committed").getAsBoolean()) {
            return;
        }
        JsonObject request = new JsonObject();
        request.addProperty("ownerId", owner.get("ownerId").getAsString());
        writeJson(coordinationDirectory.resolve(CANCEL_FILE), request);
    }

    private void writeOwner(String ownerId, String operation) throws IOException {
        JsonObject owner = new JsonObject();
        owner.addProperty("protocolVersion", PROTOCOL_VERSION);
        owner.addProperty("ownerId", ownerId);
        owner.addProperty("operation", operation);
        owner.addProperty("pid", ProcessHandle.current().pid());
        ProcessHandle.current().info().startInstant()
                .ifPresent(start -> owner.addProperty("processStartedAt", start.toString()));
        String product = System.getProperty("idea.platform.prefix", "unknown");
        owner.addProperty("ideProduct", product.length() > 64 ? product.substring(0, 64) : product);
        owner.addProperty("startedAt", Instant.now().toString());
        writeJson(ownerPath(), owner);
    }

    private void writeJson(Path path, JsonObject value) throws IOException {
        Files.createDirectories(path.getParent());
        Path temporary = Files.createTempFile(path.getParent(), ".migration-owner-", ".json");
        try {
            Files.writeString(temporary, GSON.toJson(value), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException error) {
                Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private void prepareDirectory() throws IOException {
        Path parent = coordinationDirectory.getParent();
        if (parent == null) {
            throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE");
        }
        if (isLinkLike(parent) || isLinkLike(coordinationDirectory)) {
            throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE");
        }
        Files.createDirectories(parent);
        Files.createDirectories(coordinationDirectory);
        if (isLinkLike(coordinationDirectory) || !Files.isDirectory(coordinationDirectory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE");
        }
    }

    private static boolean isLinkLike(Path path) throws IOException {
        return Files.exists(path, LinkOption.NOFOLLOW_LINKS)
                && (Files.isSymbolicLink(path) || Files.readAttributes(path, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS).isOther());
    }

    private Path lockPath() {
        return coordinationDirectory.resolve(LOCK_FILE);
    }

    private Path ownerPath() {
        return coordinationDirectory.resolve(OWNER_FILE);
    }

    public final class LockHandle implements AutoCloseable {

        private final FileChannel channel;
        private final FileLock lock;
        private final String ownerId;
        private final SharedProcessLock shared;
        private boolean closed;
        private boolean committed;

        private LockHandle(FileChannel channel, FileLock lock, String ownerId, SharedProcessLock shared) {
            this.channel = channel;
            this.lock = lock;
            this.ownerId = ownerId;
            this.shared = shared;
        }

        public boolean isCancellationRequested() throws IOException {
            synchronized (shared) {
                if (closed || committed) {
                    return false;
                }
                Path request = coordinationDirectory.resolve(CANCEL_FILE);
                if (!Files.isRegularFile(request, LinkOption.NOFOLLOW_LINKS) || Files.size(request) > 4096L) {
                    return false;
                }
                try {
                    JsonElement value = JsonParser.parseString(Files.readString(request, StandardCharsets.UTF_8));
                    return value.isJsonObject() && value.getAsJsonObject().has("ownerId")
                            && ownerId.equals(value.getAsJsonObject().get("ownerId").getAsString());
                } catch (RuntimeException error) {
                    throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE", error);
                }
            }
        }

        public boolean beginCommit() throws IOException {
            synchronized (shared) {
                if (closed || isCancellationRequested()) {
                    return false;
                }
                JsonObject owner = readOwner();
                if (owner == null || !ownerId.equals(owner.get("ownerId").getAsString())) {
                    throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE");
                }
                owner.addProperty("committed", true);
                writeJson(ownerPath(), owner);
                committed = true;
                return true;
            }
        }

        @Override
        public void close() throws IOException {
            synchronized (shared) {
                if (closed) {
                    return;
                }
                closed = true;
                try {
                    removeOwnerIfOwned();
                } finally {
                    try {
                        lock.release();
                    } finally {
                        try {
                            channel.close();
                        } finally {
                            shared.exclusive = false;
                        }
                    }
                }
            }
        }

        private void removeOwnerIfOwned() throws IOException {
            JsonObject owner = readOwner();
            if (owner != null && ownerId.equals(owner.get("ownerId").getAsString())) {
                Files.deleteIfExists(ownerPath());
                Files.deleteIfExists(coordinationDirectory.resolve(CANCEL_FILE));
            }
        }
    }

    public final class ProcessLock implements AutoCloseable {

        private final SharedProcessLock shared;
        private boolean closed;

        private ProcessLock(SharedProcessLock shared) {
            this.shared = shared;
        }

        @Override
        public void close() {
            synchronized (shared) {
                if (closed) {
                    return;
                }
                closed = true;
                shared.references--;
                if (shared.references == 0) {
                    try {
                        shared.lock.release();
                    } catch (IOException error) {
                        LOG.log(java.util.logging.Level.WARNING, "Failed to release AI data coordination lock", error);
                    } finally {
                        try {
                            shared.channel.close();
                        } catch (IOException error) {
                            LOG.log(java.util.logging.Level.WARNING, "Failed to close AI data coordination channel", error);
                        } finally {
                            shared.lock = null;
                            shared.channel = null;
                        }
                    }
                }
            }
        }
    }

    private static final class SharedProcessLock {
        private FileChannel channel;
        private FileLock lock;
        private int references;
        private boolean exclusive;
    }
}
