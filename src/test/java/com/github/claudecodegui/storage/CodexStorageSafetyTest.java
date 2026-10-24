package com.github.claudecodegui.storage;

import com.github.claudecodegui.settings.AiDataMigrationCoordinator;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.*;

public class CodexStorageSafetyTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void replacedDatabaseCannotUseAnEarlierRegisteredIdentity() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("keep", "/project", 100);
        var service = f.service();
        String registered = service.databaseStatus().get("databaseId").getAsString();
        var source = f.root.resolve(CodexStoragePaths.HISTORY_DATABASE);
        var original = source.resolveSibling("fixture-original");
        Files.move(source, original);
        Files.copy(original, source);
        try {
            service.compact(registered, UUID.randomUUID().toString());
            fail("A replacement must require refreshed registration");
        } catch (IOException error) { assertEquals("STORAGE_IDENTITY_CHANGED", error.getMessage()); }
        assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }

    @Test public void anUncoveredDeclaredRolloutBlocksAllMutation() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 100);
        var file = f.rollout("remove", null, false);
        var outside = temporary.newFolder().toPath().toRealPath().resolve("undeclared.jsonl");
        try (var connection = CodexStorageDatabase.open(f.root.resolve("state_5.sqlite"), false);
             var statement = connection.prepareStatement("UPDATE threads SET rollout_path=? WHERE id='remove'")) {
            statement.setString(1, outside.toString());
            statement.executeUpdate();
        }
        var result = f.service().deleteSessions(List.of("remove"), UUID.randomUUID().toString(), false);
        assertEquals("FAILED_CLEAN", result.get("state").getAsString());
        assertEquals("DATABASE_DEPENDENCY_UNSUPPORTED", result.get("error").getAsString());
        assertTrue(Files.exists(file));
        assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
    }

    @Test public void aMissingPendingReceiptCannotBeReplacedByANewClaim() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        var journal = new CodexMaintenanceJournal(f.coordination);
        String id = UUID.randomUUID().toString();
        journal.claim(id, "DELETE_SESSIONS", f.paths, List.of("remove"), false);
        Files.delete(f.coordination.resolve("codex-maintenance").resolve(id + ".json"));
        assertTrue(journal.hasPending());
        try {
            journal.claim(UUID.randomUUID().toString(), "DELETE_SESSIONS", f.paths, List.of("other"), false);
            fail("Missing receipts must fail closed");
        } catch (IOException error) { assertEquals("MAINTENANCE_RECONCILIATION_REQUIRED", error.getMessage()); }
        try {
            new AiDataMigrationCoordinator(f.coordination).tryAcquireProcessLock();
            fail("A restarted admission must also remain closed");
        } catch (IOException error) { assertEquals("AI_DATA_MAINTENANCE_PENDING", error.getMessage()); }
    }

    @Test public void retainedTombstonesCannotExecuteAgainOrResumeDeletedSessions() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 100);
        f.thread("keep", "/other", 100);
        String id = UUID.randomUUID().toString();
        f.service().deleteSessions(List.of("remove"), id, false);
        var journal = new CodexMaintenanceJournal(f.coordination);
        var old = journal.get(id);
        old.addProperty("updatedAt", java.time.Instant.now().minus(java.time.Duration.ofDays(31)).toString());
        journal.save(old);
        var claim = journal.claim(UUID.randomUUID().toString(), "DELETE_SESSIONS", f.paths, List.of("missing"), false);
        journal.state(claim, "CANCELLED_CLEAN");
        assertTrue(journal.get(id).get("tombstone").getAsBoolean());
        assertFalse(journal.get(id).has("files"));
        assertEquals("COMPLETED", f.service().deleteSessions(List.of("remove"), id, false).get("state").getAsString());
        assertEquals(1L, f.count("state_5.sqlite", "threads"));
        try {
            journal.requireSessionAvailable(f.paths, "remove");
            fail("Retiring detail must keep the deletion identity");
        } catch (IOException error) { assertEquals("SESSION_PERMANENTLY_DELETED", error.getMessage()); }
    }

    @Test public void metadataFailuresAreDurableAndRetryOnlyDerivedCleanup() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/project", 100);
        String id = UUID.randomUUID().toString();
        var status = f.service().deleteSessions(List.of("remove"), id, false, true);
        assertEquals("COMPLETED_WITH_WARNINGS", status.get("state").getAsString());
        assertEquals("PENDING", status.getAsJsonObject("result").get("metadataStatus").getAsString());
        assertFalse(new CodexMaintenanceJournal(f.coordination).hasPending());
        status = f.service().finishMetadata(id, false);
        assertEquals("METADATA_CLEANUP_FAILED", status.getAsJsonObject("result").get("warning").getAsString());
        status = f.service().finishMetadata(id, true);
        assertEquals("COMPLETED", status.get("state").getAsString());
        assertEquals("COMPLETE", f.service().operation(id).getAsJsonObject("result").get("metadataStatus").getAsString());
        assertEquals(0L, f.count("state_5.sqlite", "threads"));
    }
}
