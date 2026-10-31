package com.github.claudecodegui.bridge;

import com.github.claudecodegui.settings.AiDataMigrationCoordinator;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;

import static org.junit.Assert.*;

public class AiDataReadPermitTest {
    @Rule public final TemporaryFolder temporary = new TemporaryFolder();

    @Test public void readersBlockMigrationUntilBothCloseAndCloseIsIdempotent() {
        AiDataProcessGate gate = new AiDataProcessGate();
        AiDataProcessGate.ReadPermit first = gate.tryAcquireReadPermit();
        AiDataProcessGate.ReadPermit second = gate.tryAcquireReadPermit();
        assertNotNull(first);
        assertNotNull(second);
        assertNull(gate.tryAcquireMigrationPermit());
        first.close(); first.close();
        assertNull(gate.tryAcquireMigrationPermit());
        second.close();
        try (var migration = gate.tryAcquireMigrationPermit()) { assertNotNull(migration); }
    }

    @Test public void readDoesNotCancelOrWaitForAnActiveMigration() {
        AiDataProcessGate gate = new AiDataProcessGate();
        try (var migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
            assertNull(gate.tryAcquireReadPermit());
            assertFalse(migration.isCancellationRequested());
            assertTrue(migration.beginCommit());
            assertNull(gate.tryAcquireReadPermit());
        }
        try (var read = gate.tryAcquireReadPermit()) { assertNotNull(read); }
    }

    @Test public void independentGatesShareTheExclusiveMigrationBoundary() throws Exception {
        Path root = temporary.newFolder("coordination").toPath();
        AiDataMigrationCoordinator firstCoordinator = new AiDataMigrationCoordinator(root);
        AiDataMigrationCoordinator secondCoordinator = new AiDataMigrationCoordinator(root);
        AiDataProcessGate first = new AiDataProcessGate(firstCoordinator);
        AiDataProcessGate second = new AiDataProcessGate(secondCoordinator);
        try (var readA = first.tryAcquireReadPermit(); var readB = second.tryAcquireReadPermit()) {
            assertNotNull(readA); assertNotNull(readB);
            assertNull(secondCoordinator.tryAcquire("migrate"));
        }
        try (var exclusive = firstCoordinator.tryAcquire("migrate")) {
            assertNotNull(exclusive);
            assertNull(first.tryAcquireReadPermit());
            assertNull(second.tryAcquireReadPermit());
        }
    }

    @Test public void coordinationFailureNeverAdmitsAnUnprotectedRead() throws Exception {
        Path root = temporary.newFile("blocked-parent").toPath().resolve("coordination");
        AiDataProcessGate gate = new AiDataProcessGate(new AiDataMigrationCoordinator(root));
        assertThrows(IllegalStateException.class, gate::tryAcquireReadPermit);
        assertNull(gate.tryAcquireMigrationPermit());
        assertFalse(gate.isCoordinationAvailable());
        assertThrows(IllegalStateException.class, gate::tryAcquireReadPermit);
        assertThrows(IllegalStateException.class, gate::tryAcquireMaintenancePermit);
        try (var ordinarySession = gate.acquireProcessPermit()) {
            assertNotNull(ordinarySession);
        }
    }
}
