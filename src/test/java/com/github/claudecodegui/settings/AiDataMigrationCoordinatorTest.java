package com.github.claudecodegui.settings;

import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

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
        Path fixture = Path.of("test", "AiDataMigrationLockHolder.java").toAbsolutePath();
        Path java = Path.of(System.getProperty("java.home"), "bin", "java");
        Process child = new ProcessBuilder(java.toString(), fixture.toString(), lockFile.toString(),
                shared ? "shared" : "exclusive").start();
        AiDataMigrationCoordinator coordinator = new AiDataMigrationCoordinator(coordinationDirectory);

        try {
            BufferedReader output = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8));
            assertEquals("LOCKED", output.readLine());
            assertNull(coordinator.tryAcquire("migrate"));
        } finally {
            child.getOutputStream().write(1);
            child.getOutputStream().flush();
            if (!child.waitFor(10L, TimeUnit.SECONDS)) {
                child.destroyForcibly();
            }
        }

        try (AiDataMigrationCoordinator.LockHandle acquired = coordinator.tryAcquire("migrate")) {
            assertNotNull(acquired);
        }
    }
}
