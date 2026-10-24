package com.github.claudecodegui.storage;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.*;

public class CodexStorageMaintenanceWalTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void idleWalConnectionAllowsOrphanCleanupAndPhysicalCompaction() throws Exception {
        var f = fixture();
        f.thread("orphan", "/project", 2 * 1024 * 1024);
        f.thread("keep", "/project", 200);
        var kept = f.rollout("keep", null, false);
        String rollout = Files.readString(kept);
        try (Connection resident = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), false)) {
            assertEquals(2L, CodexStorageDatabase.scalar(resident, "SELECT count(*) FROM thread_items"));
            var service = f.service();
            assertTrue(service.mutationStatus().get("available").getAsBoolean());
            JsonObject preview = service.previewOrphans();
            JsonObject status = service.cleanOrphans(preview.get("databaseId").getAsString(),
                    preview.get("previewToken").getAsString(), UUID.randomUUID().toString());
            assertEquals(status.toString(), "COMPLETED", status.get("state").getAsString());
            assertEquals(1L, CodexStorageDatabase.scalar(resident, "SELECT count(*) FROM thread_items"));
            assertEquals(1, status.getAsJsonObject("result").get("cleanedSessionCount").getAsInt());
            assertTrue(status.toString(), status.getAsJsonObject("result").get("releasedBytes").getAsLong() > 1024 * 1024);
            assertEquals(rollout, Files.readString(kept));
            assertEquals(2L, f.count("state_5.sqlite", "threads"));
            assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
        }
    }

    @Test public void idleReadOnlyWalConnectionAllowsCompactionWithoutChangingContent() throws Exception {
        var f = fixture();
        f.thread("remove", "/project", 2 * 1024 * 1024);
        f.thread("keep", "/project", 200);
        var service = f.service();
        assertEquals("COMPLETED", service.deleteSessions(List.of("remove"), UUID.randomUUID().toString(), false).get("state").getAsString());
        try (Connection resident = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), true)) {
            String digest = CodexStorageDatabase.contentDigest(resident);
            assertTrue(service.mutationStatus().get("available").getAsBoolean());
            JsonObject status = service.compact(service.databaseStatus().get("databaseId").getAsString(), UUID.randomUUID().toString());
            assertEquals(status.toString(), "COMPLETED", status.get("state").getAsString());
            assertEquals(digest, CodexStorageDatabase.contentDigest(resident));
            assertTrue(status.toString(), status.getAsJsonObject("result").get("releasedBytes").getAsLong() > 1024 * 1024);
            assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
        }
    }

    @Test public void activeWalWriterRejectsCleanupBeforeRemovingRows() throws Exception {
        var f = fixture();
        f.thread("orphan", "/project", 100);
        var service = f.service();
        JsonObject preview = service.previewOrphans();
        try (Connection writer = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), false)) {
            CodexStorageDatabase.execute(writer, "BEGIN IMMEDIATE");
            try {
                JsonObject status = service.cleanOrphans(preview.get("databaseId").getAsString(),
                        preview.get("previewToken").getAsString(), UUID.randomUUID().toString());
                assertCleanBusy(f, status);
                assertEquals(1L, CodexStorageDatabase.scalar(writer, "SELECT count(*) FROM thread_items"));
            } finally {
                CodexStorageDatabase.execute(writer, "ROLLBACK");
            }
        }
    }

    @Test public void activeWalWriterRejectsCompactionBeforeMutation() throws Exception {
        var f = fixture();
        f.thread("keep", "/project", 100);
        var service = f.service();
        String databaseId = service.databaseStatus().get("databaseId").getAsString();
        try (Connection writer = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), false)) {
            CodexStorageDatabase.execute(writer, "BEGIN IMMEDIATE");
            try {
                assertCleanBusy(f, service.compact(databaseId, UUID.randomUUID().toString()));
            } finally {
                CodexStorageDatabase.execute(writer, "ROLLBACK");
            }
        }
    }

    @Test public void pinnedReadSnapshotDefersWalReclamationWithoutLeavingMaintenancePending() throws Exception {
        var f = fixture();
        f.thread("orphan", "/project", 2 * 1024 * 1024);
        f.thread("keep", "/project", 200);
        f.rollout("keep", null, false);
        var service = f.service();
        JsonObject preview = service.previewOrphans();
        String databaseId = preview.get("databaseId").getAsString();
        try (Connection reader = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), true)) {
            CodexStorageDatabase.execute(reader, "BEGIN");
            try {
                assertEquals(2L, CodexStorageDatabase.scalar(reader, "SELECT count(*) FROM thread_items"));
                JsonObject status = service.cleanOrphans(databaseId, preview.get("previewToken").getAsString(), UUID.randomUUID().toString());
                assertEquals(status.toString(), "COMPLETED_WITH_WARNINGS", status.get("state").getAsString());
                assertEquals("WAL_SPACE_RETAINED", status.getAsJsonObject("result").get("warning").getAsString());
                assertEquals(2L, CodexStorageDatabase.scalar(reader, "SELECT count(*) FROM thread_items"));
                assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
                assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
            } finally {
                CodexStorageDatabase.execute(reader, "ROLLBACK");
            }
            JsonObject compacted = service.compact(databaseId, UUID.randomUUID().toString());
            assertEquals(compacted.toString(), "COMPLETED", compacted.get("state").getAsString());
            assertTrue(compacted.toString(), compacted.getAsJsonObject("result").get("releasedBytes").getAsLong() > 1024 * 1024);
            assertEquals(1L, CodexStorageDatabase.scalar(reader, "SELECT count(*) FROM thread_items"));
        }
    }

    @Test public void cleanupReservesWritesWhileValidatingAndDeletingOrphans() throws Exception {
        var f = fixture();
        f.thread("orphan", "/project", 100);
        JsonObject preview = f.service().previewOrphans();
        var checked = new java.util.concurrent.atomic.AtomicBoolean();
        var service = f.service(checkpoint -> {
            if (checkpoint.equals("orphan-intent")) {
                SQLException error = assertThrows(SQLException.class, () -> {
                    try (Connection writer = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), false)) {
                        CodexStorageDatabase.execute(writer, "BEGIN IMMEDIATE");
                    }
                });
                assertEquals("DATABASE_BUSY", CodexStorageMaintenance.errorCode(error));
                checked.set(true);
            }
        });
        JsonObject status = service.cleanOrphans(preview.get("databaseId").getAsString(),
                preview.get("previewToken").getAsString(), UUID.randomUUID().toString());
        assertEquals(status.toString(), "COMPLETED", status.get("state").getAsString());
        assertTrue(checked.get());
    }

    private CodexStorageFixture fixture() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.sql(CodexStoragePaths.HISTORY_DATABASE, "PRAGMA journal_mode=WAL");
        return f;
    }

    private static void assertCleanBusy(CodexStorageFixture f, JsonObject status) throws Exception {
        assertEquals(status.toString(), "FAILED_CLEAN", status.get("state").getAsString());
        assertEquals("DATABASE_BUSY", status.get("error").getAsString());
        assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
    }
}
