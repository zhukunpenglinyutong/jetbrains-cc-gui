package com.github.claudecodegui.bridge;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class ManagedProcessTreeTest {
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void parentExitAndPermitCloseCannotReleaseLiveDescendant() throws Exception {
        checkProcessTree(false);
    }

    @Test
    public void explicitTerminationWaitsForParentAndTrackedDescendant() throws Exception {
        checkProcessTree(true);
    }

    private void checkProcessTree(boolean terminateTree) throws Exception {
        AiDataProcessGate gate = new AiDataProcessGate();
        Path classesDirectory = temporaryFolder.newFolder("fixture-classes").toPath();
        Path classFile = classesDirectory.resolve("com/github/claudecodegui/bridge/ProcessTreeFixture.class");
        Files.createDirectories(classFile.getParent());
        try (var resource = ProcessTreeFixture.class.getResourceAsStream("ProcessTreeFixture.class")) {
            assertNotNull(resource);
            Files.copy(resource, classFile);
        }
        String classes = classesDirectory.toString();
        String executable = Path.of(System.getProperty("java.home"), "bin",
                System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java").toString();
        Path pid = temporaryFolder.getRoot().toPath().resolve("child.pid");
        Process parent = new ProcessBuilder(executable, "-cp", classes, ProcessTreeFixture.class.getName(), "parent", pid.toString(), classes).start();
        ProcessHandle child = null;
        AiDataProcessGate.ProcessPermit permit = gate.acquireProcessPermit();
        try {
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while ((!Files.exists(pid) || Files.size(pid) == 0) && parent.isAlive() && System.nanoTime() < deadline) {
                Thread.sleep(10L);
            }
            assertTrue("Child fixture must signal readiness", Files.exists(pid));
            child = ProcessHandle.of(Long.parseLong(Files.readString(pid))).orElseThrow();
            assertTrue(child.isAlive());
            permit.bindProcess(parent);
            if (terminateTree) {
                assertTrue(permit.terminateProcessTree(5000L));
                assertFalse(parent.isAlive());
                assertFalse(child.isAlive());
            } else {
                parent.destroyForcibly();
                assertTrue(parent.waitFor(5, TimeUnit.SECONDS));
                assertTrue(child.isAlive());
                permit.close();
                assertNull("An orphaned managed child still excludes migration", gate.tryAcquireMigrationPermit());
                child.destroyForcibly();
                child.onExit().get(5, TimeUnit.SECONDS);
            }
            permit.close();
            java.util.concurrent.CountDownLatch released = new java.util.concurrent.CountDownLatch(1);
            permit.whenReleased(released::countDown);
            assertTrue(released.await(5, TimeUnit.SECONDS));
            try (AiDataProcessGate.MigrationPermit migration = gate.tryAcquireMigrationPermit()) {
                assertNotNull(migration);
            }
        } finally {
            parent.destroyForcibly();
            if (child != null && child.isAlive()) {
                child.destroyForcibly();
            }
            permit.close();
        }
    }
}
