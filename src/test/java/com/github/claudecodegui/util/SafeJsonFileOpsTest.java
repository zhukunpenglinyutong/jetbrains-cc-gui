package com.github.claudecodegui.util;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Unit tests for {@link SafeJsonFileOps}: atomic writes, automatic backups,
 * read-only backup fallback, optimistic conflict detection and advisory
 * locking — the machinery that stops MCP server configs from silently vanishing
 * when ~/.claude.json is shared with the Claude CLI process.
 *
 * <p>Concurrency cases are driven by latches and by injecting a competing
 * writer from inside the mutation callback — never by unobserved sleeps — so
 * they are deterministic on every machine.
 */
public class SafeJsonFileOpsTest {

    private Path tempDir;

    @Before
    public void setUp() throws Exception {
        tempDir = Files.createTempDirectory("safe-json-ops-test");
    }

    @After
    public void tearDown() throws Exception {
        if (tempDir != null) {
            try (java.util.stream.Stream<Path> paths = Files.walk(tempDir)) {
                paths.sorted(Comparator.reverseOrder())
                        .map(Path::toFile)
                        .forEach(File::delete);
            }
            tempDir = null;
        }
    }

    /** @return true when the default filesystem supports POSIX permissions */
    private static boolean isPosix() {
        return FileSystems.getDefault().supportedFileAttributeViews().contains("posix");
    }

    /** @return the backup sibling of {@code file} */
    private static Path backupOf(Path file) {
        return SafeJsonFileOps.sibling(file, SafeJsonFileOps.BACKUP_SUFFIX);
    }

    /** @return the staged temp files still present in {@code dir} */
    private static List<Path> stagedTempFiles(Path dir) throws IOException {
        List<Path> leftovers = new ArrayList<>();
        try (java.util.stream.Stream<Path> paths = Files.list(dir)) {
            paths.filter(p -> p.getFileName().toString().contains(".ccgui-tmp")).forEach(leftovers::add);
        }
        return leftovers;
    }

