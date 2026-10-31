package com.github.claudecodegui.bridge;

import com.github.claudecodegui.settings.AiDataMigrationCoordinator;
import com.github.claudecodegui.util.PlatformUtils;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Path;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

public class AiDataProcessGateTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void pendingRecoveryRejectsStartsAndReadsWithoutLeakingAdmission() throws Exception {
        Path coordination = temporaryFolder.getRoot().toPath().resolve("coordination");
        Path state = java.nio.file.Files.createDirectories(coordination.resolve("state"));
        Path journal = state.resolve("migration-journal.json");
        java.nio.file.Files.writeString(journal, "{}");
        AiDataProcessGate gate = new AiDataProcessGate(new AiDataMigrationCoordinator(coordination));

        var start = assertThrows(IllegalStateException.class, gate::acquireProcessPermit);
        org.junit.Assert.assertEquals("AI_DATA_RECOVERY_REQUIRED", start.getMessage());
        var read = assertThrows(IllegalStateException.class, gate::tryAcquireReadPermit);
        org.junit.Assert.assertEquals("AI_DATA_RECOVERY_REQUIRED", read.getMessage());
        java.nio.file.Files.delete(journal);
        try (var admitted = gate.acquireProcessPermit()) {
            assertNotNull(admitted);
        }
        try (var migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
        }
    }

    @Test
    public void unsupportedPlatformsDoNotRequireCoordinationFilesForAiStarts() throws Exception {
        Path blockedParent = temporaryFolder.newFile("blocked-parent").toPath();
        Path coordination = blockedParent.resolve("coordination");

        for (PlatformUtils.PlatformType platform : new PlatformUtils.PlatformType[]{
                PlatformUtils.PlatformType.MACOS, PlatformUtils.PlatformType.LINUX}) {
            try (AiDataProcessGate.ProcessPermit ignored = AiDataProcessGate.forPlatform(platform, coordination)
                    .acquireProcessPermit()) {
                assertNotNull(ignored);
            }
        }
        var windows = AiDataProcessGate.forPlatform(PlatformUtils.PlatformType.WINDOWS, coordination);
        try (var permit = windows.acquireProcessPermit()) {
            assertNotNull(permit);
            assertFalse(windows.isCoordinationAvailable());
            assertNull(windows.tryAcquireMigrationPermit());
        }
    }

    @Test
    public void processPermitsFromDifferentGatesBlockMigrationUntilBothClose() throws Exception {
        Path coordinationDirectory = temporaryFolder.getRoot().toPath().resolve("coordination");
        AiDataMigrationCoordinator coordinator = new AiDataMigrationCoordinator(coordinationDirectory);
        AiDataProcessGate first = new AiDataProcessGate(coordinator);
        AiDataProcessGate second = new AiDataProcessGate(coordinator);

        try (AiDataProcessGate.ProcessPermit firstPermit = first.acquireProcessPermit()) {
            try (AiDataProcessGate.ProcessPermit secondPermit = second.acquireProcessPermit()) {
                assertNull(coordinator.tryAcquire("migrate"));
            }
            assertNull(coordinator.tryAcquire("migrate"));
        }

        try (AiDataMigrationCoordinator.LockHandle migration = coordinator.tryAcquire("migrate")) {
            assertNotNull(migration);
        }
    }

    @Test
    public void activeProcessPreventsMigrationFromStarting() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();

        try (AiDataProcessGate.ProcessPermit ignored = gate.acquireProcessPermit()) {
            assertNull(gate.tryAcquireMigrationPermit());
        }

        try (AiDataProcessGate.MigrationPermit migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
        }
    }

    @Test
    public void concurrentStorageReadersDoNotReportProcessOrDatabaseContention() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        ExecutorService executor = Executors.newFixedThreadPool(12);
        java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);
        java.util.List<Future<Boolean>> readers = new java.util.ArrayList<>();
        try (AiDataProcessGate.ProcessPermit process = gate.acquireProcessPermit()) {
            for (int thread = 0; thread < 12; thread++) {
                readers.add(executor.submit(() -> {
                    start.await();
                    for (int attempt = 0; attempt < 200; attempt++) {
                        try (AiDataProcessGate.ReadPermit reader = gate.tryAcquireReadPermit()) {
                            if (reader == null) {
                                return false;
                            }
                        }
                    }
                    return true;
                }));
            }
            start.countDown();
            for (Future<Boolean> reader : readers) {
                assertTrue("Concurrent read admission must not imply an active maintenance owner", reader.get(10, TimeUnit.SECONDS));
            }
        } finally {
            start.countDown();
            executor.shutdownNow();
        }
        try (AiDataProcessGate.MigrationPermit migration = gate.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
            assertNull(gate.tryAcquireReadPermit());
        }
    }

    @Test
    public void processStartCancelsAndWaitsForMigration() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        AiDataProcessGate.MigrationPermit migration = gate.tryAcquireMigrationPermit();
        assertNotNull(migration);
        ExecutorService executor = Executors.newSingleThreadExecutor();

        try {
            Future<AiDataProcessGate.ProcessPermit> processPermit = executor.submit(gate::acquireProcessPermit);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (!migration.isCancellationRequested() && System.nanoTime() < deadline) {
                Thread.yield();
            }

            assertTrue(migration.isCancellationRequested());
            assertFalse(processPermit.isDone());
            migration.close();

            try (AiDataProcessGate.ProcessPermit acquired = processPermit.get(2, TimeUnit.SECONDS)) {
                assertNotNull(acquired);
                assertNull(gate.tryAcquireMigrationPermit());
            }
        } finally {
            migration.close();
            executor.shutdownNow();
        }
    }

    @Test
    public void interruptedProcessWaiterDoesNotLeaveMigrationCancelled() throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        AiDataProcessGate.MigrationPermit migration = gate.tryAcquireMigrationPermit();
        assertNotNull(migration);
        ExecutorService executor = Executors.newSingleThreadExecutor();

        try {
            Future<AiDataProcessGate.ProcessPermit> processPermit = executor.submit(gate::acquireProcessPermit);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (!migration.isCancellationRequested() && System.nanoTime() < deadline) {
                Thread.yield();
            }

            assertTrue(migration.isCancellationRequested());
            assertTrue(processPermit.cancel(true));

            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
            while (migration.isCancellationRequested() && System.nanoTime() < deadline) {
                Thread.yield();
            }

            assertFalse(migration.isCancellationRequested());
            assertTrue(migration.beginCommit());
        } finally {
            migration.close();
            executor.shutdownNow();
        }
    }
}
