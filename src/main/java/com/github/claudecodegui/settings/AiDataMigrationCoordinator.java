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
        FileChannel channel = FileChannel.open(lockPath(),
                StandardOpenOption.CREATE, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        FileLock lock = null;
        try {
            try {
                lock = channel.tryLock();
            } catch (OverlappingFileLockException error) {
                return closeAndReturn(channel);
            }
            if (lock == null) {
                channel.close();
                return null;
            }

            if (!"codex-storage".equals(operation)
                    && com.github.claudecodegui.storage.CodexMaintenanceJournal.blocksAdmission(coordinationDirectory)) {
                throw new IOException("AI_DATA_MAINTENANCE_PENDING");
            }

            String ownerId = UUID.randomUUID().toString();
            writeOwner(ownerId, operation);
            return new LockHandle(channel, lock, ownerId);
        } catch (IOException | RuntimeException error) {
            if (lock != null) {
                lock.release();
            }
            channel.close();
            throw error;
        }
    }

    public ProcessLock tryAcquireProcessLock() throws IOException {
        return tryAcquireSharedLock(false);
    }

    /** Maintenance may resume its own pending journal while keeping directory migration excluded. */
    public ProcessLock tryAcquireMaintenanceReadLock() throws IOException {
        return tryAcquireSharedLock(true);
    }

    private ProcessLock tryAcquireSharedLock(boolean maintenance) throws IOException {
        prepareDirectory();
        Path path = lockPath();
        SharedProcessLock shared = SHARED_PROCESS_LOCKS.computeIfAbsent(path, ignored -> new SharedProcessLock());
        synchronized (shared) {
            if (!maintenance && com.github.claudecodegui.storage.CodexMaintenanceJournal.blocksAdmission(coordinationDirectory)) {
                throw new IOException("AI_DATA_MAINTENANCE_PENDING");
            }
            if (shared.references > 0) {
                shared.references++;
                return new ProcessLock(path, shared);
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
                if (!maintenance && com.github.claudecodegui.storage.CodexMaintenanceJournal.blocksAdmission(coordinationDirectory)) {
                    lock.release();
                    channel.close();
                    throw new IOException("AI_DATA_MAINTENANCE_PENDING");
                }
                shared.channel = channel;
                shared.lock = lock;
                shared.references = 1;
                return new ProcessLock(path, shared);
            } catch (IOException | RuntimeException error) {
                channel.close();
                throw error;
            }
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

    private LockHandle closeAndReturn(FileChannel channel) throws IOException {
        channel.close();
        return null;
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
        Files.createDirectories(parent);
        if (Files.isSymbolicLink(parent) || Files.isSymbolicLink(coordinationDirectory)) {
            throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE");
        }
        Files.createDirectories(coordinationDirectory);
        if (!Files.isDirectory(coordinationDirectory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("AI_DATA_COORDINATION_UNAVAILABLE");
        }
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
        private boolean closed;

        private LockHandle(FileChannel channel, FileLock lock, String ownerId) {
            this.channel = channel;
            this.lock = lock;
            this.ownerId = ownerId;
        }

        @Override
        public void close() throws IOException {
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
                    channel.close();
                }
            }
        }

        private void removeOwnerIfOwned() throws IOException {
            JsonObject owner = readOwner();
            if (owner != null && ownerId.equals(owner.get("ownerId").getAsString())) {
                Files.deleteIfExists(ownerPath());
            }
        }
    }

    public final class ProcessLock implements AutoCloseable {

        private final Path path;
        private final SharedProcessLock shared;
        private boolean closed;

        private ProcessLock(Path path, SharedProcessLock shared) {
            this.path = path;
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
                    } catch (IOException ignored) {
                    } finally {
                        try {
                            shared.channel.close();
                        } catch (IOException ignored) {
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
    }
}
