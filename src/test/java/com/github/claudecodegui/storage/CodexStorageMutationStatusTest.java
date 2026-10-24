package com.github.claudecodegui.storage;

import com.github.claudecodegui.session.SessionState;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.*;

public class CodexStorageMutationStatusTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void idleResidentProcessesAndUnlockedFilesDoNotDisableStorageOrCreateNativeLockFiles() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        try (var permit = f.gate.acquireProcessPermit()) {
            assertAvailable(f.service().mutationStatus());
            assertFalse(Files.exists(f.root.resolve(".tmp")));
            assertFalse(Files.exists(f.root.resolve("thread-writer-locks")));
            var locks = Files.createDirectory(f.root.resolve("thread-writer-locks"));
            Files.writeString(locks.resolve("stale.lock"), "idle");
            assertAvailable(f.service().mutationStatus());
            assertEquals("idle", Files.readString(locks.resolve("stale.lock")));
        }
    }

    @Test public void aNewCodexTurnBlocksMaintenanceWhileUnrelatedHistoryCanStillBeDeleted() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("idle", "/other-project", 10);
        var rollout = f.rollout("idle", null, false);
        var service = f.service();
        var preview = service.previewOrphans();
        SessionState state = new SessionState();
        state.setProvider("codex");
        CodexStorageActivity.register(state);
        state.beginTurn();
        assertNull(state.getSessionId());
        try {
            assertUnavailable(service.mutationStatus(), "SESSION_RUNNING");
            assertDeletionAvailable(service.mutationStatus());
            assertEquals("SESSION_RUNNING", assertThrows(IOException.class,
                    () -> service.compact(preview.get("databaseId").getAsString(), UUID.randomUUID().toString())).getMessage());
            assertEquals("SESSION_RUNNING", assertThrows(IOException.class,
                    () -> service.cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), UUID.randomUUID().toString())).getMessage());
            assertTrue(Files.exists(rollout));
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
            assertEquals(0, service.operations().size());
            assertEquals("COMPLETED", service.deleteSessions(List.of("idle"), UUID.randomUUID().toString(), false).get("state").getAsString());
            assertFalse(Files.exists(rollout));
            assertEquals(0L, f.count("state_5.sqlite", "threads"));
        } finally {
            state.setBusy(false);
        }
        assertAvailable(service.mutationStatus());
    }

    @Test public void anUnrelatedNativeWriterDisablesOnlyMaintenanceAndIsNeverReleasedByAnAdmissionProbe() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("idle", "/project", 10);
        f.thread("other", "/other", 10);
        var rollout = f.rollout("idle", null, false);
        var keep = f.rollout("other", null, false);
        var locks = Files.createDirectory(f.root.resolve("thread-writer-locks"));
        var writerFile = locks.resolve("other.lock");
        assertAvailable(f.service().mutationStatus());
        try (var writer = CodexStorageFileLock.tryAcquire(f.paths, writerFile, true)) {
            assertNotNull(writer);
            for (int attempt = 0; attempt < 2; attempt++) {
                var status = f.service().mutationStatus();
                assertUnavailable(status, "SESSION_WRITER_BUSY");
                assertDeletionAvailable(status);
                assertEquals("[\"other\"]", status.getAsJsonArray("writerSessionIds").toString());
                assertTrue(status.getAsJsonArray("runningSessionIds").isEmpty());
            }
            var database = f.service().databaseStatus().get("databaseId").getAsString();
            assertEquals("SESSION_WRITER_BUSY", assertThrows(IOException.class,
                    () -> f.service().compact(database, UUID.randomUUID().toString())).getMessage());
            assertEquals("COMPLETED", f.service().deleteSessions(List.of("idle"), UUID.randomUUID().toString(), false).get("state").getAsString());
            assertTrue(Files.exists(writerFile));
            assertFalse(Files.exists(rollout));
            assertTrue(Files.exists(keep));
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
            assertNull(CodexStorageFileLock.tryAcquire(f.paths, writerFile, false));
        }
        assertAvailable(f.service().mutationStatus());
    }

    @Test public void anOwnedQuestionWaitStillDisablesStorageEvenWhenTheUiBusyFlagHasBeenCleared() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        SessionState state = new SessionState();
        state.setProvider("codex");
        state.beginTurn();
        state.setBusy(false);
        var answer = new java.util.concurrent.CompletableFuture<Void>();
        var execution = state.getExecutionState();
        execution.bindInteraction(execution.currentTurn(), com.github.claudecodegui.session.SessionExecutionState.WaitReason.QUESTION, answer);
        CodexStorageActivity.register(state);
        try {
            assertUnavailable(f.service().mutationStatus(), "SESSION_RUNNING");
            assertDeletionAvailable(f.service().mutationStatus());
        } finally {
            answer.complete(null);
            state.setBusy(false);
        }
        assertAvailable(f.service().mutationStatus());
        SessionState claude = new SessionState();
        claude.setProvider("claude");
        claude.beginTurn();
        CodexStorageActivity.register(claude);
        try {
            assertAvailable(f.service().mutationStatus());
        } finally {
            claude.setBusy(false);
        }
    }

    @Test public void nativePublicationAndDirectoryMigrationDisableStorageUntilTheirOwnersFinish() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        var temporaryDirectory = Files.createDirectory(f.root.resolve(".tmp"));
        var lockFile = temporaryDirectory.resolve("rollout-maintenance.lock");
        try (var publication = CodexStorageFileLock.tryAcquire(f.paths, lockFile, true)) {
            assertNotNull(publication);
            assertUnavailable(f.service().mutationStatus(), "DATABASE_BUSY");
            assertUnavailable(f.service().mutationStatus(), "DATABASE_BUSY");
            assertDeletionUnavailable(f.service().mutationStatus(), "DATABASE_BUSY");
            assertTrue(Files.exists(lockFile));
        }
        assertAvailable(f.service().mutationStatus());
        try (var migration = f.gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
            assertUnavailable(f.service().mutationStatus(), "DATABASE_BUSY");
            assertDeletionUnavailable(f.service().mutationStatus(), "DATABASE_BUSY");
        }
        assertAvailable(f.service().mutationStatus());
    }

    private static void assertAvailable(JsonObject status) {
        assertTrue(status.toString(), status.get("available").getAsBoolean());
        assertFalse(status.has("unavailableReason"));
        assertDeletionAvailable(status);
        assertTrue(status.getAsJsonArray("runningSessionIds").isEmpty());
        assertTrue(status.getAsJsonArray("writerSessionIds").isEmpty());
    }

    private static void assertUnavailable(JsonObject status, String reason) {
        assertFalse(status.toString(), status.get("available").getAsBoolean());
        assertEquals(reason, status.get("unavailableReason").getAsString());
    }

    private static void assertDeletionAvailable(JsonObject status) {
        assertTrue(status.toString(), status.get("deletionAvailable").getAsBoolean());
        assertFalse(status.has("deletionUnavailableReason"));
    }

    private static void assertDeletionUnavailable(JsonObject status, String reason) {
        assertFalse(status.toString(), status.get("deletionAvailable").getAsBoolean());
        assertEquals(reason, status.get("deletionUnavailableReason").getAsString());
    }
}
