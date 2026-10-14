package com.github.claudecodegui.clawbot;

import com.github.claudecodegui.util.PlatformUtils;
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
import java.util.Optional;
import java.util.UUID;

/** Coordinates the single Claw Bot gateway leader for one desktop runtime. */
public final class ClawBotProcessCoordinator {

    static final int PROTOCOL_VERSION = 1;
    private static final String LOCK_FILE = "gateway.lock";
    private static final String LEADER_FILE = "leader.json";
    private static final long MAX_LEADER_FILE_BYTES = 4096L;
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private final Path runtimeDirectory;
    private final String instanceId;

    public ClawBotProcessCoordinator(Path runtimeDirectory, String instanceId) {
        this.runtimeDirectory = runtimeDirectory.toAbsolutePath().normalize();
        this.instanceId = requireValue(instanceId, "instanceId", 256);
    }

    /** Creates a coordinator with a process-unique instance identity. */
    public ClawBotProcessCoordinator(Path runtimeDirectory) {
        this(runtimeDirectory, UUID.randomUUID().toString());
    }

    /** Returns the per-user runtime root used by the first implementation. */
    public static Path defaultRuntimeDirectory() {
        String localAppData = PlatformUtils.getEnvIgnoreCase("LOCALAPPDATA");
        Path root = localAppData == null || localAppData.isBlank()
                ? Path.of(PlatformUtils.getHomeDirectory()).resolve(".cc-gui")
                : Path.of(localAppData).resolve("CC GUI");
        return root.resolve("ClawBot").resolve("runtime");
    }

    /** Tries to become leader without waiting for another process. */
    public LeaderLease tryAcquireLeader(String endpoint) throws IOException {
        String safeEndpoint = requireValue(endpoint, "endpoint", 512);
        prepareDirectory();
        FileChannel channel = FileChannel.open(lockPath(), StandardOpenOption.CREATE,
                StandardOpenOption.READ, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS);
        FileLock lock = null;
        try {
            try {
                lock = channel.tryLock();
            } catch (OverlappingFileLockException ignored) {
                closeQuietly(channel);
                return null;
            }
            if (lock == null) {
                closeQuietly(channel);
                return null;
            }
            writeLeader(safeEndpoint);
            return new LeaderLease(this, channel, lock, instanceId, leaderPath());
        } catch (IOException | RuntimeException error) {
            if (lock != null) {
                lock.release();
            }
            closeQuietly(channel);
            throw error;
        }
    }

    /** Reads the last owner record without treating it as lock authority. */
    public Optional<LeaderInfo> readLeader() throws IOException {
        Path path = leaderPath();
        if (!Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                || Files.size(path) > MAX_LEADER_FILE_BYTES) {
            return Optional.empty();
        }
        try {
            JsonElement value = JsonParser.parseString(Files.readString(path, StandardCharsets.UTF_8));
            if (!value.isJsonObject()) {
                return Optional.empty();
            }
            JsonObject object = value.getAsJsonObject();
            if (!object.has("protocolVersion")
                    || object.get("protocolVersion").getAsInt() != PROTOCOL_VERSION) {
                return Optional.empty();
            }
            return Optional.of(new LeaderInfo(
                    object.get("protocolVersion").getAsInt(),
                    object.get("instanceId").getAsString(),
                    object.get("endpoint").getAsString(),
                    object.get("pid").getAsLong(),
                    object.get("startedAt").getAsString(),
                    object.has("processStartedAt") ? object.get("processStartedAt").getAsString() : null));
        } catch (RuntimeException error) {
            return Optional.empty();
        }
    }

