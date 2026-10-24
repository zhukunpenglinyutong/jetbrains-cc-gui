package com.github.claudecodegui.storage;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.settings.AiDataMigrationCoordinator;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.function.ToLongFunction;

/** Native maintenance guarded by directory admission, native writer leases and SQLite locks. */
public final class CodexStorageMaintenance {
    private static final Gson GSON = new Gson();
    private static final Logger LOG = Logger.getInstance(CodexStorageMaintenance.class);
    private final CodexStoragePaths paths;
    private final AiDataProcessGate gate;
    private final AiDataMigrationCoordinator coordinator;
    private final CodexMaintenanceJournal journal;
    private final ToLongFunction<Path> freeSpace;
    private final boolean supportedPlatform;
    private final boolean supportedDeletion;
    private final Consumer<String> checkpointObserver;

    public CodexStorageMaintenance(CodexStoragePaths paths) {
        this(paths, AiDataProcessGate.getInstance(), AiDataMigrationCoordinator.defaultCoordinationDirectory(),
                path -> path.toFile().getUsableSpace(),
                CodexStoragePlatform.supportsMaintenance(paths), CodexStoragePlatform.supportsDeletion(paths), checkpoint -> { });
    }

    CodexStorageMaintenance(CodexStoragePaths paths, AiDataProcessGate gate, Path coordination,
                            ToLongFunction<Path> freeSpace,
                            boolean supportedPlatform, Consumer<String> checkpointObserver) {
        this(paths, gate, coordination, freeSpace, supportedPlatform, supportedPlatform, checkpointObserver);
    }

    CodexStorageMaintenance(CodexStoragePaths paths, AiDataProcessGate gate, Path coordination,
                            ToLongFunction<Path> freeSpace, boolean supportedPlatform,
                            boolean supportedDeletion, Consumer<String> checkpointObserver) {
        this.paths = paths;
        this.gate = gate;
        // Directory admission already holds migration.lock shared. Serialize maintenance on
        // another lock so idle app-servers and this operation cannot conflict with themselves.
        this.coordinator = new AiDataMigrationCoordinator(coordination.resolve("codex-storage-lock"));
        this.journal = new CodexMaintenanceJournal(coordination);
        this.freeSpace = freeSpace;
        this.supportedPlatform = supportedPlatform;
        this.supportedDeletion = supportedDeletion;
        this.checkpointObserver = checkpointObserver;
    }

    public JsonObject databaseStatus() throws IOException {
        paths.revalidate();
        JsonObject status = new JsonObject();
        status.addProperty("databaseId", databaseId());
        status.addProperty("name", CodexStoragePaths.HISTORY_DATABASE);
        status.add("sizes", sizes());
        boolean pending = journal.hasPending();
        status.addProperty("maintenancePending", pending);
        String reason = supportedPlatform ? null : "MAINTENANCE_PLATFORM_UNSUPPORTED";
        Path file = paths.root().resolve(CodexStoragePaths.HISTORY_DATABASE);
        if (!Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
            reason = "DATABASE_NOT_FOUND";
        } else if (!pending) {
            try (AiDataProcessGate.ReadPermit permit = gate.tryAcquireReadPermit()) {
                if (permit == null) {
                    reason = "DATABASE_BUSY";
                } else {
                    try (Connection connection = CodexStorageDatabase.open(paths.existingFile(file), true)) {
                        status.addProperty("engineVersion", CodexStorageDatabase.engineVersion(connection));
                        status.addProperty("schema", CodexStorageDatabase.fingerprint(connection));
                        status.addProperty("pageCount", CodexStorageDatabase.scalar(connection, "PRAGMA page_count"));
                        status.addProperty("pageSize", CodexStorageDatabase.scalar(connection, "PRAGMA page_size"));
                        status.addProperty("freelistCount", CodexStorageDatabase.scalar(connection, "PRAGMA freelist_count"));
                        CodexStorageDatabase.requireSupported(connection, CodexStoragePaths.HISTORY_DATABASE);
                    }
                }
            } catch (SQLException | IOException | IllegalStateException error) {
                reason = errorCode(error);
            }
        }
        status.addProperty("supported", reason == null);
        if (reason != null) {
            status.addProperty("unavailableReason", reason);
        }
        return status;
    }

