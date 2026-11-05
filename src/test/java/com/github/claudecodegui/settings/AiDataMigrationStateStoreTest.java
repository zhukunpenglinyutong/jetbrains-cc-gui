package com.github.claudecodegui.settings;

import com.github.claudecodegui.settings.AiDataDirectoryManager.AiDataDirectoryException;
import com.github.claudecodegui.settings.AiDataDirectoryManager.SourceKind;
import com.github.claudecodegui.settings.AiDataMigrationStateStore.Journal;
import com.github.claudecodegui.settings.AiDataMigrationStateStore.MigrationEntry;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

/** Verifies ownership checks and durable failure handling independently of migration orchestration. */
public class AiDataMigrationStateStoreTest {
    @Rule
    public final TemporaryFolder folder = new TemporaryFolder();

    private Path home;
    private Path state;
    private AiDataMigrationStateStore store;

    @Before
    public void setUp() throws Exception {
        home = folder.newFolder("home").toPath();
        state = folder.newFolder("state").toPath();
        store = new AiDataMigrationStateStore(home, state);
    }

    @Test
    public void rejectsAReplacedJournalPathBeforeTouchingItsTarget() throws Exception {
        String operation = UUID.randomUUID().toString();
        Path target = folder.getRoot().toPath().resolve("target");
        MigrationEntry entry = new MigrationEntry("codex", home.resolve(".codex"), target.resolve(".codex"),
                target.resolve(".cc-gui-migration-" + operation + "-codex"),
                home.resolve(".codex.cc-gui-backup-1-" + operation), home.resolve(".codex"), SourceKind.LOCAL, false);
        Journal journal = new Journal(operation, List.of(entry));
        store.writeJournal(journal);
        assertEquals(operation, store.readJournal().operationId);
        Path unrelated = Files.writeString(folder.getRoot().toPath().resolve("unrelated"), "keep");
        entry.backup = unrelated.toString();
        store.writeJournal(journal);

        AiDataDirectoryException failure = assertThrows(AiDataDirectoryException.class, store::readJournal);

        assertEquals("MIGRATION_JOURNAL_INVALID", failure.getMessage());
        assertEquals("keep", Files.readString(unrelated));
    }

    @Test
    public void rejectsUnownedBackupMetadataWithoutDeletingTheNamedFile() throws Exception {
        Path unrelated = Files.writeString(folder.getRoot().toPath().resolve("unowned-data"), "keep");
        JsonObject record = new JsonObject();
        record.addProperty("id", "codex");
        record.addProperty("operationId", UUID.randomUUID().toString());
        record.addProperty("path", unrelated.toString());

        AiDataDirectoryException failure = assertThrows(AiDataDirectoryException.class, () -> store.validateBackupRecord(record));

        assertEquals("BACKUP_PATH_INVALID", failure.getMessage());
        assertEquals("keep", Files.readString(unrelated));
    }

    @Test
    public void retainsMalformedMetadataInQuarantineBeforeReportingPartialCleanup() throws Exception {
        Path metadata = state.resolve("migration-backups.json");
        Files.writeString(metadata, "{malformed");

        AiDataDirectoryException failure = assertThrows(AiDataDirectoryException.class, store::readBackupRecordsForCleanup);

        assertEquals("BACKUP_CLEANUP_PARTIAL", failure.getMessage());
        assertFalse(Files.exists(metadata));
        assertEquals("{malformed", JsonParser.parseString(Files.readString(state.resolve("migration-backups-quarantine.json")))
                .getAsJsonArray().get(0).getAsJsonObject().get("rawMetadata").getAsString());
    }

    @Test
    public void failedAtomicMetadataReplacementPreservesExistingDirectoryContents() throws Exception {
        Path destination = Files.createDirectory(state.resolve("blocked.json"));
        Path sentinel = Files.writeString(destination.resolve("keep"), "original");

        assertThrows(IOException.class, () -> AiDataMigrationStateStore.writeJson(destination, new JsonObject()));

        assertEquals("original", Files.readString(sentinel));
    }
}