    private void writeLeader(String endpoint) throws IOException {
        JsonObject owner = new JsonObject();
        owner.addProperty("protocolVersion", PROTOCOL_VERSION);
        owner.addProperty("instanceId", instanceId);
        owner.addProperty("endpoint", endpoint);
        owner.addProperty("pid", ProcessHandle.current().pid());
        owner.addProperty("startedAt", Instant.now().toString());
        ProcessHandle.current().info().startInstant().ifPresent(
                value -> owner.addProperty("processStartedAt", value.toString()));
        Path temporary = Files.createTempFile(runtimeDirectory, ".leader-", ".json");
        try {
            Files.writeString(temporary, GSON.toJson(owner), StandardCharsets.UTF_8);
            try {
                Files.move(temporary, leaderPath(), StandardCopyOption.ATOMIC_MOVE,
                        StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException ignored) {
                Files.move(temporary, leaderPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    private void prepareDirectory() throws IOException {
        Path parent = runtimeDirectory.getParent();
        if (parent == null) {
            throw new IOException("CLAWBOT_RUNTIME_UNAVAILABLE");
        }
        Files.createDirectories(parent);
        if (Files.isSymbolicLink(parent) || Files.isSymbolicLink(runtimeDirectory)) {
            throw new IOException("CLAWBOT_RUNTIME_UNAVAILABLE");
        }
        Files.createDirectories(runtimeDirectory);
        if (!Files.isDirectory(runtimeDirectory, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("CLAWBOT_RUNTIME_UNAVAILABLE");
        }
    }

    private Path lockPath() {
        return runtimeDirectory.resolve(LOCK_FILE);
    }

    private Path leaderPath() {
        return runtimeDirectory.resolve(LEADER_FILE);
    }

    private static String requireValue(String value, String name, int maxLength) {
        if (value == null || value.isBlank() || value.length() > maxLength
                || value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("Invalid " + name);
        }
        return value;
    }

    private static void closeQuietly(FileChannel channel) {
        try {
            channel.close();
        } catch (IOException ignored) {
        }
    }

    /** Immutable owner metadata shown to a blocked follower. */
    public record LeaderInfo(
            int protocolVersion,
            String instanceId,
            String endpoint,
            long pid,
            String startedAt,
            String processStartedAt
    ) {
    }

    /** Holds the OS lock until the gateway stops or loses leadership. */
    public static final class LeaderLease implements AutoCloseable {
        private final ClawBotProcessCoordinator coordinator;
        private final FileChannel channel;
        private final FileLock lock;
        private final String ownerId;
        private final Path leaderPath;
        private boolean closed;

        private LeaderLease(
                ClawBotProcessCoordinator coordinator,
                FileChannel channel,
                FileLock lock,
                String ownerId,
                Path leaderPath
        ) {
            this.coordinator = coordinator;
            this.channel = channel;
            this.lock = lock;
            this.ownerId = ownerId;
            this.leaderPath = leaderPath;
        }

        /** Replaces the temporary endpoint after the authenticated server is bound. */
        public synchronized void updateEndpoint(String endpoint) throws IOException {
            String safeEndpoint = requireValue(endpoint, "endpoint", 512);
            if (closed) {
                throw new IOException("CLAWBOT_LEADER_CLOSED");
            }
            if (!ownsLeaderRecord()) {
                throw new IOException("CLAWBOT_LEADER_LOST");
            }
            coordinator.writeLeader(safeEndpoint);
        }

        @Override
        public void close() throws IOException {
            if (closed) {
                return;
            }
            closed = true;
            try {
                deleteLeaderIfOwned();
            } finally {
                try {
                    lock.release();
                } finally {
                    channel.close();
                }
            }
        }

        private void deleteLeaderIfOwned() throws IOException {
            if (!Files.isRegularFile(leaderPath, LinkOption.NOFOLLOW_LINKS)) {
                return;
            }
            try {
                JsonElement value = JsonParser.parseString(Files.readString(leaderPath, StandardCharsets.UTF_8));
                if (value.isJsonObject() && ownerId.equals(value.getAsJsonObject().get("instanceId").getAsString())) {
                    Files.deleteIfExists(leaderPath);
                }
            } catch (RuntimeException ignored) {
                Files.deleteIfExists(leaderPath);
            }
        }

        private boolean ownsLeaderRecord() throws IOException {
            if (!Files.isRegularFile(leaderPath, LinkOption.NOFOLLOW_LINKS)) {
                return false;
            }
            try {
                JsonElement value = JsonParser.parseString(Files.readString(leaderPath, StandardCharsets.UTF_8));
                return value.isJsonObject()
                        && ownerId.equals(value.getAsJsonObject().get("instanceId").getAsString());
            } catch (RuntimeException error) {
                return false;
            }
        }
    }
}
