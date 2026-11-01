package com.github.claudecodegui.settings;

import com.github.claudecodegui.bridge.AiDataProcessGate;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

/** Native NTFS, independent JVM ownership and observed source-detachment crash recovery. */
public class AiDataNativeRecoveryTest {

    private static final String[] IDS = {"claude", "codemoss", "codex"};

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void overlappingJvmMigrationIsRejectedAndForcedOwnerExitRecoversDetachedSources() throws Exception {
        requireNativeNtfs();
        for (int attempt = 0; attempt < 3; attempt++) {
            Path root = temporaryFolder.newFolder("race-" + attempt).toPath();
            prepare(root);
            Path rejectedTarget = Files.createDirectory(root.resolve("other target"));
            Process owner = startWorker(root);
            try {
                awaitDetachedPhase(root, owner);
                Path journalPath = root.resolve("coordination/state/migration-journal.json");
                String journal = Files.readString(journalPath);
                assertEquals("SOURCE_DETACHED", JsonParser.parseString(journal).getAsJsonObject()
                        .getAsJsonArray("entries").get(0).getAsJsonObject().get("phase").getAsString());
                assertFalse(Files.exists(root.resolve("home/.claude"), LinkOption.NOFOLLOW_LINKS));
                AiDataDirectoryManager observer = manager(root, null);
                JsonObject busy = observer.snapshot();
                assertEquals("AI_DATA_MIGRATION_ACTIVE", busy.get("error").getAsString());
                assertEquals(owner.pid(), busy.getAsJsonObject("migrationOwner").get("pid").getAsLong());
                IOException rejected = assertThrows(IOException.class, () -> observer.migrate(rejectedTarget.toString()));
                assertEquals("AI_DATA_MIGRATION_ACTIVE", rejected.getMessage());
                assertEquals(journal, Files.readString(journalPath));
                try (var contents = Files.list(rejectedTarget)) {
                    assertEquals(0, contents.count());
                }
                assertTrue(owner.isAlive());
            } finally {
                terminateOwnedWorker(owner);
            }
            JsonObject recovered = awaitRecoveredSnapshot(root);
            assertTrue(recovered.toString(), recovered.get("recovered").getAsBoolean());
            assertFalse(Files.exists(root.resolve("coordination/state/migration-journal.json")));
            assertNull(new AiDataMigrationCoordinator(root.resolve("coordination")).readActiveOwner());
            assertSentinels(root.resolve("home"));
            for (String id : IDS) {
                assertFalse(AiDataDirectoryManager.isDirectDirectoryLink(root.resolve("home/." + id)));
                assertFalse(Files.exists(root.resolve("target/." + id), LinkOption.NOFOLLOW_LINKS));
            }
            assertTrue(manager(root, null).migrate(rejectedTarget.toString()).get("success").getAsBoolean());
            assertSentinels(root.resolve("home"));
            assertSentinels(rejectedTarget);
            manager(root, null).cleanupBackups();
            assertEquals(0, manager(root, null).snapshot().getAsJsonArray("backups").size());
        }
    }

    @Test
    public void nativeJunctionsPreserveDataAndNewWritesAcrossSecondRelocationAndCleanup() throws Exception {
        requireNativeNtfs();
        Path root = temporaryFolder.newFolder("native-round-trip").toPath();
        prepare(root);
        Path first = Files.createDirectory(root.resolve("first target \u6d4b\u8bd5 & spaces"));
        Path second = Files.createDirectory(root.resolve("second target \u8fc1\u79fb & spaces"));
        assertTrue(manager(root, null).migrate(first.toString()).get("success").getAsBoolean());
        for (String id : IDS) {
            Path canonical = root.resolve("home/." + id);
            assertTrue(AiDataDirectoryManager.isDirectDirectoryLink(canonical));
            assertTrue(Files.isSameFile(canonical, first.resolve("." + id)));
            Files.writeString(canonical.resolve("new-record.txt"), "new-" + id);
            assertEquals("new-" + id, Files.readString(first.resolve("." + id).resolve("new-record.txt")));
        }
        // A fresh service instance exercises persisted state without claiming an IDE restart.
        assertTrue(manager(root, null).migrate(second.toString()).get("success").getAsBoolean());
        manager(root, null).cleanupBackups();
        assertSentinels(root.resolve("home"));
        assertSentinels(second);
        for (String id : IDS) {
            Path canonical = root.resolve("home/." + id);
            assertTrue(Files.isSameFile(canonical, second.resolve("." + id)));
            assertEquals("new-" + id, Files.readString(canonical.resolve("new-record.txt")));
            assertFalse(Files.exists(first.resolve("." + id), LinkOption.NOFOLLOW_LINKS));
        }
        assertEquals(0, manager(root, null).snapshot().getAsJsonArray("backups").size());
    }

