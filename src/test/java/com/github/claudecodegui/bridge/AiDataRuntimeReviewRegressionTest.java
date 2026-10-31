package com.github.claudecodegui.bridge;

import com.github.claudecodegui.settings.AiDataMigrationCoordinator;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.Assert.*;

public class AiDataRuntimeReviewRegressionTest {
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void coordinationIoFailureDisablesRelocationWithoutDisablingAiSessions() throws Exception {
        var blocked = temporaryFolder.newFile("blocked-parent").toPath().resolve("coordination");
        var gate = new AiDataProcessGate(new AiDataMigrationCoordinator(blocked));
        try (var session = gate.acquireProcessPermit()) {
            assertNotNull(session);
            assertFalse(gate.isCoordinationAvailable());
            assertNull(gate.tryAcquireMigrationPermit());
            assertThrows(IllegalStateException.class, gate::tryAcquireMaintenancePermit);
            assertThrows(IllegalStateException.class, gate::tryAcquireReadPermit);
        }
        try (var session = gate.acquireProcessPermit()) {
            assertNotNull(session);
        }
    }

    @Test
    public void migrationPermitOwnsTheOperatingSystemLockUntilClosed() throws Exception {
        Path path = temporaryFolder.getRoot().toPath().resolve("coordination");
        var coordinator = new AiDataMigrationCoordinator(path);
        var gate = new AiDataProcessGate(coordinator);
        try (var migration = gate.tryAcquireQuiescentMigrationPermit()) {
            assertNotNull(migration);
            assertNull(new AiDataMigrationCoordinator(path).tryAcquireProcessLock());
            assertNull(new AiDataProcessGate(coordinator).tryAcquireMigrationPermit());
        }
        try (var admitted = coordinator.tryAcquireProcessLock()) {
            assertNotNull(admitted);
        }
    }

    @Test
    public void aStartFromAnotherGateRequestsPrecommitRollbackAndWaits() throws Exception {
        Path path = temporaryFolder.getRoot().toPath().resolve("coordination");
        var coordinator = new AiDataMigrationCoordinator(path);
        var owner = new AiDataProcessGate(coordinator);
        var other = new AiDataProcessGate(new AiDataMigrationCoordinator(path));
        var executor = Executors.newSingleThreadExecutor();
        try (var migration = owner.tryAcquireQuiescentMigrationPermit()) {
            assertNotNull(migration);
            var start = executor.submit(other::acquireProcessPermit);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (!migration.isCancellationRequested() && System.nanoTime() < deadline) {
                Thread.sleep(10);
            }
            assertTrue(migration.isCancellationRequested());
            assertFalse(migration.beginCommit());
            assertFalse(start.isDone());
            migration.close();
            try (var session = start.get(5, TimeUnit.SECONDS)) {
                assertNotNull(session);
            }
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void committedCrossGateMigrationHasBoundedAdmissionWithoutCancellingIt() throws Exception {
        var coordinator = new AiDataMigrationCoordinator(temporaryFolder.getRoot().toPath().resolve("coordination"));
        var owner = new AiDataProcessGate(coordinator);
        var other = new AiDataProcessGate(coordinator, Duration.ofMillis(200));
        try (var migration = owner.tryAcquireMigrationPermit()) {
            assertNotNull(migration);
            assertTrue(migration.beginCommit());
            var error = assertThrows(IllegalStateException.class, other::acquireProcessPermit);
            assertEquals("AI_DATA_MIGRATION_BUSY", error.getMessage());
            assertFalse(migration.isCancellationRequested());
        }
        try (var session = other.acquireProcessPermit()) {
            assertNotNull(session);
        }
    }

    @Test
    public void liveMigrationJournalWaitsForItsOwnerInsteadOfReportingAbandonedRecovery() throws Exception {
        Path coordination = temporaryFolder.getRoot().toPath().resolve("coordination");
        var coordinator = new AiDataMigrationCoordinator(coordination);
        Path journal = coordination.resolve("state/migration-journal.json");
        try (var migration = coordinator.tryAcquire("migrate")) {
            assertNotNull(migration);
            Files.createDirectories(journal.getParent());
            Files.writeString(journal, "{}");
            assertNull(coordinator.tryAcquireProcessLock());
        }
        var error = assertThrows(java.io.IOException.class, coordinator::tryAcquireProcessLock);
        assertEquals("AI_DATA_RECOVERY_REQUIRED", error.getMessage());
    }

    @Test
    public void transientProcessObservationFailureDoesNotLeakThePermitForever() {
        var process = new MemoryProcess();
        AtomicBoolean first = new AtomicBoolean(true);
        process.children = () -> {
            if (first.getAndSet(false)) {
                throw new SecurityException("transient OS observation failure");
            }
            return Stream.empty();
        };
        AtomicInteger releases = new AtomicInteger();
        var tree = new ManagedProcessTree(process, releases::incrementAndGet);
        process.alive = false;
        tree.releaseAfterExit();
        assertEquals(1, releases.get());
    }

    @Test
    public void rootDescendantsAreNotRecursivelyRescannedForEveryChild() {
        var process = new MemoryProcess();
        AtomicInteger recursiveScans = new AtomicInteger();
        process.children = () -> java.util.stream.IntStream.range(1, 152)
                .mapToObj(id -> new MemoryHandle(id, process, recursiveScans));
        var tree = new ManagedProcessTree(process, () -> { });
        assertEquals(0, recursiveScans.get());
        process.alive = false;
        tree.releaseAfterExit();
        assertFalse(tree.hasLiveProcesses());
    }

    private static final class MemoryProcess extends Process {
        private volatile boolean alive = true;
        private java.util.function.Supplier<Stream<ProcessHandle>> children = Stream::empty;
        @Override public OutputStream getOutputStream() { return OutputStream.nullOutputStream(); }
        @Override public InputStream getInputStream() { return InputStream.nullInputStream(); }
        @Override public InputStream getErrorStream() { return InputStream.nullInputStream(); }
        @Override public int waitFor() { alive = false; return 0; }
        @Override public int exitValue() { if (alive) { throw new IllegalThreadStateException(); } return 0; }
        @Override public boolean isAlive() { return alive; }
        @Override public void destroy() { alive = false; }
        @Override public Process destroyForcibly() { destroy(); return this; }
        @Override public Stream<ProcessHandle> descendants() { return children.get(); }
        @Override public CompletableFuture<Process> onExit() { return new CompletableFuture<>(); }
    }

    private record MemoryHandle(long pid, MemoryProcess process, AtomicInteger scans) implements ProcessHandle {
        @Override public java.util.Optional<ProcessHandle> parent() { return java.util.Optional.empty(); }
        @Override public Stream<ProcessHandle> children() { return Stream.empty(); }
        @Override public Stream<ProcessHandle> descendants() { scans.incrementAndGet(); return Stream.empty(); }
        @Override public Info info() { return ProcessHandle.current().info(); }
        @Override public CompletableFuture<ProcessHandle> onExit() { return CompletableFuture.completedFuture(this); }
        @Override public boolean supportsNormalTermination() { return true; }
        @Override public boolean destroy() { return true; }
        @Override public boolean destroyForcibly() { return true; }
        @Override public boolean isAlive() { return process.alive; }
        @Override public int compareTo(ProcessHandle other) { return Long.compare(pid, other.pid()); }
    }
}
