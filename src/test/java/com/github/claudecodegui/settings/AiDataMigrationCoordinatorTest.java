package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

public class AiDataMigrationCoordinatorTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void exclusiveOwnerIsVisibleAndReleased() throws Exception {
        Path coordinationDirectory = temporaryFolder.getRoot().toPath().resolve("coordination");
        AiDataMigrationCoordinator first = new AiDataMigrationCoordinator(coordinationDirectory);
        AiDataMigrationCoordinator second = new AiDataMigrationCoordinator(coordinationDirectory);

        try (AiDataMigrationCoordinator.LockHandle ignored = first.tryAcquire("migrate")) {
            JsonObject owner = second.readOwner();
            assertNotNull(owner);
            assertEquals(1, owner.get("protocolVersion").getAsInt());
            assertEquals("migrate", owner.get("operation").getAsString());
            assertNull(second.tryAcquire("cleanup"));
        }

        try (AiDataMigrationCoordinator.LockHandle reacquired = second.tryAcquire("cleanup")) {
            assertNotNull(reacquired);
            assertEquals("cleanup", second.readOwner().get("operation").getAsString());
        }
        assertNull(second.readOwner());
    }

    @Test
    public void pendingMigrationBlocksNewSharedAdmissionUntilRecoveryClearsItsJournal() throws Exception {
        Path coordination = temporaryFolder.getRoot().toPath().resolve("coordination");
        Path state = Files.createDirectories(coordination.resolve("state"));
        Path journal = state.resolve("migration-journal.json");
        Files.writeString(journal, "{}", StandardCharsets.UTF_8);
        AiDataMigrationCoordinator coordinator = new AiDataMigrationCoordinator(coordination);

        var error = assertThrows(java.io.IOException.class, coordinator::tryAcquireProcessLock);
        assertEquals("AI_DATA_RECOVERY_REQUIRED", error.getMessage());
        assertThrows(java.io.IOException.class, coordinator::tryAcquireMaintenanceReadLock);
        try (var recovery = coordinator.tryAcquire("recovery")) {
            assertNotNull(recovery);
            Files.delete(journal);
        }
        try (var admitted = coordinator.tryAcquireProcessLock()) {
            assertNotNull(admitted);
        }
    }

    @Test
    public void sharedProcessLockBlocksExclusiveMigration() throws Exception {
        Path coordinationDirectory = temporaryFolder.getRoot().toPath().resolve("coordination");
        AiDataMigrationCoordinator first = new AiDataMigrationCoordinator(coordinationDirectory);
        AiDataMigrationCoordinator second = new AiDataMigrationCoordinator(coordinationDirectory);

        try (AiDataMigrationCoordinator.ProcessLock ignored = first.tryAcquireProcessLock()) {
            assertNotNull(ignored);
            assertNull(second.tryAcquire("migrate"));
        }

        try (AiDataMigrationCoordinator.LockHandle migration = second.tryAcquire("migrate")) {
            assertNotNull(migration);
        }
    }

    @Test
    public void linkedCoordinationParentCannotRedirectTheStableLockDirectory() throws Exception {
        Path root = temporaryFolder.getRoot().toPath();
        Path outside = Files.createDirectory(root.resolve("outside"));
        Path linked = root.resolve("linked-parent");
        if (System.getProperty("os.name").startsWith("Windows")) {
            Process process = new ProcessBuilder("cmd.exe", "/d", "/c", "mklink", "/J", linked.toString(), outside.toString()).start();
            assertTrue(process.waitFor(10, TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
        } else {
            Files.createSymbolicLink(linked, outside);
        }
        try {
            AiDataMigrationCoordinator coordinator = new AiDataMigrationCoordinator(linked.resolve("coordination"));
            var error = assertThrows(java.io.IOException.class, () -> coordinator.tryAcquire("migrate"));
            assertEquals("AI_DATA_COORDINATION_UNAVAILABLE", error.getMessage());
            assertFalse(Files.exists(outside.resolve("coordination")));
        } finally {
            Files.delete(linked);
        }
    }

    @Test
    public void separateJvmOwnerBlocksMigrationUntilItExits() throws Exception {
        assertSeparateJvmLockBlocksMigration(false);
    }

    @Test
    public void separateJvmAiProcessBlocksMigrationUntilItExits() throws Exception {
        assertSeparateJvmLockBlocksMigration(true);
    }

    private void assertSeparateJvmLockBlocksMigration(boolean shared) throws Exception {
        Path coordinationDirectory = temporaryFolder.getRoot().toPath().resolve("coordination");
        Path lockFile = coordinationDirectory.resolve("migration.lock");
        java.nio.file.Files.createDirectories(coordinationDirectory);
        Path classes = temporaryFolder.newFolder("lock-holder-classes").toPath();
        Path fixture = classes.resolve("com/github/claudecodegui/settings/AiDataMigrationLockHolder.class");
        Files.createDirectories(fixture.getParent());
        try (var resource = AiDataMigrationLockHolder.class.getResourceAsStream("AiDataMigrationLockHolder.class")) {
            assertNotNull(resource);
            Files.copy(resource, fixture);
        }
        Path java = Path.of(System.getProperty("java.home"), "bin", System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java");
        Process child = new ProcessBuilder(java.toString(), "-cp", classes.toString(), AiDataMigrationLockHolder.class.getName(), lockFile.toString(),
                shared ? "shared" : "exclusive").start();
        AiDataMigrationCoordinator coordinator = new AiDataMigrationCoordinator(coordinationDirectory);

        try {
            BufferedReader output = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8));
            assertEquals("LOCKED", output.readLine());
            assertNull(coordinator.tryAcquire("migrate"));
        } finally {
            child.destroyForcibly();
            if (!child.waitFor(10L, TimeUnit.SECONDS)) {
                child.destroyForcibly();
            }
        }

        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        AiDataMigrationCoordinator.LockHandle acquired = coordinator.tryAcquire("migrate");
        while (acquired == null && System.nanoTime() < deadline) {
            Thread.sleep(20);
            acquired = coordinator.tryAcquire("migrate");
        }
        assertNotNull("The exited JVM must release its OS lock", acquired);
        try (var released = acquired) {
            assertNotNull(released);
        }
    }
}