    private void requireNativeNtfs() throws Exception {
        assumeTrue("Native Windows NTFS fixture is required", PlatformUtils.isWindows()
                && "NTFS".equalsIgnoreCase(Files.getFileStore(temporaryFolder.getRoot().toPath()).type()));
    }

    private static void prepare(Path root) throws Exception {
        Files.createDirectory(root.resolve("home"));
        Files.createDirectory(root.resolve("target"));
        for (String id : IDS) {
            Path directory = Files.createDirectory(root.resolve("home/." + id));
            Files.writeString(directory.resolve("sentinel.txt"), "original-" + id);
        }
    }

    private static AiDataDirectoryManager manager(Path root, AiDataDirectoryManager.DirectoryLinkCreator creator) {
        Path coordination = root.resolve("coordination");
        AiDataMigrationCoordinator coordinator = new AiDataMigrationCoordinator(coordination);
        return new AiDataDirectoryManager(root.resolve("home"), coordination.resolve("state"),
                PlatformUtils.getPlatformType(), false, creator, new AiDataProcessGate(coordinator),
                AiDataDirectoryManager::deleteWritablePath, coordination, root.resolve("legacy-state"));
    }

    private static Process startWorker(Path root) throws Exception {
        Path arguments = root.resolve("worker.args");
        Files.writeString(arguments, "-classpath\n" + quoteArgument(System.getProperty("java.class.path"))
                + "\n" + MigrationWorker.class.getName() + "\n" + quoteArgument(root.toString()) + "\n");
        return new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "@" + arguments).redirectErrorStream(true).redirectOutput(root.resolve("worker.log").toFile()).start();
    }

    private static String quoteArgument(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static void awaitDetachedPhase(Path root, Process child) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (!Files.exists(root.resolve("detached.ready")) && child.isAlive() && System.nanoTime() < deadline) {
            Thread.sleep(10);
        }
        assertTrue("Owned worker did not reach detachment: " + Files.readString(root.resolve("worker.log")),
                Files.exists(root.resolve("detached.ready")) && child.isAlive());
    }

    private static void terminateOwnedWorker(Process child) throws Exception {
        child.destroyForcibly();
        assertTrue("Owned worker must fully exit", child.waitFor(10, TimeUnit.SECONDS));
    }

    private static JsonObject awaitRecoveredSnapshot(Path root) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        JsonObject status;
        do {
            status = manager(root, null).snapshot();
            if (!status.has("error")) {
                return status;
            }
            // Poll the normal status API for bounded recovery after the owned worker exits.
            Thread.sleep(50);
        } while (System.nanoTime() < deadline);
        return status;
    }

    private static void assertSentinels(Path directory) throws Exception {
        for (String id : IDS) {
            assertEquals("original-" + id, Files.readString(directory.resolve("." + id).resolve("sentinel.txt")));
        }
    }

    /** The parent kills only this owned fixture JVM, after verifying the persisted phase. */
    public static final class MigrationWorker {
        public static void main(String[] args) throws Exception {
            Path root = Path.of(args[0]).toAbsolutePath().normalize();
            manager(root, (canonical, target) -> {
                Files.writeString(root.resolve("detached.ready"), "SOURCE_DETACHED");
                System.in.read();
                throw new IOException("Fixture worker released before forced exit");
            }).migrate(root.resolve("target").toString());
        }
    }
}
