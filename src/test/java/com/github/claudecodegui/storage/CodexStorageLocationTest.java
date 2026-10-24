package com.github.claudecodegui.storage;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public class CodexStorageLocationTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void resolvesNestedAndArchivedFilesUnderTheConfiguredPhysicalRoot() throws Exception {
        var fixture = new CodexStorageFixture(temporary.newFolder("migrated home").toPath());
        var active = fixture.rollout("active", null, false);
        var nested = Files.createDirectories(active.getParent().resolve("2026/10/23")).resolve(active.getFileName());
        Files.move(active, nested);
        var archived = fixture.rollout("archive", null, true);
        var inventory = new CodexStorageInventory(fixture.paths);
        assertEquals(nested.toRealPath(), inventory.sessionFile("active"));
        assertEquals(archived.toRealPath(), inventory.sessionFile("archive"));
    }

    @Test public void rejectsDeletedAndDatabaseOnlySessionsInsteadOfRevealingAnotherLocation() throws Exception {
        var fixture = new CodexStorageFixture(temporary.newFolder().toPath());
        fixture.thread("database-only", "/project", 100);
        var deleted = fixture.rollout("deleted", null, false);
        var inventory = new CodexStorageInventory(fixture.paths);
        assertEquals(deleted.toRealPath(), inventory.sessionFile("deleted"));
        Files.delete(deleted);
        for (String id : new String[] {"deleted", "database-only", "unknown"}) {
            assertEquals("SESSION_FILE_NOT_FOUND", assertThrows(IOException.class, () -> inventory.sessionFile(id)).getMessage());
        }
    }

    @Test public void rejectsPathsSuppliedInPlaceOfSessionIdentifiers() throws Exception {
        var fixture = new CodexStorageFixture(temporary.newFolder().toPath());
        fixture.rollout("valid", null, false);
        var inventory = new CodexStorageInventory(fixture.paths);
        for (String id : new String[] {"../valid", "sessions/valid.jsonl", "C:\\outside\\file.jsonl", ".."}) {
            assertEquals("INVALID_SESSION_ID", assertThrows(IOException.class, () -> inventory.sessionFile(id)).getMessage());
        }
    }
}
