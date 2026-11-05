package com.github.claudecodegui.bridge;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

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

    @Test
    public void terminationRecapturesDescendantsSpawnedDuringKillLoop() {
        SpawnDuringTerminationProcess process = new SpawnDuringTerminationProcess();
        ManagedProcessTree tree = new ManagedProcessTree(process, () -> { });

        assertTrue(tree.terminate(1000L));
        assertEquals(2, process.destroyAttempts);
        assertNotNull(process.spawnedDescendant);
        assertEquals(1, process.spawnedDescendant.destroyAttempts);
        assertFalse(process.spawnedDescendant.isAlive());
        assertFalse(tree.hasLiveDescendants());
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
                assertFalse(permit.hasLiveDescendants());
            } else {
                parent.destroyForcibly();
                assertTrue(parent.waitFor(5, TimeUnit.SECONDS));
                assertTrue(child.isAlive());
                assertTrue(permit.hasLiveDescendants());
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

    private static final class SpawnDuringTerminationProcess extends Process {
        private final List<LateDescendant> descendants = new ArrayList<>();
        private boolean alive = true;
        private int destroyAttempts;
        private LateDescendant spawnedDescendant;

        @Override
        public OutputStream getOutputStream() {
            return OutputStream.nullOutputStream();
        }

        @Override
        public InputStream getInputStream() {
            return InputStream.nullInputStream();
        }

        @Override
        public InputStream getErrorStream() {
            return InputStream.nullInputStream();
        }

        @Override
        public int waitFor() {
            alive = false;
            return 0;
        }

        @Override
        public boolean waitFor(long timeout, TimeUnit unit) {
            return !alive;
        }

        @Override
        public int exitValue() {
            if (alive) {
                throw new IllegalThreadStateException();
            }
            return 0;
        }

        @Override
        public boolean isAlive() {
            return alive;
        }

        @Override
        public void destroy() {
            alive = false;
        }

        @Override
        public Process destroyForcibly() {
            destroyAttempts++;
            if (destroyAttempts == 1) {
                spawnedDescendant = new LateDescendant();
                descendants.add(spawnedDescendant);
            } else {
                alive = false;
            }
            return this;
        }

        @Override
        public Stream<ProcessHandle> descendants() {
            return new ArrayList<>(descendants).stream().map(handle -> handle);
        }

        @Override
        public CompletableFuture<Process> onExit() {
            return new CompletableFuture<>();
        }
    }

    private static final class LateDescendant implements ProcessHandle {
        private boolean alive = true;
        private int destroyAttempts;

        @Override
        public long pid() {
            return 1001L;
        }

        @Override
        public Optional<ProcessHandle> parent() {
            return Optional.empty();
        }

        @Override
        public Stream<ProcessHandle> children() {
            return Stream.empty();
        }

        @Override
        public Stream<ProcessHandle> descendants() {
            return Stream.empty();
        }

        @Override
        public Info info() {
            return ProcessHandle.current().info();
        }

        @Override
        public CompletableFuture<ProcessHandle> onExit() {
            return CompletableFuture.completedFuture(this);
        }

        @Override
        public boolean supportsNormalTermination() {
            return true;
        }

        @Override
        public boolean destroy() {
            alive = false;
            return true;
        }

        @Override
        public boolean destroyForcibly() {
            destroyAttempts++;
            alive = false;
            return true;
        }

        @Override
        public boolean isAlive() {
            return alive;
        }

        @Override
        public int compareTo(ProcessHandle other) {
            return Long.compare(pid(), other.pid());
        }
    }
}