    /** Lightweight admission check for storage controls, independent of list pagination and full inventory scans. */
    public JsonObject mutationStatus() {
        String reason = null;
        String deletionReason = null;
        Set<String> running = CodexStorageActivity.runningSessionIds();
        Set<String> writers = Set.of();
        try {
            paths.revalidate();
            if (!supportedPlatform && !supportedDeletion) {
                reason = deletionReason = "MAINTENANCE_PLATFORM_UNSUPPORTED";
            } else {
                try (AiDataProcessGate.ReadPermit permit = gate.tryAcquireMaintenancePermit()) {
                    if (permit == null) {
                        reason = deletionReason = "DATABASE_BUSY";
                    } else {
                        try (AiDataMigrationCoordinator.LockHandle owner = coordinator.tryAcquire("codex-storage-status")) {
                            if (owner == null) {
                                reason = deletionReason = "DATABASE_BUSY";
                            } else {
                                reason = deletionReason = CodexStorageWriterLease.deletionUnavailableReason(paths);
                                writers = CodexStorageWriterLease.occupiedSessions(paths);
                                if (reason == null) {
                                    reason = CodexStorageActivity.hasRunningSessions() ? "SESSION_RUNNING"
                                            : writers.isEmpty() ? null : "SESSION_WRITER_BUSY";
                                }
                            }
                        }
                    }
                }
            }
        } catch (IOException | RuntimeException error) {
            reason = deletionReason = errorCode(error);
        }
        if (!supportedPlatform) {
            reason = "MAINTENANCE_PLATFORM_UNSUPPORTED";
        }
        if (!supportedDeletion) {
            deletionReason = "MAINTENANCE_PLATFORM_UNSUPPORTED";
        }
        JsonObject status = new JsonObject();
        status.addProperty("available", reason == null);
        if (reason != null) {
            status.addProperty("unavailableReason", reason);
        }
        status.addProperty("deletionAvailable", deletionReason == null);
        if (deletionReason != null) {
            status.addProperty("deletionUnavailableReason", deletionReason);
        }
        status.add("runningSessionIds", GSON.toJsonTree(running.stream().sorted().toList()));
        status.add("writerSessionIds", GSON.toJsonTree(writers.stream().sorted().toList()));
        return status;
    }

    /** Normal history deletion shares crash recovery, with writer checks scoped to the selected family. */
    public JsonObject deleteHistorySessions(Collection<String> selected) throws IOException, SQLException {
        return deleteHistorySessions(selected, null, false);
    }

    public JsonObject deleteHistorySessions(Collection<String> selected, String operationId, boolean metadataRequired) throws IOException, SQLException {
        return deleteSessions(selected, operationId, true, metadataRequired);
    }

    public JsonObject deleteSessions(Collection<String> selected, String operationId, boolean legacy) throws IOException, SQLException {
        return deleteSessions(selected, operationId, legacy, false);
    }

    public JsonObject deleteSessions(Collection<String> selected, String operationId, boolean legacy, boolean metadataRequired) throws IOException, SQLException {
        List<String> ids = selected.stream().distinct().sorted().toList();
        if (ids.isEmpty() || ids.size() > 1000) {
            throw new IOException("INVALID_SESSION_SELECTION");
        }
        for (String id : ids) {
            CodexStoragePaths.requireSessionId(id);
        }
        return execute("DELETE_SESSIONS", ids, operationId, legacy, null, metadataRequired);
    }

    public JsonObject compact(String databaseId, String operationId) throws IOException, SQLException {
        if (!databaseId().equals(databaseId)) {
            throw new IOException("STORAGE_IDENTITY_CHANGED");
        }
        return execute("COMPACT_DATABASE", List.of(CodexStoragePaths.HISTORY_DATABASE), operationId, false, databaseId, false);
    }

    public JsonObject previewOrphans() throws IOException, SQLException {
        try (AiDataProcessGate.ReadPermit permit = gate.tryAcquireReadPermit()) {
            if (permit == null) {
                throw new IOException("DATABASE_BUSY");
            }
            return CodexStorageOrphans.analyze(paths, databaseId()).summary();
        }
    }

    public JsonObject cleanOrphans(String databaseId, String previewToken, String operationId) throws IOException, SQLException {
        if (!databaseId().equals(databaseId)) {
            throw new IOException("STORAGE_IDENTITY_CHANGED");
        }
        if (previewToken == null || !previewToken.matches("[a-f0-9]{64}")) {
            throw new IOException("INVALID_STORAGE_REQUEST");
        }
        return execute("CLEAN_ORPHANED_HISTORY", List.of(previewToken), operationId, false, databaseId, false);
    }

