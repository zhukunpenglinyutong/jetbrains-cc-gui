package com.github.claudecodegui.storage;

import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.settings.AiDataMigrationCoordinator;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.sql.Connection;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.*;

public class CodexStorageMaintenanceTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private CodexStorageFixture fixture() throws Exception {
        return new CodexStorageFixture(temporary.newFolder().toPath());
    }

    @Test public void realSchemasAndPatchedNativeEngineAreAccepted() throws Exception {
        var fixture = fixture();
        for (String name : CodexStoragePaths.DATABASES) {
            try (Connection connection = CodexStorageDatabase.open(fixture.root.resolve(name), true)) {
                CodexStorageDatabase.requireSupported(connection, name);
                CodexStorageDatabase.checkIntegrity(connection);
            }
        }
        assertTrue(fixture.service().databaseStatus().get("supported").getAsBoolean());
    }

    @Test public void deletionRemovesDatabaseOnlyFamilyAndPreservesUnselectedStores() throws Exception {
        var f = fixture();
        f.thread("parent", "/first-project", 20000);
        f.thread("child", "/first-project", 20000);
        f.thread("keep", "/other-project", 20000);
        f.sql("state_5.sqlite", "INSERT INTO thread_spawn_edges VALUES('parent','child','completed')");
        f.sql("queue_1.sqlite", "INSERT INTO queued_items VALUES('queued','child','{}',1,1,1)");
        f.sql("memories_1.sqlite", "INSERT INTO stage1_outputs(thread_id,source_updated_at,raw_memory,rollout_summary,generated_at) VALUES('child',1,'memory','summary',1)");
        var childFile = f.rollout("child", "parent", true);
        var keepFile = f.rollout("keep", null, false);
        String id = UUID.randomUUID().toString();
        JsonObject result = f.service().deleteSessions(List.of("parent"), id, false);
        assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
        assertFalse(Files.exists(childFile));
        assertTrue(Files.exists(keepFile));
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
        assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
        assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_turns"));
        assertEquals(0L, f.count("queue_1.sqlite", "queued_items"));
        assertEquals(0L, f.count("queue_1.sqlite", "queued_thread_revisions"));
        assertEquals(0L, f.count("memories_1.sqlite", "stage1_outputs"));
        assertEquals(result, f.service().deleteSessions(List.of("parent"), id, false));
        assertEquals(1L, new CodexStorageInventory(f.paths).snapshot().sessions().size());
        assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
    }

    @Test public void unknownSchemaRejectsBeforeAnyRolloutDeletion() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 100);
        var rollout = f.rollout("selected", null, false);
        f.sql("goals_1.sqlite", "CREATE TABLE new_owned_store(thread_id TEXT)");
        var result = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
        assertEquals("FAILED_CLEAN", result.get("state").getAsString());
        assertEquals("DATABASE_SCHEMA_UNSUPPORTED", result.get("error").getAsString());
        assertTrue(Files.exists(rollout));
        assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }

    @Test public void ambiguousMemoryJobBlocksTheEntireDelete() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 10);
        f.sql("memories_1.sqlite", "INSERT INTO jobs(kind,job_key,status,retry_remaining) VALUES('unknown','selected','pending',1)");
        var result = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
        assertEquals("DATABASE_DEPENDENCY_UNSUPPORTED", result.get("error").getAsString());
        assertEquals("FAILED_CLEAN", result.get("state").getAsString());
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
    }

    @Test public void actualRunningSessionCannotBeDeletedAndIdleOpenSessionCan() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 10);
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setRestoredSessionId("selected");
        CodexStorageActivity.register(state);
        Object owner = state.beginTurn();
        try {
            var blocked = assertThrows(IOException.class, () -> f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false));
            assertEquals("SESSION_RUNNING", blocked.getMessage());
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
            assertEquals(0, f.service().operations().size());
        } finally {
            state.setBusy(false);
        }
        assertTrue(state.isCurrentTurn(owner));
        var deleted = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
        assertEquals(deleted.toString(), "COMPLETED", deleted.get("state").getAsString());
    }

    @Test public void idleResidentProcessDoesNotBlockMaintenance() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 10);
        try (var permit = f.gate.acquireProcessPermit()) {
            var result = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
            assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
        }
        assertEquals(0L, f.count("state_5.sqlite", "threads"));
    }

    @Test public void aRunningDifferentSessionDoesNotDisableDeletingIdleHistoryFromStorage() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 10);
        f.thread("running", "/other-project", 10);
        var selected = f.rollout("selected", null, false);
        var kept = f.rollout("running", null, false);
        String content = Files.readString(kept);
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setRestoredSessionId("running");
        CodexStorageActivity.register(state);
        Object turn = state.beginTurn();
        try {
            var status = f.service().mutationStatus();
            assertEquals("SESSION_RUNNING", status.get("unavailableReason").getAsString());
            assertTrue(status.get("deletionAvailable").getAsBoolean());
            assertEquals("[\"running\"]", status.getAsJsonArray("runningSessionIds").toString());
            var result = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
            assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
            assertFalse(Files.exists(selected));
            assertEquals(content, Files.readString(kept));
            assertTrue(state.isBusy());
            assertTrue(state.isCurrentTurn(turn));
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
        } finally {
            state.setBusy(false);
        }
    }

    @Test public void storageDeletionProtectsTheEntireFamilyOfAnOccupiedDatabaseOnlyDescendant() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 10);
        f.thread("child", "/project", 10);
        f.sql("state_5.sqlite", "INSERT INTO thread_spawn_edges VALUES('selected','child','completed')");
        var selected = f.rollout("selected", null, false);
        String content = Files.readString(selected);
        var locks = Files.createDirectories(f.root.resolve("thread-writer-locks"));
        try (var writer = CodexStorageFileLock.tryAcquire(f.paths, locks.resolve("child.lock"), true)) {
            assertNotNull(writer);
            var result = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
            assertEquals(result.toString(), "FAILED_CLEAN", result.get("state").getAsString());
            assertEquals("SESSION_WRITER_BUSY", result.get("error").getAsString());
            assertEquals(content, Files.readString(selected));
            assertEquals(2L, f.count("state_5.sqlite", "threads"));
            assertEquals(1L, f.count("state_5.sqlite", "thread_spawn_edges"));
            assertEquals(2L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
        }
    }

    @Test public void directoryMigrationStillBlocksMaintenance() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 10);
        try (var permit = f.gate.tryAcquireMigrationPermit()) {
            assertNotNull(permit);
            IOException error = assertThrows(IOException.class,
                    () -> f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false));
            assertEquals("DATABASE_BUSY", error.getMessage());
        }
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
    }

    @Test public void crossJvmMigrationAndMaintenanceUseDifferentLocks() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 10);
        try (var migration = new AiDataMigrationCoordinator(f.coordination).tryAcquire("migrate")) {
            assertNotNull(migration);
            assertEquals("DATABASE_BUSY", assertThrows(IOException.class,
                    () -> f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false)).getMessage());
        }
        try (var otherMaintenance = new AiDataMigrationCoordinator(f.coordination.resolve("codex-storage-lock")).tryAcquire("codex-storage")) {
            assertNotNull(otherMaintenance);
            assertEquals("DATABASE_BUSY", assertThrows(IOException.class,
                    () -> f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false)).getMessage());
        }
        var result = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
        assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
    }

    @Test public void deletionRecognizesNativeWindowsLongRolloutPath() throws Exception {
        org.junit.Assume.assumeTrue(System.getProperty("os.name", "").startsWith("Windows"));
        var f = fixture();
        f.thread("selected", "/project", 10);
        var rollout = f.rollout("selected", null, false);
        try (var connection = CodexStorageDatabase.open(f.root.resolve("state_5.sqlite"), false);
             var statement = connection.prepareStatement("UPDATE threads SET rollout_path=? WHERE id='selected'")) {
            statement.setString(1, "\\\\?\\" + rollout);
            statement.executeUpdate();
        }
        var result = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
        assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
        assertFalse(Files.exists(rollout));
    }

    @Test public void readsRemainAvailableDuringARealTurnAndWalWriter() throws Exception {
        var f = fixture();
        f.thread("running", "/running", 10);
        f.thread("idle", "/idle", 10);
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.setRestoredSessionId("running");
        CodexStorageActivity.register(state);
        state.beginTurn();
        try (var process = f.gate.acquireProcessPermit();
             var writer = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), false)) {
            CodexStorageDatabase.execute(writer, "PRAGMA journal_mode=WAL");
            CodexStorageDatabase.execute(writer, "BEGIN IMMEDIATE");
            try {
                assertTrue(f.service().databaseStatus().get("supported").getAsBoolean());
                var inventory = new CodexStorageInventory(f.paths);
                var snapshot = inventory.snapshot();
                assertTrue(snapshot.errors().toString(), snapshot.errors().isEmpty());
                assertEquals(2, snapshot.sessions().size());
                assertTrue(snapshot.sessions().get("running").running);
                assertFalse(snapshot.sessions().get("idle").running);
                assertFalse(inventory.content("idle", null, 10).getAsJsonArray("records").isEmpty());
            } finally {
                CodexStorageDatabase.execute(writer, "ROLLBACK");
            }
        } finally {
            state.setBusy(false);
        }
    }

    @Test public void nativeWriterContentionNeverDeletesRollouts() throws Exception {
        var f = fixture();
        f.thread("selected", "/project", 10);
        var file = f.rollout("selected", null, false);
        try (var process = f.gate.acquireProcessPermit();
             Connection writer = CodexStorageDatabase.open(f.root.resolve("state_5.sqlite"), false)) {
            CodexStorageDatabase.execute(writer, "BEGIN IMMEDIATE");
            var result = f.service().deleteSessions(List.of("selected"), UUID.randomUUID().toString(), false);
            assertEquals(result.toString(), "FAILED_CLEAN", result.get("state").getAsString());
            assertEquals("DATABASE_BUSY", result.get("error").getAsString());
            assertTrue(Files.exists(file));
            CodexStorageDatabase.execute(writer, "ROLLBACK");
        }
    }

    @Test public void compactionReclaimsDeletedPayloadWithoutChangingRemainingContent() throws Exception {
        var f = fixture();
        f.thread("remove", "/first", 2 * 1024 * 1024);
        f.thread("keep", "/second", 1000);
        assertEquals("COMPLETED", f.service().deleteSessions(List.of("remove"), UUID.randomUUID().toString(), false).get("state").getAsString());
        String digest;
        try (Connection connection = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), true)) {
            digest = CodexStorageDatabase.contentDigest(connection);
        }
        var service = f.service();
        var result = service.compact(service.databaseStatus().get("databaseId").getAsString(), UUID.randomUUID().toString());
        assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
        assertTrue(result.getAsJsonObject("result").get("releasedBytes").getAsLong() > 1024 * 1024);
        try (Connection connection = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), true)) {
            assertEquals(digest, CodexStorageDatabase.contentDigest(connection));
        }
    }

    @Test public void insufficientCapacityIsCleanAndDoesNotDeleteSessions() throws Exception {
        var f = fixture();
        f.thread("keep", "/project", 100);
        var service = new CodexStorageMaintenance(f.paths, f.gate, f.coordination, path -> 0, true, checkpoint -> { });
        var result = service.compact(service.databaseStatus().get("databaseId").getAsString(), UUID.randomUUID().toString());
        assertEquals("FAILED_CLEAN", result.get("state").getAsString());
        assertEquals("INSUFFICIENT_DISK_SPACE", result.get("error").getAsString());
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
        assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
    }

    @Test public void interruptedDeleteKeepsAdmissionClosedUntilSameScopeFinishes() throws Exception {
        var f = fixture();
        f.thread("remove", "/first", 1000);
        f.thread("keep", "/second", 1000);
        var file = f.rollout("remove", null, false);
        String id = UUID.randomUUID().toString();
        try {
            f.service(checkpoint -> { if (checkpoint.equals("database-commit")) { throw new SimulatedCrash(); } })
                    .deleteSessions(List.of("remove"), id, false);
            fail("Expected crash");
        } catch (SimulatedCrash expected) { }
        assertTrue(new CodexMaintenanceJournal(f.coordination).hasPending());
        assertTrue(Files.exists(file));
        try {
            new AiDataMigrationCoordinator(f.coordination).tryAcquireProcessLock();
            fail("Restarted IDE must not admit work");
        } catch (IOException error) {
            assertEquals("AI_DATA_MAINTENANCE_PENDING", error.getMessage());
        }
        var result = f.service().deleteSessions(List.of("remove"), id, false);
        assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
        assertFalse(Files.exists(file));
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
        try (var admitted = new AiDataMigrationCoordinator(f.coordination).tryAcquireProcessLock()) {
            assertNotNull(admitted);
        }
    }

    @Test public void operationIdCannotBindAnotherScope() throws Exception {
        var f = fixture();
        f.thread("first", "/first", 100);
        f.thread("second", "/second", 100);
        String id = UUID.randomUUID().toString();
        f.service().deleteSessions(List.of("first"), id, false);
        try {
            f.service().deleteSessions(List.of("second"), id, false);
            fail("Expected conflict");
        } catch (IOException error) {
            assertEquals("OPERATION_ID_CONFLICT", error.getMessage());
        }
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
    }

    private static class SimulatedCrash extends Error { }
}
