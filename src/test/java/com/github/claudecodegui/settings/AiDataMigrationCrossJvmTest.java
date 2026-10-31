package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class AiDataMigrationCrossJvmTest {
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void failedLocalExclusiveAttemptsCannotDropAnExistingSharedOsLock() throws Exception {
        Path coordination = temporaryFolder.getRoot().toPath().resolve("shared-coordination");
        var coordinator = new AiDataMigrationCoordinator(coordination);
        try (var first = coordinator.tryAcquireProcessLock()) {
            assertNotNull(first);
            assertNull(new AiDataMigrationCoordinator(coordination).tryAcquire("migrate"));
            try (var second = coordinator.tryAcquireProcessLock()) {
                assertNotNull(second);
                assertBusyFromSeparateJvm(coordination);
            }
            assertBusyFromSeparateJvm(coordination);
        }
        try (var exclusive = coordinator.tryAcquire("migrate")) {
            assertNotNull(exclusive);
        }
    }

    @Test
    public void failedLocalSharedAndExclusiveAttemptsCannotDropAnExclusiveOsLock() throws Exception {
        Path coordination = temporaryFolder.getRoot().toPath().resolve("exclusive-coordination");
        var coordinator = new AiDataMigrationCoordinator(coordination);
        try (var exclusive = coordinator.tryAcquire("migrate")) {
            assertNotNull(exclusive);
            assertNull(new AiDataMigrationCoordinator(coordination).tryAcquireProcessLock());
            assertNull(new AiDataMigrationCoordinator(coordination).tryAcquire("cleanup"));
            assertBusyFromSeparateJvm(coordination);
        }
    }

    @Test
    public void separateJvmCancellationIsScopedToThePrecommitOwner() throws Exception {
        Path coordination = temporaryFolder.getRoot().toPath().resolve("cancel-coordination");
        var coordinator = new AiDataMigrationCoordinator(coordination);
        try (var exclusive = coordinator.tryAcquire("migrate")) {
            assertNotNull(exclusive);
            try (Peer requester = start(coordination, "cancel")) {
                assertEquals("READY", requester.readMarker());
                requester.signal();
                assertEquals("CANCELLED", requester.readMarker());
            }
            assertTrue(exclusive.isCancellationRequested());
            assertFalse(exclusive.beginCommit());
        }
        try (var next = coordinator.tryAcquire("migrate")) {
            assertNotNull(next);
            assertFalse(next.isCancellationRequested());
            assertTrue(next.beginCommit());
            coordinator.requestMigrationCancellation();
            assertFalse(next.isCancellationRequested());
        }
    }

    private static void assertBusyFromSeparateJvm(Path coordination) throws Exception {
        try (Peer peer = start(coordination)) {
            assertEquals("READY", peer.readMarker());
            peer.signal();
            assertEquals("BUSY", peer.readMarker());
        }
    }

    @Test
    public void simultaneousJvmMigrationsHaveOneOwnerAndHardDeathAllowsReacquisition() throws Exception {
        Path coordination = temporaryFolder.getRoot().toPath().resolve("shared-coordination");
        ExecutorService readers = Executors.newFixedThreadPool(2);
        AiDataMigrationCoordinator observer = new AiDataMigrationCoordinator(coordination);
        try (Peer first = start(coordination); Peer second = start(coordination)) {
            assertEquals("READY", readers.submit(first::readMarker).get(10, TimeUnit.SECONDS));
            assertEquals("READY", readers.submit(second::readMarker).get(10, TimeUnit.SECONDS));
            first.signal();
            second.signal();
            var firstResult = readers.submit(first::readMarker);
            var secondResult = readers.submit(second::readMarker);
            String a = firstResult.get(10, TimeUnit.SECONDS);
            String b = secondResult.get(10, TimeUnit.SECONDS);
            assertTrue(List.of(a, b).contains("OWNED"));
            assertTrue(List.of(a, b).contains("BUSY"));
            Peer owner = "OWNED".equals(a) ? first : second;
            assertNotNull(observer.readActiveOwner());
            assertEquals(owner.process.pid(), observer.readActiveOwner().get("pid").getAsLong());
            assertNull(observer.tryAcquire("cleanup"));
            owner.process.destroyForcibly();
            assertTrue(owner.process.waitFor(10, TimeUnit.SECONDS));
            assertNull(observer.readActiveOwner());
            AiDataMigrationCoordinator.LockHandle recoveredPermit = null;
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
            while (recoveredPermit == null && System.nanoTime() < deadline) {
                recoveredPermit = observer.tryAcquire("cleanup");
                if (recoveredPermit == null) {
                    Thread.sleep(25L);
                }
            }
            try (AiDataMigrationCoordinator.LockHandle recovered = recoveredPermit) {
                assertNotNull(recovered);
                assertEquals("cleanup", observer.readActiveOwner().get("operation").getAsString());
            }
        } finally {
            readers.shutdownNow();
        }
    }

    private static Peer start(Path coordination, String... mode) throws Exception {
        LinkedHashSet<String> locations = new LinkedHashSet<>();
        for (Class<?> type : List.of(AiDataMigrationOwnerProcess.class, AiDataMigrationCoordinator.class,
                Gson.class, com.intellij.openapi.diagnostic.Logger.class, com.intellij.openapi.util.SystemInfoRt.class,
                Class.forName("kotlin.Unit"))) {
            var resource = type.getResource("/" + type.getName().replace('.', '/') + ".class");
            assertNotNull(resource);
            if ("jar".equals(resource.getProtocol())) {
                String file = resource.getFile();
                locations.add(Path.of(java.net.URI.create(file.substring(0, file.indexOf("!/")))).toString());
            } else {
                Path directory = Path.of(resource.toURI()).getParent();
                for (String ignored : type.getPackageName().split("\\.")) {
                    directory = directory.getParent();
                }
                locations.add(directory.toString());
            }
        }
        String executable = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        return new Peer(new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", executable).toString(),
                "-cp", String.join(File.pathSeparator, locations), AiDataMigrationOwnerProcess.class.getName(),
                coordination.toString(), mode.length == 0 ? "migrate" : mode[0]).redirectErrorStream(true).start());
    }

    private static final class Peer implements AutoCloseable {
        private final Process process;
        private final BufferedReader output;

        private Peer(Process process) {
            this.process = process;
            this.output = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
        }

        private void signal() throws Exception {
            process.getOutputStream().write(1);
            process.getOutputStream().flush();
        }

        private String readMarker() throws Exception {
            String line;
            StringBuilder diagnostics = new StringBuilder();
            while ((line = output.readLine()) != null) {
                if (List.of("READY", "OWNED", "BUSY", "CANCELLED").contains(line)) {
                    return line;
                }
                diagnostics.append(line).append('\n');
            }
            var missing = java.util.regex.Pattern.compile("(?:NoClassDefFoundError|ClassNotFoundException): ([\\w./$]+)").matcher(diagnostics);
            throw new AssertionError("Coordinator child exited without its protocol marker"
                    + (missing.find() ? "; missing fixture class: " + missing.group(1) : ""));
        }

        @Override
        public void close() throws Exception {
            if (process.isAlive()) {
                process.destroyForcibly();
                assertTrue(process.waitFor(10, TimeUnit.SECONDS));
            }
            output.close();
        }
    }
}
