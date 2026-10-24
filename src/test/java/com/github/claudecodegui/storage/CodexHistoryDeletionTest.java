package com.github.claudecodegui.storage;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.sql.Connection;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.*;

public class CodexHistoryDeletionTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void unrelatedNativeWriterDoesNotBlockHistoryDeletion() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        f.thread("running", "/other", 10);
        var remove = f.rollout("remove", null, false);
        var keep = f.rollout("running", null, false);
        var locks = Files.createDirectory(f.root.resolve("thread-writer-locks"));
        try (var writer = CodexStorageFileLock.tryAcquire(f.paths, locks.resolve("running.lock"), true)) {
            assertNotNull(writer);
            var result = f.service().deleteHistorySessions(List.of("remove"));
            assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
            assertFalse(Files.exists(remove));
            assertTrue(Files.exists(keep));
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
            assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
        }
    }

    @Test public void idleNativeWalReaderDoesNotBlockHistoryDeletion() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        f.thread("keep", "/other", 10);
        var remove = f.rollout("remove", null, false);
        f.sql("state_5.sqlite", "PRAGMA journal_mode=WAL");
        try (Connection reader = CodexStorageDatabase.open(f.root.resolve("state_5.sqlite"), true)) {
            CodexStorageDatabase.execute(reader, "BEGIN");
            assertEquals(2L, CodexStorageDatabase.scalar(reader, "SELECT count(*) FROM threads"));
            var result = f.service().deleteHistorySessions(List.of("remove"));
            assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
            assertFalse(Files.exists(remove));
            assertEquals(2L, CodexStorageDatabase.scalar(reader, "SELECT count(*) FROM threads"));
            CodexStorageDatabase.execute(reader, "ROLLBACK");
        }
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
    }

    @Test public void activeNativeDescendantBlocksTheWholeSelectedFamily() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        f.thread("child", "/project", 10);
        f.sql("state_5.sqlite", "INSERT INTO thread_spawn_edges(parent_thread_id,child_thread_id,status) VALUES('remove','child','completed')");
        var remove = f.rollout("remove", null, false);
        var locks = Files.createDirectory(f.root.resolve("thread-writer-locks"));
        try (var writer = CodexStorageFileLock.tryAcquire(f.paths, locks.resolve("child.lock"), true)) {
            assertNotNull(writer);
            var result = f.service().deleteHistorySessions(List.of("remove"));
            assertEquals(result.toString(), "FAILED_CLEAN", result.get("state").getAsString());
            assertEquals("SESSION_WRITER_BUSY", result.get("error").getAsString());
            assertTrue(Files.exists(remove));
            assertEquals(2L, f.count("state_5.sqlite", "threads"));
            assertEquals(2L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
            assertEquals(0, f.service().operations().size());
        }
    }

    @Test public void finishedHistoryDeletionIsNotAStorageMaintenanceReceipt() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        var result = f.service().deleteHistorySessions(List.of("remove"));
        assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
        assertEquals(0, f.service().operations().size());
    }

    @Test public void unfinishedHistoryMetadataRemainsRecoverableUntilBothDerivedStoresAreClean() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        String operationId = UUID.randomUUID().toString();
        var pending = f.service().deleteHistorySessions(List.of("remove"), operationId, true);
        assertEquals(pending.toString(), "PENDING", pending.getAsJsonObject("result").get("metadataStatus").getAsString());
        assertEquals(1, f.service().operations().size());
        var failed = f.service().finishMetadata(operationId, false);
        assertEquals("FAILED", failed.getAsJsonObject("result").get("metadataStatus").getAsString());
        assertEquals(1, f.service().operations().size());
        var completed = f.service().finishMetadata(operationId, true);
        assertEquals("COMPLETED", completed.get("state").getAsString());
        assertEquals(0, f.service().operations().size());
    }

    @Test public void batchHistoryDeletionIncludesArchivedAndDatabaseOnlyDescendants() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        for (String id : List.of("first", "second", "child", "keep")) {
            f.thread(id, "/project", 10);
        }
        f.sql("state_5.sqlite", "INSERT INTO thread_spawn_edges VALUES('first','child','completed')");
        var first = f.rollout("first", null, false);
        var archived = f.rollout("second", null, true);
        var keep = f.rollout("keep", null, false);
        var locks = Files.createDirectory(f.root.resolve("thread-writer-locks"));
        try (var writer = CodexStorageFileLock.tryAcquire(f.paths, locks.resolve("keep.lock"), true)) {
            assertNotNull(writer);
            var result = f.service().deleteHistorySessions(List.of("first", "second"));
            assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
            assertEquals(3, result.getAsJsonObject("result").getAsJsonArray("deletedSessionIds").size());
            assertFalse(Files.exists(first));
            assertFalse(Files.exists(archived));
            assertTrue(Files.exists(keep));
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
            assertEquals(0L, f.count("state_5.sqlite", "thread_spawn_edges"));
            assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
        }
    }

    @Test public void actualDatabaseWriterStillBlocksBeforeAnyFileOrDatabaseDeletion() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        var remove = f.rollout("remove", null, false);
        f.sql("state_5.sqlite", "PRAGMA journal_mode=WAL");
        try (Connection writer = CodexStorageDatabase.open(f.root.resolve("state_5.sqlite"), false)) {
            CodexStorageDatabase.execute(writer, "BEGIN IMMEDIATE");
            try {
                var result = f.service().deleteHistorySessions(List.of("remove"));
                assertEquals(result.toString(), "FAILED_CLEAN", result.get("state").getAsString());
                assertEquals("DATABASE_BUSY", result.get("error").getAsString());
                assertTrue(Files.exists(remove));
                assertEquals(1L, f.count("state_5.sqlite", "threads"));
                assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
            } finally {
                CodexStorageDatabase.execute(writer, "ROLLBACK");
            }
        }
    }

    @Test public void fullStorageMaintenanceStillRefusesAnOccupiedStoreBeforeCreatingAReceipt() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        var remove = f.rollout("remove", null, false);
        var locks = Files.createDirectory(f.root.resolve("thread-writer-locks"));
        try (var writer = CodexStorageFileLock.tryAcquire(f.paths, locks.resolve("other.lock"), true)) {
            assertNotNull(writer);
            String database = f.service().databaseStatus().get("databaseId").getAsString();
            var error = assertThrows(java.io.IOException.class,
                    () -> f.service().compact(database, UUID.randomUUID().toString()));
            assertEquals("SESSION_WRITER_BUSY", error.getMessage());
            assertTrue(Files.exists(remove));
            assertEquals(0, f.service().operations().size());
        }
    }

    @Test public void partialHistoryDeletionRemainsVisibleForRecoveryAndRetriesTheSameOperation() throws Exception {
        assertInterruptedHistoryCanRecover(false);
    }

    @Test public void storageRecoveryPreservesTheHistoryDeletionScopeWithAnUnrelatedNativeWriter() throws Exception {
        assertInterruptedHistoryCanRecover(true);
    }

    private void assertInterruptedHistoryCanRecover(boolean fromStorage) throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        f.thread("keep", "/other", 10);
        var remove = f.rollout("remove", null, false);
        var keep = f.rollout("keep", null, false);
        var locks = Files.createDirectory(f.root.resolve("thread-writer-locks"));
        try (var writer = CodexStorageFileLock.tryAcquire(f.paths, locks.resolve("keep.lock"), true)) {
            assertNotNull(writer);
            var interrupted = f.service(checkpoint -> {
                if (checkpoint.equals("database-commit")) {
                    throw new IllegalStateException("Simulated failure after a committed database");
                }
            }).deleteHistorySessions(List.of("remove"));
            assertEquals(interrupted.toString(), "RECONCILIATION_REQUIRED", interrupted.get("state").getAsString());
            assertTrue(Files.exists(remove));
            assertEquals(1, f.service().operations().size());
            var completed = fromStorage
                    ? f.service().deleteSessions(List.of("remove"), interrupted.get("operationId").getAsString(), false, true)
                    : f.service().deleteHistorySessions(List.of("remove"));
            if (fromStorage) {
                assertEquals(completed.toString(), "COMPLETED_WITH_WARNINGS", completed.get("state").getAsString());
                completed = f.service().finishMetadata(completed.get("operationId").getAsString(), true);
            }
            assertEquals(completed.toString(), "COMPLETED", completed.get("state").getAsString());
            assertEquals(interrupted.get("operationId"), completed.get("operationId"));
            assertFalse(Files.exists(remove));
            assertTrue(Files.exists(keep));
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
            assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
            assertEquals(0, f.service().operations().size());
        }
    }

    @Test public void nativeLogsSchemaWithoutTheLocalLoggingTriggerSupportsBothDeletionEntrypoints() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("history", "/project", 10);
        f.thread("storage", "/project", 10);
        f.sql("logs_2.sqlite", "DROP TRIGGER block_log_inserts");
        var history = f.service().deleteHistorySessions(List.of("history"));
        assertEquals(history.toString(), "COMPLETED", history.get("state").getAsString());
        var storage = f.service().deleteSessions(List.of("storage"), UUID.randomUUID().toString(), false);
        assertEquals(storage.toString(), "COMPLETED", storage.get("state").getAsString());
        assertEquals(0L, f.count("state_5.sqlite", "threads"));
    }

    @Test public void anUnknownLogsTriggerStillBlocksDeletionWithoutChangingAnySelectedData() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 10);
        var remove = f.rollout("remove", null, false);
        f.sql("logs_2.sqlite", "DROP TRIGGER block_log_inserts");
        f.sql("logs_2.sqlite", "CREATE TRIGGER unexpected_log_mutation AFTER DELETE ON logs BEGIN SELECT 1; END");
        var result = f.service().deleteHistorySessions(List.of("remove"));
        assertEquals(result.toString(), "FAILED_CLEAN", result.get("state").getAsString());
        assertEquals("DATABASE_SCHEMA_UNSUPPORTED", result.get("error").getAsString());
        assertTrue(Files.exists(remove));
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
        assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }
}