    /** Atomic write replaces the content and leaves no temp files behind. */
    @Test
    public void writeAtomicallyReplacesContent() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"a\":1}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"a\":2,\"b\":\"x\"}"));

        assertEquals("{\"a\":2,\"b\":\"x\"}", Files.readString(file, StandardCharsets.UTF_8));
        assertTrue("staged temp files must be cleaned up", stagedTempFiles(tempDir).isEmpty());
    }

    /** Each replace keeps a backup of the previous content. */
    @Test
    public void writeAtomicallyKeepsBackupOfPreviousContent() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"version\":\"old\"}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"version\":\"new\"}"));

        Path backup = backupOf(file);
        assertTrue("backup must exist after overwrite", Files.exists(backup));
        assertEquals("{\"version\":\"old\"}", Files.readString(backup, StandardCharsets.UTF_8));
    }

    /** A write into a non-existent directory creates the directory. */
    @Test
    public void writeAtomicallyCreatesParentDirectories() throws Exception {
        Path file = tempDir.resolve("nested/deep/config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{}"));
        assertTrue(Files.exists(file));
    }

    /** A no-op write must neither rewrite the file nor rotate the backup. */
    @Test
    public void writeAtomicallySkipsNoOpWriteAndKeepsBackup() throws Exception {
        Path file = tempDir.resolve("config.json");
        Path backup = backupOf(file);

        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        assertFalse("the first write has nothing to back up", Files.exists(backup));

        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":2}"));
        assertEquals("{\"v\":1}", Files.readString(backup, StandardCharsets.UTF_8));

        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":2}"));
        assertEquals("a no-op write must not rotate the backup",
                "{\"v\":1}", Files.readString(backup, StandardCharsets.UTF_8));
        assertEquals("{\"v\":2}", Files.readString(file, StandardCharsets.UTF_8));
    }

    /** A damaged live file must never be promoted into the last known good backup. */
    @Test
    public void corruptLiveFileNeverReplacesTheGoodBackup() throws Exception {
        Path file = tempDir.resolve("config.json");
        Path backup = backupOf(file);
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":2}"));
        assertEquals("{\"v\":1}", Files.readString(backup, StandardCharsets.UTF_8));

        // Simulated crash of another writer: half a document on disk.
        Files.writeString(file, "{torn", StandardCharsets.UTF_8);
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":3}"));

        assertEquals("the last known good backup must survive a corrupt live file",
                "{\"v\":1}", Files.readString(backup, StandardCharsets.UTF_8));
        assertEquals("{\"v\":3}", Files.readString(file, StandardCharsets.UTF_8));
    }

    /**
     * A truncated (0-byte) or NUL-filled live file parses leniently as JSON null
     * or a bare string, but it is not a usable config: it must never replace
     * the last known good backup either.
     */
    @Test
    public void emptyOrNulLiveFileNeverReplacesTheGoodBackup() throws Exception {
        Path file = tempDir.resolve("config.json");
        Path backup = backupOf(file);
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":2}"));

        Files.write(file, new byte[0]);
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":3}"));
        assertEquals("a 0-byte live file must not replace the good backup",
                "{\"v\":1}", Files.readString(backup, StandardCharsets.UTF_8));

        Files.write(file, new byte[]{0, 0, 0, 0});
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":4}"));
        assertEquals("a NUL-filled live file must not replace the good backup",
                "{\"v\":1}", Files.readString(backup, StandardCharsets.UTF_8));
        assertEquals("{\"v\":4}", Files.readString(file, StandardCharsets.UTF_8));
    }

    /**
     * The backup is swapped in atomically like the main file: rewriting it in
     * place would destroy the last good copy if the IDE died mid-copy. A new
     * file key after the refresh shows a replace rather than an in-place rewrite.
     */
    @Test
    public void backupIsReplacedAtomicallyNotRewrittenInPlace() throws Exception {
        Path file = tempDir.resolve("config.json");
        Path backup = backupOf(file);
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":2}"));
        Object firstKey = Files.readAttributes(backup, BasicFileAttributes.class).fileKey();
        Assume.assumeTrue("the filesystem exposes no file keys", firstKey != null);

        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":3}"));

        assertEquals("{\"v\":2}", Files.readString(backup, StandardCharsets.UTF_8));
        assertFalse("the backup must be replaced, not truncated and rewritten in place",
                firstKey.equals(Files.readAttributes(backup, BasicFileAttributes.class).fileKey()));
        assertTrue("no staged backup copy may be left behind", stagedTempFiles(tempDir).isEmpty());
    }

    /** The backup fallback must look where the write put the backup: beside the symlink's target. */
    @Test
    public void readJsonOrBackupFindsTheBackupOfASymlinkedFile() throws Exception {
        Path realDir = Files.createDirectories(tempDir.resolve("real"));
        Path real = realDir.resolve("config.json");
        Files.writeString(real, "{\"v\":1}", StandardCharsets.UTF_8);
        Path link = tempDir.resolve("config.json");
        try {
            Files.createSymbolicLink(link, real);
        } catch (IOException | UnsupportedOperationException e) {
            Assume.assumeTrue("symlinks are not permitted here: " + e.getMessage(), false);
            return;
        }
        SafeJsonFileOps.writeAtomically(link, w -> w.write("{\"v\":2}"));
        // toRealPath: the temp dir itself may sit behind a symlink (/var -> /private/var on macOS).
        assertEquals(backupOf(real.toRealPath()), SafeJsonFileOps.backupPathOf(link));

        Files.writeString(real, "{torn", StandardCharsets.UTF_8);

        JsonObject recovered = SafeJsonFileOps.readJsonOrBackup(link, 1, 1);
        assertNotNull("the backup beside the symlink target must be found", recovered);
        assertEquals(1, recovered.get("v").getAsInt());
    }

    /** An unreadable file's error names the usable backup so the user knows how to recover. */
    @Test
    public void strictReadErrorPointsToAUsableBackup() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":2}"));
        Files.writeString(file, "{torn", StandardCharsets.UTF_8);

        try {
            SafeJsonFileOps.readJsonObjectStrict(file, 1, 1);
            fail("an unreadable file must be reported");
        } catch (IOException expected) {
            assertTrue("the error must name the backup: " + expected.getMessage(),
                    expected.getMessage().contains(backupOf(file).toString()));
        }
    }

    /**
     * Reading through the backup fallback is READ-ONLY: neither the damaged
     * live file nor the backup may be rewritten (review item 1).
     */
    @Test
    public void readJsonOrBackupFallsBackWithoutRewritingEitherFile() throws Exception {
        Path file = tempDir.resolve("config.json");
        Path backup = backupOf(file);
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"mcpServers\":{\"srv\":{\"command\":\"npx\"}}}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"mcpServers\":{\"srv\":{\"command\":\"uvx\"}}}"));
        assertEquals("{\"mcpServers\":{\"srv\":{\"command\":\"npx\"}}}",
                Files.readString(backup, StandardCharsets.UTF_8));

        String torn = "{\"mcpServers\":{\"srv\":{\"comm";
        Files.writeString(file, torn, StandardCharsets.UTF_8);

        JsonObject fromBackup = SafeJsonFileOps.readJsonOrBackup(file, 2, 10);
        assertNotNull("damaged file must fall back to the backup", fromBackup);
        assertTrue(fromBackup.getAsJsonObject("mcpServers").has("srv"));

        assertEquals("the read must not rewrite the live file", torn,
                Files.readString(file, StandardCharsets.UTF_8));
        assertEquals("the read must not rewrite the backup",
                "{\"mcpServers\":{\"srv\":{\"command\":\"npx\"}}}",
                Files.readString(backup, StandardCharsets.UTF_8));
    }

    /** readJsonObject returns null for a missing file without throwing. */
    @Test
    public void readJsonObjectReturnsNullForMissingFile() {
        assertNull(SafeJsonFileOps.readJsonObject(tempDir.resolve("nope.json"), 2, 10));
    }

    /** The strict read reports missing and unreadable files differently. */
    @Test
    public void strictReadDistinguishesMissingFromUnreadable() throws Exception {
        assertNull("a missing file is a legitimate empty state",
                SafeJsonFileOps.readJsonObjectStrict(tempDir.resolve("absent.json"), 2, 10));

        Path corrupt = tempDir.resolve("corrupt.json");
        Files.writeString(corrupt, "not json at all {{{", StandardCharsets.UTF_8);
        try {
            SafeJsonFileOps.readJsonObjectStrict(corrupt, 2, 10);
            fail("an existing but unparsable file must not be read as null");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("Could not parse"));
        }
    }

    /** Transient garbage resolves to null after retries (no backup available). */
    @Test
    public void readJsonOrBackupReturnsNullWhenBothAreUnusable() throws Exception {
        Path file = tempDir.resolve("config.json");
        Files.writeString(file, "not json at all {{{", StandardCharsets.UTF_8);
        assertNull(SafeJsonFileOps.readJsonOrBackup(file, 2, 10));
    }

    /** The backup may carry secrets (settings.json holds tokens) — it must not be world-readable. */
    @Test
    public void backupFileIsOwnerOnlyOnPosix() throws Exception {
        Assume.assumeTrue("POSIX-only check", isPosix());
        Path file = tempDir.resolve("settings.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"secret\"}}"));
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"env\":{}}"));

        assertEquals(PosixFilePermissions.fromString("rw-------"),
                Files.getPosixFilePermissions(backupOf(file)));
    }

    /** An existing file keeps its mode: the replace must not tighten 0644 to 0600. */
    @Test
    public void writeAtomicallyPreservesExistingPosixPermissions() throws Exception {
        Assume.assumeTrue("POSIX-only check", isPosix());
        Path file = tempDir.resolve("claude.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        Set<PosixFilePermission> mode = PosixFilePermissions.fromString("rw-r--r--");
        Files.setPosixFilePermissions(file, mode);

        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":2}"));

        assertEquals("the replace must preserve the existing mode",
                mode, Files.getPosixFilePermissions(file));
    }

    /** Writing through a symlink must update its target and leave the link in place. */
    @Test
    public void writeAtomicallyFollowsSymlinkAndKeepsTheLink() throws Exception {
        Path realDir = Files.createDirectories(tempDir.resolve("real"));
        Path real = realDir.resolve("config.json");
        Files.writeString(real, "{\"v\":1}", StandardCharsets.UTF_8);
        Path link = tempDir.resolve("config.json");
        try {
            Files.createSymbolicLink(link, real);
        } catch (IOException | UnsupportedOperationException e) {
            Assume.assumeTrue("symlinks are not permitted here: " + e.getMessage(), false);
            return;
        }

        SafeJsonFileOps.writeAtomically(link, w -> w.write("{\"v\":2}"));

        assertTrue("the symlink must survive the replace", Files.isSymbolicLink(link));
        assertEquals("the link target must not change", real, Files.readSymbolicLink(link));
        assertEquals("the real file must receive the new content",
                "{\"v\":2}", Files.readString(real, StandardCharsets.UTF_8));
    }

    /** A guarded write succeeds while the fingerprint still matches. */
    @Test
    public void guardedWriteAcceptsUnchangedContent() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        SafeJsonFileOps.ContentSnapshot snapshot = SafeJsonFileOps.snapshot(file);

        SafeJsonFileOps.writeAtomicallyIfUnchanged(file, snapshot, w -> w.write("{\"v\":2}"));

        assertEquals("{\"v\":2}", Files.readString(file, StandardCharsets.UTF_8));
    }

    /** A guarded write rejects a concurrent change instead of clobbering it. */
    @Test
    public void guardedWriteRejectsConcurrentChange() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        SafeJsonFileOps.ContentSnapshot snapshot = SafeJsonFileOps.snapshot(file);

        // Another process (the Claude CLI) wins the race.
        Files.writeString(file, "{\"v\":99}", StandardCharsets.UTF_8);

        try {
            SafeJsonFileOps.writeAtomicallyIfUnchanged(file, snapshot, w -> w.write("{\"plugin\":true}"));
            fail("expected the stale write to be rejected");
        } catch (SafeJsonFileOps.ConflictException expected) {
            // expected
        }
        assertEquals("the concurrent writer's content must survive",
                "{\"v\":99}", Files.readString(file, StandardCharsets.UTF_8));
    }

    /**
     * The mutation is re-applied to the latest content after a conflict, so a
     * concurrently added field and server both survive (review item 2).
     */
    @Test
    public void mutationRetriesOnConflictAndMergesConcurrentChanges() throws Exception {
        Path file = tempDir.resolve("config.json");
        Files.writeString(file, "{\"cliField\":\"first\"}", StandardCharsets.UTF_8);

        AtomicBoolean injected = new AtomicBoolean(false);
        AtomicInteger rounds = new AtomicInteger();
        SafeJsonFileOps.mutateJsonAtomically(file, 3, 10, current -> {
            assertNotNull(current);
            rounds.incrementAndGet();
            if (!injected.getAndSet(true)) {
                // The CLI rewrites the file right after our read.
                Files.writeString(file, "{\"cliField\":\"second\",\"cliServer\":{\"x\":1}}",
                        StandardCharsets.UTF_8);
            }
            current.addProperty("pluginField", "kept");
            return w -> w.write(current.toString());
        });

        JsonObject after = JsonParser.parseString(
                Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
        assertEquals("two rounds are expected (conflict + re-apply)", 2, rounds.get());
        assertEquals("kept", after.get("pluginField").getAsString());
        assertEquals("the concurrently rewritten field must survive",
                "second", after.get("cliField").getAsString());
        assertTrue("the concurrently added server must survive", after.has("cliServer"));
    }

    /** A target created between the read and the write is detected and merged. */
    @Test
    public void mutationHandlesTargetCreatedAfterRead() throws Exception {
        Path file = tempDir.resolve("created.json");

        AtomicBoolean created = new AtomicBoolean(false);
        SafeJsonFileOps.mutateJsonAtomically(file, 3, 10, current -> {
            JsonObject document = current;
            if (!created.getAndSet(true)) {
                assertNull("the file is absent on the first read", current);
                Files.writeString(file, "{\"external\":true}", StandardCharsets.UTF_8);
            } else {
                assertNotNull("the retry must see the concurrently created file", current);
            }
            if (document == null) {
                document = new JsonObject();
            }
            document.addProperty("plugin", true);
            JsonObject toWrite = document;
            return w -> w.write(toWrite.toString());
        });

        JsonObject after = JsonParser.parseString(
                Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue("the concurrent content must be preserved", after.get("external").getAsBoolean());
        assertTrue("the mutation must be applied", after.get("plugin").getAsBoolean());
    }

    /** Exhausting the retry budget fails explicitly and keeps the newest content. */
    @Test
    public void mutationFailsAfterRetryBudgetWithoutOverwriting() throws Exception {
        Path file = tempDir.resolve("config.json");
        Files.writeString(file, "{\"external\":0}", StandardCharsets.UTF_8);

        AtomicInteger rounds = new AtomicInteger();
        try {
            SafeJsonFileOps.mutateJsonAtomically(file, 2, 5, current -> {
                int round = rounds.incrementAndGet();
                Files.writeString(file, "{\"external\":" + round + "}", StandardCharsets.UTF_8);
                current.addProperty("plugin", true);
                return w -> w.write(current.toString());
            });
            fail("expected the exhausted retry budget to be reported");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("kept changing concurrently"));
        }

        assertEquals("both configured rounds must run", 2, rounds.get());
        assertEquals("the newest external content must not be replaced by the stale snapshot",
                "{\"external\":2}", Files.readString(file, StandardCharsets.UTF_8));
        assertFalse("the stale snapshot must not leak into the file",
                Files.readString(file, StandardCharsets.UTF_8).contains("plugin"));
    }

    /** A RuntimeException from the writer callback must not leak the staged temp file. */
    @Test
    public void runtimeExceptionDoesNotLeakTempFile() throws Exception {
        Path file = tempDir.resolve("config.json");
        SafeJsonFileOps.writeAtomically(file, w -> w.write("{\"v\":1}"));
        try {
            SafeJsonFileOps.writeAtomically(file, w -> {
                w.write("{ half");
                throw new IllegalStateException("simulated Gson failure");
            });
            fail("expected the RuntimeException to propagate");
        } catch (IllegalStateException expected) {
            // expected
        }
        assertTrue("staged temp file must be cleaned up on RuntimeException",
                stagedTempFiles(tempDir).isEmpty());
        assertEquals("{\"v\":1}", Files.readString(file, StandardCharsets.UTF_8));
    }

    /** withLock serialises concurrent read-modify-write cycles in-process. */
    @Test
    public void withLockSerialisesConcurrentWriters() throws Exception {
        Path target = tempDir.resolve("counter.json");
        Path lock = tempDir.resolve("counter.json.ccgui-lock");
        SafeJsonFileOps.writeAtomically(target, w -> w.write("{\"count\":0}"));

        int threads = 8;
        int incrementsEach = 25;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<?>> futures = new ArrayList<>();
            for (int t = 0; t < threads; t++) {
                futures.add(pool.submit(() -> {
                    try {
                        start.await();
                        for (int i = 0; i < incrementsEach; i++) {
                            SafeJsonFileOps.withLock(lock, 5_000, () -> {
                                JsonObject doc = SafeJsonFileOps.readJsonObject(target, 3, 20);
                                if (doc == null) {
                                    doc = new JsonObject();
                                }
                                int count = doc.has("count") ? doc.get("count").getAsInt() : 0;
                                doc.addProperty("count", count + 1);
                                JsonObject finalDoc = doc;
                                SafeJsonFileOps.writeAtomically(target, w -> w.write(finalDoc.toString()));
                            });
                        }
                    } catch (Exception e) {
                        throw new RuntimeException(e);
                    }
                }));
            }
            start.countDown();
            for (Future<?> f : futures) {
                f.get(30, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        JsonObject finalDoc = JsonParser.parseString(
                Files.readString(target, StandardCharsets.UTF_8)).getAsJsonObject();
        assertEquals("every increment must survive (no lost updates)",
                threads * incrementsEach, finalDoc.get("count").getAsInt());
    }

    /** A nested withLock on the same thread re-enters the outer lock instead of failing. */
    @Test
    public void nestedWithLockOnSameThreadReenters() throws Exception {
        Path lock = tempDir.resolve("nested.json.ccgui-lock");
        AtomicInteger depth = new AtomicInteger();
        SafeJsonFileOps.withLock(lock, 1_000, () -> {
            depth.incrementAndGet();
            SafeJsonFileOps.withLock(lock, 1_000, depth::incrementAndGet);
        });
        assertEquals("the nested section must run exactly once", 2, depth.get());
    }

    /** A lock timeout is reported and the critical section does not run (review item 4). */
    @Test
    public void withLockTimeoutFailsWithoutRunningTheAction() throws Exception {
        Path lock = tempDir.resolve("timeout.json.ccgui-lock");
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicReference<Throwable> holderFailure = new AtomicReference<>();

        Thread holder = new Thread(() -> {
            try {
                SafeJsonFileOps.withLock(lock, 5_000, () -> {
                    held.countDown();
                    try {
                        release.await(10, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
            } catch (Throwable t) {
                holderFailure.set(t);
            }
        });
        holder.start();
        assertTrue("the competing holder must acquire the lock", held.await(5, TimeUnit.SECONDS));

        AtomicBoolean ran = new AtomicBoolean(false);
        try {
            SafeJsonFileOps.withLock(lock, 100, () -> ran.set(true));
            fail("the timeout must be reported to the caller");
        } catch (IOException expected) {
            assertTrue("the error must explain the timeout",
                    expected.getMessage().contains("Timed out"));
        } finally {
            release.countDown();
            holder.join(5_000);
        }

        assertNull("the holder itself must not fail", holderFailure.get());
        assertFalse("the critical section must not run without the lock", ran.get());
    }

    /** An interrupt while waiting for the lock is reported and the flag is preserved. */
    @Test
    public void withLockInterruptFailsAndPreservesTheInterruptFlag() throws Exception {
        Path lock = tempDir.resolve("interrupt.json.ccgui-lock");
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);

        Thread holder = new Thread(() -> {
            try {
                SafeJsonFileOps.withLock(lock, 5_000, () -> {
                    held.countDown();
                    try {
                        release.await(10, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                });
            } catch (Throwable ignored) {
                // the holder is released below
            }
        });
        holder.start();
        assertTrue("the competing holder must acquire the lock", held.await(5, TimeUnit.SECONDS));

        AtomicReference<Throwable> waiterFailure = new AtomicReference<>();
        AtomicBoolean interruptFlagSeen = new AtomicBoolean(false);
        AtomicBoolean ran = new AtomicBoolean(false);
        Thread waiter = new Thread(() -> {
            try {
                SafeJsonFileOps.withLock(lock, 30_000, () -> ran.set(true));
            } catch (Throwable t) {
                interruptFlagSeen.set(Thread.currentThread().isInterrupted());
                waiterFailure.set(t);
            }
        });
        waiter.start();
        try {
            // Deterministic sync point: wait until the waiter is actually blocked
            // on the lock instead of sleeping for a guessed interval.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            while (waiter.getState() != Thread.State.TIMED_WAITING && System.nanoTime() < deadline) {
                Thread.onSpinWait();
            }
            waiter.interrupt();
            waiter.join(10_000);
        } finally {
            release.countDown();
            holder.join(5_000);
        }

        assertTrue("the interrupted wait must be reported", waiterFailure.get() instanceof IOException);
        assertTrue("the thread interrupt status must be preserved", interruptFlagSeen.get());
        assertFalse("the critical section must not run after an interrupt", ran.get());
    }
}
