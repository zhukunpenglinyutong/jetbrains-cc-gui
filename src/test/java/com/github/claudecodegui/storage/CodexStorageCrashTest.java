package com.github.claudecodegui.storage;

import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.*;

public class CodexStorageCrashTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void hardDeathAfterEachDatabaseAndFileBoundaryRequiresSameScopeReconciliation() throws Exception {
        List<String> boundaries = new ArrayList<>(List.of("delete-intent:1", "file-delete:1", "file-delete:2"));
        for (int i = 1; i <= CodexStoragePaths.DATABASES.size(); i++) {
            boundaries.add("database-commit:" + i);
        }
        for (String boundary : boundaries) {
            var f = new CodexStorageFixture(temporary.newFolder().toPath());
            f.thread("remove", "/first", 1000);
            f.thread("keep", "/second", 1000);
            var first = f.rollout("remove", null, false);
            var second = f.rollout("remove", null, true);
            String id = UUID.randomUUID().toString();
            var parts = boundary.split(":");
            try (Peer owner = start(f.root, "delete", id, parts[0], parts[1])) {
                assertEquals(owner.finishedOutput(), 77, owner.process.exitValue());
            }
            assertTrue(boundary, new CodexMaintenanceJournal(f.coordination).hasPending());
            try (Peer restarted = start(f.root, "admit")) {
                assertTrue(boundary, restarted.finishedOutput().contains("AI_DATA_MAINTENANCE_PENDING"));
                assertEquals(0, restarted.process.exitValue());
            }
            var result = f.service().deleteSessions(List.of("remove"), id, false);
            assertEquals(boundary + ": " + result, "COMPLETED", result.get("state").getAsString());
            assertFalse(Files.exists(first));
            assertFalse(Files.exists(second));
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
            assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
            try (Peer restarted = start(f.root, "admit")) {
                assertTrue(restarted.finishedOutput().contains("SESSION_PERMANENTLY_DELETED"));
            }
        }
    }

    @Test public void hardDeathAroundCheckpointAndVacuumVerifiesContentWithoutRedispatchingVacuum() throws Exception {
        for (String boundary : List.of("compact-intent", "before-vacuum", "after-vacuum", "after-checkpoint")) {
            var f = new CodexStorageFixture(temporary.newFolder().toPath());
            f.thread("remove", "/first", 200000);
            f.thread("keep", "/second", 1000);
            String digest;
            try (var connection = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), true)) {
                digest = CodexStorageDatabase.contentDigest(connection);
            }
            String id = UUID.randomUUID().toString();
            try (Peer owner = start(f.root, "compact", id, boundary, "1")) {
                assertEquals(owner.finishedOutput(), 77, owner.process.exitValue());
            }
            assertTrue(new CodexMaintenanceJournal(f.coordination).hasPending());
            var service = f.service(checkpoint -> { if (checkpoint.equals("before-vacuum")) fail("Ambiguous VACUUM must not run twice"); });
            var result = service.compact(service.databaseStatus().get("databaseId").getAsString(), id);
            assertEquals(result.toString(), "COMPLETED_WITH_WARNINGS", result.get("state").getAsString());
            assertEquals("INTERRUPTED_COMPACTION_VERIFIED", result.getAsJsonObject("result").get("warning").getAsString());
            try (var connection = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), true)) {
                assertEquals(digest, CodexStorageDatabase.contentDigest(connection));
                CodexStorageDatabase.checkIntegrity(connection);
            }
        }
    }

    @Test public void nativeWriterLockInAnotherProcessIsNotInterruptedOrDeleted() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("remove", "/first", 100);
        var rollout = f.rollout("remove", null, false);
        try (Peer writer = start(f.root, "writer")) {
            awaitWriterReady(writer);
            var error = assertThrows(java.io.IOException.class, () -> f.service().deleteSessions(List.of("remove"), UUID.randomUUID().toString(), false));
            assertEquals("SESSION_WRITER_BUSY", error.getMessage());
            assertEquals(0, f.service().operations().size());
            assertTrue(writer.process.isAlive());
            assertTrue(Files.exists(rollout));
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
        }
    }

    @Test public void unrelatedNativeWriterInAnotherProcessDoesNotDisableStorageDeletion() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("idle", "/first", 100);
        f.thread("remove", "/running", 100);
        var idle = f.rollout("idle", null, false);
        var keep = f.rollout("remove", null, false);
        String keptContent = Files.readString(keep);
        f.sql("state_5.sqlite", "PRAGMA journal_mode=WAL");
        try (Peer writer = start(f.root, "writer")) {
            awaitWriterReady(writer);
            var status = f.service().mutationStatus();
            assertTrue(status.toString(), status.get("deletionAvailable").getAsBoolean());
            assertFalse(status.get("available").getAsBoolean());
            assertEquals("SESSION_WRITER_BUSY", status.get("unavailableReason").getAsString());
            assertEquals("[\"remove\"]", status.getAsJsonArray("writerSessionIds").toString());
            assertTrue(status.getAsJsonArray("runningSessionIds").isEmpty());
            try (var resident = f.gate.acquireProcessPermit();
                 var reader = CodexStorageDatabase.open(f.root.resolve("state_5.sqlite"), true)) {
                CodexStorageDatabase.execute(reader, "BEGIN");
                assertEquals(2L, CodexStorageDatabase.scalar(reader, "SELECT count(*) FROM threads"));
                var result = f.service().deleteSessions(List.of("idle"), UUID.randomUUID().toString(), false);
                assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
                assertEquals(2L, CodexStorageDatabase.scalar(reader, "SELECT count(*) FROM threads"));
                CodexStorageDatabase.execute(reader, "ROLLBACK");
            }
            assertFalse(Files.exists(idle));
            assertEquals(keptContent, Files.readString(keep));
            assertTrue(writer.process.isAlive());
            assertEquals(1L, f.count("state_5.sqlite", "threads"));
            assertEquals(1L, f.count(CodexStoragePaths.HISTORY_DATABASE, "thread_items"));
            String databaseId = f.service().databaseStatus().get("databaseId").getAsString();
            assertEquals("SESSION_WRITER_BUSY", assertThrows(java.io.IOException.class,
                    () -> f.service().compact(databaseId, UUID.randomUUID().toString())).getMessage());
        }
    }

    @Test public void nativeCompactionIncludesCommittedWalAfterWriterDeath() throws Exception {
        var f = new CodexStorageFixture(temporary.newFolder().toPath());
        f.thread("keep", "/project", 1000);
        try (Peer writer = start(f.root, "wal")) {
            assertEquals(writer.finishedOutput(), 78, writer.process.exitValue());
        }
        assertTrue(Files.size(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE + "-wal")) > 0);
        String digest;
        try (var connection = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), true)) {
            digest = CodexStorageDatabase.contentDigest(connection);
        }
        var service = f.service();
        var result = service.compact(service.databaseStatus().get("databaseId").getAsString(), UUID.randomUUID().toString());
        assertEquals(result.toString(), "COMPLETED", result.get("state").getAsString());
        assertTrue(result.getAsJsonObject("result").getAsJsonObject("before").get("walBytes").getAsLong() > 0);
        try (var connection = CodexStorageDatabase.open(f.root.resolve(CodexStoragePaths.HISTORY_DATABASE), true)) {
            assertEquals(digest, CodexStorageDatabase.contentDigest(connection));
        }
        assertTrue(new CodexStorageInventory(f.paths).content("keep", null, 10).toString().contains("committed WAL"));
    }

    private static Peer start(Path root, String... arguments) throws Exception {
        var locations = new LinkedHashSet<String>();
        for (Class<?> type : List.of(CodexStorageOwnerProcess.class, CodexStorageMaintenance.class, CodexStoragePaths.class,
                CodexStorageFileLock.class, Gson.class, org.sqlite.JDBC.class,
                org.slf4j.LoggerFactory.class, com.sun.jna.Native.class, com.intellij.openapi.diagnostic.Logger.class, com.intellij.openapi.util.SystemInfoRt.class,
                Class.forName("kotlin.Unit"))) {
            locations.add(location(type));
        }
        var schema = CodexStorageMaintenance.class.getResource("/codex-storage-schemas.json");
        if (schema.getProtocol().equals("jar")) {
            String file = schema.getFile();
            locations.add(Path.of(java.net.URI.create(file.substring(0, file.indexOf("!/")))).toString());
        } else {
            locations.add(Path.of(schema.toURI()).getParent().toString());
        }
        String executable = System.getProperty("os.name").startsWith("Windows") ? "java.exe" : "java";
        var command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", executable).toString()));
        String jnaPath = System.getProperty("jna.boot.library.path");
        if (jnaPath == null || jnaPath.isBlank()) {
            Path bundled = Path.of(location(com.sun.jna.Native.class)).getParent().resolve("jna").resolve(com.sun.jna.Platform.is64Bit() ? "amd64" : "x86");
            if (Files.isDirectory(bundled)) jnaPath = bundled.toString();
        }
        if (jnaPath != null && !jnaPath.isBlank()) command.add("-Djna.boot.library.path=" + jnaPath);
        command.addAll(List.of("-cp", String.join(File.pathSeparator, locations), CodexStorageOwnerProcess.class.getName(), root.toString()));
        command.addAll(List.of(arguments));
        return new Peer(new ProcessBuilder(command).redirectErrorStream(true).start());
    }

    private static void awaitWriterReady(Peer writer) throws Exception {
        var reader = java.util.concurrent.Executors.newSingleThreadExecutor();
        try {
            assertEquals("WRITER_READY", reader.submit(() -> {
                var output = new java.io.BufferedReader(new java.io.InputStreamReader(writer.process.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while ((line = output.readLine()) != null && !line.equals("WRITER_READY")) { }
                return line;
            }).get(15, TimeUnit.SECONDS));
        } finally { reader.shutdownNow(); }
    }

    private static String location(Class<?> type) throws Exception {
        var resource = type.getResource("/" + type.getName().replace('.', '/') + ".class");
        if (resource.getProtocol().equals("jar")) {
            String file = resource.getFile();
            return Path.of(java.net.URI.create(file.substring(0, file.indexOf("!/")))).toString();
        }
        Path directory = Path.of(resource.toURI()).getParent();
        for (String ignored : type.getPackageName().split("\\.")) directory = directory.getParent();
        return directory.toString();
    }

    private static final class Peer implements AutoCloseable {
        private final Process process;
        private Peer(Process process) { this.process = process; }
        private String finishedOutput() throws Exception {
            assertTrue("Controlled owner timed out", process.waitFor(25, TimeUnit.SECONDS));
            return new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        }
        @Override public void close() throws Exception {
            if (process.isAlive()) {
                process.destroyForcibly();
                assertTrue(process.waitFor(10, TimeUnit.SECONDS));
            }
        }
    }
}