    public JsonObject operation(String id) throws IOException {
        JsonObject record = journal.get(id);
        if (record == null) {
            throw new IOException("OPERATION_NOT_FOUND");
        }
        if (!paths.identity().equals(record.get("rootIdentity").getAsString())) {
            throw new IOException("STORAGE_IDENTITY_CHANGED");
        }
        return CodexMaintenanceJournal.publicStatus(record);
    }

    public JsonArray operations() throws IOException {
        return journal.list(paths);
    }

    /** Source maintenance is finished before existing Node-based metadata helpers acquire ordinary admission. */
    public JsonObject finishMetadata(String operationId, boolean succeeded) throws IOException {
        try (var permit = gate.tryAcquireMaintenancePermit(); var owner = permit == null ? null : coordinator.tryAcquire("codex-storage")) {
            if (owner == null) {
                return operation(operationId);
            }
            paths.revalidate();
            JsonObject record = journal.get(operationId);
            if (record == null || !paths.identity().equals(record.get("rootIdentity").getAsString()) || !CodexMaintenanceJournal.terminal(record)
                    || !record.get("kind").getAsString().equals("DELETE_SESSIONS") || !record.has("result")) {
                throw new IOException("OPERATION_ID_CONFLICT");
            }
            JsonObject result = record.getAsJsonObject("result");
            result.addProperty("metadataStatus", succeeded ? "COMPLETE" : "FAILED");
            if (succeeded) {
                result.remove("warning");
            } else {
                result.addProperty("warning", "METADATA_CLEANUP_FAILED");
            }
            journal.state(record, succeeded ? "COMPLETED" : "COMPLETED_WITH_WARNINGS");
            return CodexMaintenanceJournal.publicStatus(record);
        }
    }

    private JsonObject execute(String kind, List<String> ids, String requestedId, boolean legacy,
                               String expectedDatabaseId, boolean metadataRequired) throws IOException, SQLException {
        if (!(kind.equals("DELETE_SESSIONS") ? supportedDeletion : supportedPlatform)) {
            throw new IOException("MAINTENANCE_PLATFORM_UNSUPPORTED");
        }
        paths.revalidate();
        String id = requestedId == null && legacy ? UUID.randomUUID().toString() : requestedId;
        // A resident app-server is not necessarily a writer. Shared directory admission
        // excludes relocation; native publication and selected-writer checks protect deletion.
        try (AiDataProcessGate.ReadPermit permit = gate.tryAcquireMaintenancePermit()) {
            if (permit == null) {
                throw new IOException("DATABASE_BUSY");
            }
            try (AiDataMigrationCoordinator.LockHandle owner = coordinator.tryAcquire("codex-storage")) {
                if (owner == null) {
                    throw new IOException("DATABASE_BUSY");
                }
                // Whole-database maintenance requires all writers to stop. Deletion, from either
                // entry point, protects only its selected family under publication ownership.
                boolean sessionDeletion = kind.equals("DELETE_SESSIONS");
                if (journal.get(id) == null) {
                    if (sessionDeletion ? !java.util.Collections.disjoint(ids, CodexStorageActivity.runningSessionIds())
                            : CodexStorageActivity.hasRunningSessions()) {
                        throw new IOException("SESSION_RUNNING");
                    }
                    String reason = sessionDeletion ? CodexStorageWriterLease.deletionUnavailableReason(paths)
                            : CodexStorageWriterLease.maintenanceUnavailableReason(paths);
                    if (reason != null) {
                        throw new IOException(reason);
                    }
                    if (sessionDeletion && !java.util.Collections.disjoint(ids, CodexStorageWriterLease.occupiedSessions(paths))) {
                        throw new IOException("SESSION_WRITER_BUSY");
                    }
                }
                JsonObject record = journal.claim(id, kind, paths, ids, legacy);
                if (CodexMaintenanceJournal.terminal(record)) {
                    return CodexMaintenanceJournal.publicStatus(record);
                }
                LOG.info("[CodexStorage] Maintenance started: operationId=" + id + ", kind=" + kind);
                try (CodexStorageWriterLease writers = sessionDeletion
                        ? CodexStorageWriterLease.acquireForHistoryDeletion(paths) : CodexStorageWriterLease.acquire(paths)) {
                    if (!sessionDeletion && CodexStorageActivity.hasRunningSessions()) {
                        throw new IOException("SESSION_RUNNING");
                    }
                    if (expectedDatabaseId != null && !databaseId().equals(expectedDatabaseId)) {
                        throw new IOException("STORAGE_IDENTITY_CHANGED");
                    }
                    // Keep native publication ownership through every database/file checkpoint.
                    journal.state(record, record.has("mutationStarted") ? "RECONCILING" : "PREPARING");
                    if (kind.equals("DELETE_SESSIONS")) {
                        delete(record, ids, writers);
                        if (metadataRequired) {
                            record.getAsJsonObject("result").addProperty("metadataStatus", "PENDING");
                            record.getAsJsonObject("result").addProperty("warning", "METADATA_CLEANUP_PENDING");
                        }
                    } else if (kind.equals("CLEAN_ORPHANED_HISTORY")) {
                        cleanOrphans(record, ids.get(0), expectedDatabaseId);
                    } else {
                        compact(record, expectedDatabaseId);
                    }
                    record.remove("error");
                    if (!CodexMaintenanceJournal.terminal(record)) {
                        journal.state(record, record.getAsJsonObject("result").has("warning") ? "COMPLETED_WITH_WARNINGS" : "COMPLETED");
                    }
                } catch (IOException | SQLException | RuntimeException error) {
                    record.addProperty("error", errorCode(error));
                    LOG.warn("[CodexStorage] Maintenance failed: operationId=" + id + ", kind=" + kind
                            + ", state=" + record.get("state").getAsString() + ", mutationStarted=" + record.has("mutationStarted")
                            + ", error=" + errorCode(error), error);
                    journal.state(record, record.has("mutationStarted") ? "RECONCILIATION_REQUIRED" : "FAILED_CLEAN");
                }
                LOG.info("[CodexStorage] Maintenance finished: operationId=" + id + ", kind=" + kind + ", state=" + record.get("state").getAsString());
                return CodexMaintenanceJournal.publicStatus(record);
            }
        }
    }

