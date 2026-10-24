package com.github.claudecodegui.storage;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.UUID;

import static org.junit.Assert.*;

public class CodexStorageOrphansTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void cleanupRemovesOnlyMissingRolloutHistoryThenReclaimsPhysicalSpace() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("orphan", "/project", 2 * 1024 * 1024);
        f.thread("keep", "/project", 200);
        f.thread("archive", "/project", 200);
        String emptyId = "00000000-0000-4000-8000-000000000001";
        f.thread(emptyId, "/project", 200);
        var keep = f.rollout("keep", "orphan", false);
        var archive = f.rollout("archive", null, true);
        var empty = f.rollout(emptyId, null, false);
        Files.writeString(empty, "");
        var preview = f.service().previewOrphans();
        assertEquals(1, preview.get("candidateCount").getAsInt());
        assertEquals(3, preview.get("retainedFileSessions").getAsInt());
        assertTrue(preview.get("estimatedBytes").getAsLong() > 2 * 1024 * 1024);
        String operationId = UUID.randomUUID().toString();
        var status = f.service().cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), operationId);
        assertEquals(status.toString(), "COMPLETED", status.get("state").getAsString());
        assertEquals(1, status.getAsJsonObject("result").get("cleanedSessionCount").getAsInt());
        assertTrue(status.getAsJsonObject("result").get("releasedBytes").getAsLong() > 1024 * 1024);
        assertEquals(3, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
        assertEquals(3, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_turns"));
        assertEquals(3, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_history_projection_state"));
        assertEquals(4, f.count("state_5.sqlite", "threads"));
        assertTrue(Files.exists(keep));
        assertTrue(Files.exists(archive));
        assertEquals(0, Files.size(empty));
        assertEquals(0, f.service().previewOrphans().get("candidateCount").getAsInt());
        assertEquals(status, f.service().cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), operationId));
        assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
    }

    @Test public void aNewFileBetweenPreviewAndConfirmationRejectsTheEntireCleanup() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("returning", "/project", 100);
        var preview = f.service().previewOrphans();
        f.rollout("returning", null, false);
        var status = f.service().cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), UUID.randomUUID().toString());
        assertEquals("FAILED_CLEAN", status.get("state").getAsString());
        assertEquals("ORPHAN_PREVIEW_EXPIRED", status.get("error").getAsString());
        assertEquals(1, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }

    @Test public void unidentifiedFilesBlockAbsenceClaimsButValidEmptyFilenamesDoNot() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("orphan", "/project", 100);
        var directory = Files.createDirectory(f.root.resolve("sessions"));
        var unknown = Files.writeString(directory.resolve("unknown.jsonl"), "");
        try {
            f.service().previewOrphans();
            fail("Unidentified files must prevent destructive absence claims");
        } catch (IOException error) {
            assertEquals("INVENTORY_INCOMPLETE", error.getMessage());
        }
        Files.delete(unknown);
        assertEquals(1, f.service().previewOrphans().get("candidateCount").getAsInt());
    }

    @Test public void registeredFilesOutsideTheScannedDirectoryArePreserved() throws Exception {
        var base = temporary.newFolder().toPath();
        var f = new CodexStorageFixture(base);
        f.thread("external", "/project", 100);
        var external = Files.writeString(base.resolve("existing.jsonl"), "history");
        try (Connection connection = CodexStorageDatabase.open(f.root.resolve("state_5.sqlite"), false);
             PreparedStatement statement = connection.prepareStatement("UPDATE threads SET rollout_path=? WHERE id=?")) {
            statement.setString(1, external.toString());
            statement.setString(2, "external");
            statement.executeUpdate();
        }
        var preview = f.service().previewOrphans();
        assertEquals(0, preview.get("candidateCount").getAsInt());
        assertEquals(1, preview.get("skippedExistingCount").getAsInt());
    }

    @Test public void nativeWindowsLongPathsPreserveExistingFilesAndAllowProvenMissingHistory() throws Exception {
        org.junit.Assume.assumeTrue(System.getProperty("os.name", "").startsWith("Windows"));
        var base = temporary.newFolder().toPath();
        var f = new CodexStorageFixture(base);
        f.thread("existing", "/project", 100);
        f.thread("missing", "/project", 100);
        var external = Files.writeString(base.resolve("existing.jsonl"), "history");
        try (Connection connection = CodexStorageDatabase.open(f.root.resolve("state_5.sqlite"), false);
             PreparedStatement statement = connection.prepareStatement("UPDATE threads SET rollout_path=? WHERE id=?")) {
            for (String id : java.util.List.of("existing", "missing")) {
                statement.setString(1, "\\\\?\\" + (id.equals("existing") ? external : base.resolve("missing.jsonl")));
                statement.setString(2, id);
                statement.executeUpdate();
            }
        }
        var preview = f.service().previewOrphans();
        assertEquals(1, preview.get("candidateCount").getAsInt());
        assertEquals(1, preview.get("skippedExistingCount").getAsInt());
        assertEquals("missing", preview.getAsJsonArray("candidates").get(0).getAsJsonObject().get("sessionId").getAsString());
        assertThrows(IOException.class, () -> CodexStoragePaths.declaredRolloutPath("\\\\?\\C:\\unsafe.\\history.jsonl"));
        assertThrows(IOException.class, () -> CodexStoragePaths.declaredRolloutPath("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\history.jsonl"));
    }

    @Test public void cleanupResumesAfterDeletionAndFinishesTheCompaction() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("orphan", "/project", 2 * 1024 * 1024);
        f.thread("keep", "/project", 100);
        f.rollout("keep", null, false);
        var preview = f.service().previewOrphans();
        String id = UUID.randomUUID().toString();
        var interrupted = f.service(checkpoint -> {
            if (checkpoint.equals("before-vacuum")) {
                throw new IllegalStateException("Simulated interruption");
            }
        }).cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), id);
        assertEquals("RECONCILIATION_REQUIRED", interrupted.get("state").getAsString());
        assertTrue(new CodexMaintenanceJournal(f.coordination).hasPending());
        var resumed = f.service().cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), id);
        assertEquals(resumed.toString(), "COMPLETED", resumed.get("state").getAsString());
        assertTrue(resumed.getAsJsonObject("result").get("releasedBytes").getAsLong() > 1024 * 1024);
        assertEquals(1, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
        assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
    }

    @Test public void restoredFileAfterAnInterruptionIsNeverDeletedOrCleanedAgain() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("orphan", "/project", 100);
        var preview = f.service().previewOrphans();
        String id = UUID.randomUUID().toString();
        f.service(checkpoint -> {
            if (checkpoint.equals("orphan-intent")) {
                throw new IllegalStateException("Simulated interruption");
            }
        }).cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), id);
        var restored = f.rollout("orphan", null, false);
        var status = f.service().cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), id);
        assertEquals("RECONCILIATION_REQUIRED", status.get("state").getAsString());
        assertEquals("ORPHAN_PREVIEW_EXPIRED", status.get("error").getAsString());
        assertTrue(Files.exists(restored));
        assertEquals(1, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }

    @Test public void lowCapacityRejectsCleanupBeforeRemovingAnyRows() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("orphan", "/project", 100);
        var preview = f.service().previewOrphans();
        var service = new CodexStorageMaintenance(f.paths, f.gate, f.coordination, path -> 0L, true, checkpoint -> { });
        var status = service.cleanOrphans(preview.get("databaseId").getAsString(), preview.get("previewToken").getAsString(), UUID.randomUUID().toString());
        assertEquals("FAILED_CLEAN", status.get("state").getAsString());
        assertEquals("INSUFFICIENT_DISK_SPACE", status.get("error").getAsString());
        assertEquals(1, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }

    @Test public void uppercaseEmptyRolloutProtectsItsDatabaseHistory() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        String id = "abcdefab-0000-4000-8000-000000000001";
        f.thread(id, "/project", 100);
        var directory = Files.createDirectory(f.root.resolve("sessions"));
        Files.createFile(directory.resolve("rollout-" + id.toUpperCase(java.util.Locale.ROOT) + ".JSONL"));
        var preview = f.service().previewOrphans();
        assertEquals(0, preview.get("candidateCount").getAsInt());
        assertEquals(1, preview.get("retainedFileSessions").getAsInt());
    }

    @Test public void aFileInPlaceOfTheSessionDirectoryCannotProveThatHistoryIsOrphaned() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("orphan", "/project", 100);
        Files.writeString(f.root.resolve("sessions"), "not a directory");
        try {
            f.service().previewOrphans();
            fail("The session directory must be readable");
        } catch (IOException error) {
            assertEquals("INVENTORY_INCOMPLETE", error.getMessage());
        }
        assertEquals(1, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }

    @Test public void ambiguousRelativeRegisteredPathsNeverAuthorizeCleanup() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("relative", "/project", 100);
        f.sql("state_5.sqlite", "UPDATE threads SET rollout_path='sessions/missing.jsonl'");
        try {
            f.service().previewOrphans();
            fail("Relative registered paths have no trusted absence proof");
        } catch (IOException error) {
            assertEquals("INVENTORY_INCOMPLETE", error.getMessage());
        }
        assertEquals(1, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }
}