    private void delete(JsonObject record, List<String> selected, CodexStorageWriterLease writers) throws IOException, SQLException {
        var inventory = new CodexStorageInventory(paths).snapshot();
        if (!inventory.errors().isEmpty()) {
            throw new IOException("INVENTORY_INCOMPLETE");
        }
        try (CodexStorageStores stores = CodexStorageStores.forHistoryDeletion(paths)) {
            Set<String> resolved = stores.family(selected, inventory);
            Set<String> ids = record.has("family") ? new LinkedHashSet<>(strings(record.getAsJsonArray("family"))) : resolved;
            if (!ids.containsAll(resolved)) {
                throw new IOException("SELECTED_DATA_CHANGED");
            }
            if (!record.has("family") && ids.stream().noneMatch(inventory.sessions()::containsKey)) {
                throw new IOException("SESSION_NOT_FOUND");
            }
            if (!java.util.Collections.disjoint(ids, CodexStorageActivity.runningSessionIds())) {
                throw new IOException("SESSION_RUNNING");
            }
            writers.requireIdleSessions(paths, ids);
            stores.preflightDependencies(ids);
            List<String> declared = stores.declaredRollouts(ids, inventory);
            if (!record.has("stores")) {
                JsonArray files = captureFiles(ids, inventory);
                List<String> names = new ArrayList<>(declared);
                names.addAll(rolloutPaths(files));
                record.add("rolloutNames", GSON.toJsonTree(names.stream().distinct().toList()));
                record.add("family", GSON.toJsonTree(ids));
                record.add("files", files);
                record.add("stores", stores.capture(ids, strings(record.getAsJsonArray("rolloutNames"))));
                record.add("before", sizes());
                journal.save(record);
            }
            validateFiles(record.getAsJsonArray("files"), inventory, ids);
            paths.revalidate();
            record.addProperty("mutationStarted", true);
            journal.state(record, "COMMITTING");
            checkpointObserver.accept("delete-intent");
            long removed = stores.delete(record.getAsJsonObject("stores"), ids, strings(record.getAsJsonArray("rolloutNames")), () -> {
                journal.save(record);
                checkpointObserver.accept("database-commit");
            });
            long rolloutBytes = 0;
            Set<String> removedPhysical = new LinkedHashSet<>();
            for (JsonElement element : record.getAsJsonArray("files")) {
                JsonObject captured = element.getAsJsonObject();
                Path file = paths.root().resolve(captured.get("relative").getAsString()).normalize();
                if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                    validateFile(file, captured);
                    Files.delete(file);
                }
                String physical = captured.has("physical") ? captured.get("physical").getAsString() : captured.get("identity").getAsString();
                if (removedPhysical.add(physical)) {
                    rolloutBytes += captured.get("size").getAsLong();
                }
                captured.addProperty("done", true);
                journal.save(record);
                checkpointObserver.accept("file-delete");
            }
            JsonObject result = new JsonObject();
            result.add("deletedSessionIds", GSON.toJsonTree(ids));
            result.addProperty("logicalRowsRemovedThisAttempt", removed);
            result.addProperty("rolloutBytesRemoved", rolloutBytes);
            result.add("before", record.get("before"));
            record.add("result", result);
        }
        paths.revalidate();
        record.getAsJsonObject("result").add("after", sizes());
        checkpointObserver.accept("delete-verified");
    }

    private void compact(JsonObject record, String expectedDatabaseId) throws IOException, SQLException {
        boolean resumed = record.has("compactionStarted")
                || (record.get("kind").getAsString().equals("COMPACT_DATABASE") && record.has("mutationStarted"));
        try (CodexStorageStores stores = new CodexStorageStores(paths, true)) {
            if (!databaseId().equals(expectedDatabaseId)) {
                throw new IOException("STORAGE_IDENTITY_CHANGED");
            }
            Connection connection = stores.history();
            String identity = stores.identities().get(CodexStoragePaths.HISTORY_DATABASE);
            String digest = CodexStorageDatabase.contentDigest(connection);
            if (resumed) {
                if (!identity.equals(record.get("databaseIdentity").getAsString()) || !digest.equals(record.get("contentDigest").getAsString())) {
                    throw new IOException("SELECTED_DATA_CHANGED");
                }
                CodexStorageDatabase.checkIntegrity(connection);
                JsonObject result = compactionResult(record, "INTERRUPTED_COMPACTION_VERIFIED");
                record.add("result", result);
            }
            if (!resumed || record.get("kind").getAsString().equals("CLEAN_ORPHANED_HISTORY")) {
                record.addProperty("databaseIdentity", identity);
                record.addProperty("contentDigest", digest);
                if (!record.has("before")) {
                    record.add("before", sizes());
                }
                record.add("beforeMetrics", CodexStorageDatabase.metrics(connection));
                requireCapacity(Math.multiplyExact(CodexStorageDatabase.scalar(connection, "PRAGMA page_count"),
                        CodexStorageDatabase.scalar(connection, "PRAGMA page_size")));
                paths.revalidate();
                // VACUUM and WAL checkpoints require autocommit. Native writer/publication leases remain held.
                connection.setAutoCommit(true);
                record.addProperty("mutationStarted", true);
                record.addProperty("compactionStarted", true);
                journal.state(record, "COMMITTING");
                checkpointObserver.accept("compact-intent");
                // A reader can retain an old WAL snapshot without preventing VACUUM in WAL mode.
                // Report retained WAL only after compaction instead of leaving maintenance pending.
                checkpointIfAvailable(connection);
                checkpointObserver.accept("before-vacuum");
                CodexStorageDatabase.execute(connection, "VACUUM");
                checkpointObserver.accept("after-vacuum");
                boolean checkpointed = checkpointIfAvailable(connection);
                checkpointObserver.accept("after-checkpoint");
                CodexStorageDatabase.checkIntegrity(connection);
                if (!digest.equals(CodexStorageDatabase.contentDigest(connection))) {
                    throw new IOException("DATABASE_CONTENT_CHANGED");
                }
                record.add("result", compactionResult(record, checkpointed ? null : "WAL_SPACE_RETAINED"));
                if (checkpointed) {
                    record.getAsJsonObject("result").remove("warning");
                }
            }
            record.getAsJsonObject("result").add("afterMetrics", CodexStorageDatabase.metrics(connection));
        }
        JsonObject result = record.getAsJsonObject("result");
        result.add("after", sizes());
        result.addProperty("releasedBytes", total(result.getAsJsonObject("before")) - total(result.getAsJsonObject("after")));
        journal.state(record, result.has("warning") ? "COMPLETED_WITH_WARNINGS" : "COMPLETED");
    }

    private static boolean checkpointIfAvailable(Connection connection) throws SQLException {
        try {
            return CodexStorageDatabase.checkpoint(connection);
        } catch (SQLException error) {
            if (!"DATABASE_BUSY".equals(errorCode(error))) {
                throw error;
            }
            return false;
        }
    }

    private JsonObject compactionResult(JsonObject record, String warning) {
        JsonObject result = record.has("result") ? record.getAsJsonObject("result").deepCopy() : new JsonObject();
        result.add("before", record.get("before").deepCopy());
        if (record.has("beforeMetrics")) {
            result.add("beforeMetrics", record.get("beforeMetrics").deepCopy());
        }
        result.addProperty("verifiedAt", Instant.now().toString());
        if (warning != null) {
            result.addProperty("warning", warning);
        }
        return result;
    }

    private void cleanOrphans(JsonObject record, String previewToken, String expectedDatabaseId) throws IOException, SQLException {
        if (!record.has("orphanSessionIds")) {
            var analysis = CodexStorageOrphans.analyze(paths, expectedDatabaseId);
            if (!previewToken.equals(analysis.token())) {
                throw new IOException("ORPHAN_PREVIEW_EXPIRED");
            }
            if (analysis.ids().isEmpty()) {
                throw new IOException("NO_ORPHANED_HISTORY");
            }
            record.add("orphanSessionIds", GSON.toJsonTree(analysis.ids()));
            record.add("before", sizes());
            journal.save(record);
        }
        List<String> ids = strings(record.getAsJsonArray("orphanSessionIds"));
        var inventory = new CodexStorageInventory(paths).snapshot();
        if (!inventory.errors().isEmpty()) {
            throw new IOException("INVENTORY_INCOMPLETE");
        }
        for (String id : ids) {
            var entry = inventory.sessions().get(id);
            if (entry != null && (!entry.files.isEmpty() || CodexStorageOrphans.declaredRolloutExists(entry)
                    || entry.running || "SESSION_WRITER_BUSY".equals(entry.deletionUnavailableReason))) {
                throw new IOException("ORPHAN_PREVIEW_EXPIRED");
            }
        }
        try (CodexStorageStores stores = new CodexStorageStores(paths, true)) {
            if (!record.has("orphanStores")) {
                requireCapacity(Math.multiplyExact(CodexStorageDatabase.scalar(stores.history(), "PRAGMA page_count"),
                        CodexStorageDatabase.scalar(stores.history(), "PRAGMA page_size")));
                record.add("orphanStores", stores.capture(ids, List.of()));
                journal.save(record);
            }
            paths.revalidate();
            record.addProperty("mutationStarted", true);
            journal.state(record, "COMMITTING");
            checkpointObserver.accept("orphan-intent");
            long removed = stores.delete(record.getAsJsonObject("orphanStores"), ids, List.of(), () -> {
                journal.save(record);
                checkpointObserver.accept("orphan-database-commit");
            });
            if (!record.has("result")) {
                JsonObject result = new JsonObject();
                result.addProperty("cleanedSessionCount", ids.size());
                result.addProperty("logicalRowsRemovedThisAttempt", removed);
                record.add("result", result);
                journal.save(record);
            }
        }
        compact(record, expectedDatabaseId);
    }

    private void requireCapacity(long databaseBytes) throws IOException {
        long required = Math.addExact(Math.multiplyExact(databaseBytes, 2L), 64L * 1024 * 1024);
        Set<Path> volumes = new LinkedHashSet<>(List.of(paths.root(), Path.of(System.getProperty("java.io.tmpdir"))));
        for (String name : List.of("SQLITE_TMPDIR", "TEMP", "TMP")) {
            String value = System.getenv(name);
            if (value != null && !value.isBlank() && Files.isDirectory(Path.of(value))) {
                volumes.add(Path.of(value));
            }
        }
        for (Path volume : volumes) {
            if (freeSpace.applyAsLong(volume) < required) {
                throw new IOException("INSUFFICIENT_DISK_SPACE");
            }
        }
    }

    private JsonArray captureFiles(Set<String> ids, CodexStorageInventory.Snapshot inventory) throws IOException {
        JsonArray files = new JsonArray();
        for (String id : ids) {
            var entry = inventory.sessions().get(id);
            if (entry == null) {
                continue;
            }
            for (Path file : entry.files) {
                Path real = paths.existingFile(file);
                JsonObject captured = new JsonObject();
                captured.addProperty("relative", paths.root().relativize(real).toString());
                captured.addProperty("identity", CodexStoragePaths.identity(real));
                captured.addProperty("physical", CodexStoragePaths.physicalFileKey(real,
                        Files.readAttributes(real, java.nio.file.attribute.BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS)).toString());
                captured.addProperty("size", Files.size(real));
                captured.addProperty("modified", Files.getLastModifiedTime(real).toMillis());
                files.add(captured);
            }
        }
        return files;
    }

    private void validateFiles(JsonArray files, CodexStorageInventory.Snapshot inventory, Set<String> ids) throws IOException {
        Set<String> captured = new LinkedHashSet<>();
        for (JsonElement element : files) {
            JsonObject record = element.getAsJsonObject();
            Path file = paths.root().resolve(record.get("relative").getAsString()).normalize();
            captured.add(file.toString());
            if (Files.exists(file, LinkOption.NOFOLLOW_LINKS)) {
                validateFile(file, record);
            }
        }
        for (String id : ids) {
            var entry = inventory.sessions().get(id);
            if (entry != null && entry.files.stream().anyMatch(file -> !captured.contains(file.toString()))) {
                throw new IOException("SELECTED_DATA_CHANGED");
            }
        }
    }

    private void validateFile(Path file, JsonObject captured) throws IOException {
        paths.existingFile(file);
        if (!CodexStoragePaths.identity(file).equals(captured.get("identity").getAsString()) || Files.size(file) != captured.get("size").getAsLong()
                || Files.getLastModifiedTime(file).toMillis() != captured.get("modified").getAsLong()) {
            throw new IOException("SELECTED_DATA_CHANGED");
        }
    }

    private List<String> rolloutPaths(JsonArray files) {
        List<String> names = new ArrayList<>();
        for (JsonElement file : files) {
            Path path = paths.root().resolve(file.getAsJsonObject().get("relative").getAsString());
            names.add(path.toString());
            names.add(path.toString().replace('\\', '/'));
        }
        return names.stream().distinct().toList();
    }

    private JsonObject sizes() throws IOException {
        JsonObject result = new JsonObject();
        for (String suffix : List.of("", "-wal", "-shm", "-journal")) {
            Path file = paths.root().resolve(CodexStoragePaths.HISTORY_DATABASE + suffix);
            result.addProperty(suffix.isEmpty() ? "mainBytes" : suffix.substring(1) + "Bytes",
                    Files.exists(file, LinkOption.NOFOLLOW_LINKS) ? Files.size(paths.existingFile(file)) : 0L);
        }
        return result;
    }

    private String databaseId() throws IOException {
        paths.revalidate();
        Path file = paths.root().resolve(CodexStoragePaths.HISTORY_DATABASE);
        String identity = paths.identity() + "\n" + (Files.exists(file, LinkOption.NOFOLLOW_LINKS)
                ? CodexStoragePaths.identity(paths.existingFile(file)) : "missing");
        return "codex-history-" + java.util.HexFormat.of().formatHex(CodexStorageDatabase.digest()
                .digest(identity.getBytes(java.nio.charset.StandardCharsets.UTF_8))).substring(0, 24);
    }

    private static long total(JsonObject sizes) {
        return sizes.entrySet().stream().mapToLong(entry -> entry.getValue().getAsLong()).sum();
    }

    private static List<String> strings(JsonArray array) {
        List<String> result = new ArrayList<>();
        array.forEach(value -> result.add(value.getAsString()));
        return result;
    }

    public static String errorCode(Throwable error) {
        if (error.getCause() != null && (error instanceof java.util.concurrent.CompletionException || error instanceof IllegalStateException)) {
            return errorCode(error.getCause());
        }
        if (error instanceof SQLException sql && (sql.getErrorCode() == 5 || sql.getErrorCode() == 6)) {
            return "DATABASE_BUSY";
        }
        String message = error.getMessage();
        return message != null && message.matches("[A-Z][A-Z0-9_]+") ? message : "STORAGE_OPERATION_FAILED";
    }
}
