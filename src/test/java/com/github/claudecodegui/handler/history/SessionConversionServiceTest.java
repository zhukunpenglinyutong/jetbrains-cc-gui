package com.github.claudecodegui.handler.history;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Regression coverage for the per-row entrypoint rewrite that powers SDK-to-CLI session
 * conversion. The wider service does file I/O, but the rewrite decision is pure and is
 * where the convertible-vs-keep semantics live, so it is tested directly.
 */
public class SessionConversionServiceTest {

    // convertEntrypointInLine only touches the instance Gson, so a null context is fine.
    private final SessionConversionService service = new SessionConversionService(null);

    @Test
    public void rewritesSdkCliEntrypointToCli() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);

        String out = service.convertEntrypointInLine(
                "{\"entrypoint\":\"sdk-cli\",\"x\":1}", hasCli, modified);

        assertTrue(out.contains("\"entrypoint\":\"cli\""));
        assertEquals(1, modified.get());
        assertFalse(hasCli.get());
    }

    @Test
    public void rewritesClaudeVscodeEntrypointToCli() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);

        String out = service.convertEntrypointInLine(
                "{\"entrypoint\":\"claude-vscode\"}", hasCli, modified);

        assertTrue(out.contains("\"entrypoint\":\"cli\""));
        assertEquals(1, modified.get());
    }

    @Test
    public void leavesExistingCliSessionUnchangedAndFlagsIt() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);
        String line = "{\"entrypoint\":\"cli\"}";

        assertEquals(line, service.convertEntrypointInLine(line, hasCli, modified));
        assertEquals(0, modified.get());
        assertTrue("an existing cli row must flag the session as already-CLI", hasCli.get());
    }

    @Test
    public void leavesNonConvertibleKnownEntrypointUnchanged() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);
        String line = "{\"entrypoint\":\"remote\"}";

        assertEquals(line, service.convertEntrypointInLine(line, hasCli, modified));
        assertEquals(0, modified.get());
        assertFalse(hasCli.get());
    }

    @Test
    public void leavesRowWithoutEntrypointUnchanged() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);
        String line = "{\"type\":\"user\"}";

        assertEquals(line, service.convertEntrypointInLine(line, hasCli, modified));
        assertEquals(0, modified.get());
    }

    @Test
    public void keepsNonJsonRowUnchanged() {
        AtomicBoolean hasCli = new AtomicBoolean(false);
        AtomicInteger modified = new AtomicInteger(0);
        String line = "this is not json";

        assertEquals(line, service.convertEntrypointInLine(line, hasCli, modified));
        assertEquals(0, modified.get());
    }

    // ── H-1 / M-4: the file-level guard rails ──────────────────────────────

    /**
     * The caller's "is this session active?" check runs on the bridge thread, while the
     * rewrite itself runs later on a pooled thread. These tests drive
     * {@link SessionConversionService#convertSession} directly, which is exactly the
     * second half of that window.
     */
    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void refusesToRewriteASessionThatBecameActiveMidConversion() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-active").toPath();
        Path sessionFile = writeSdkSession(projectsDir, "abc-123");
        byte[] before = Files.readAllBytes(sessionFile);

        // The session was inactive when the command was accepted and is active by the
        // time the pooled thread reaches the swap.
        SessionConversionService racing = new SessionConversionService(null, () -> projectsDir) {
            @Override
            String activeSessionId() {
                return "abc-123";
            }
        };

        assertEquals("a session opened in the chat must not be rewritten underneath the SDK",
                ConversionResultCode.SESSION_ACTIVE, racing.convertSession("abc-123", null));
        assertArrayEquals("the session file must be byte-identical to what it was",
                before, Files.readAllBytes(sessionFile));
    }

    @Test
    public void rewritesWhenTheSessionStaysInactive() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-idle").toPath();
        Path sessionFile = writeSdkSession(projectsDir, "abc-456");

        SessionConversionService idle = new SessionConversionService(null, () -> projectsDir) {
            @Override
            String activeSessionId() {
                return "some-other-session";
            }
        };

        assertNull(idle.convertSession("abc-456", null));
        assertTrue(Files.readString(sessionFile, StandardCharsets.UTF_8).contains("\"entrypoint\":\"cli\""));
    }

    @Test
    public void unusableBackupNeverTouchesTheSessionFile() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-backup").toPath();
        Path sessionFile = writeSdkSession(projectsDir, "abc-789");
        byte[] before = Files.readAllBytes(sessionFile);

        // A backup that returns normally but holds only a fragment of the session. This
        // is the case the guard exists for: without the size check the service would
        // carry on and, on a later failure, move that 6-byte fragment back over the
        // session, truncating it to '{"typ'. The throwing variant of the same bug is
        // covered below and in HistoryAutoConvertServiceTest.
        SessionConversionService failing = new SessionConversionService(null, () -> projectsDir) {
            @Override
            void copyBackup(Path source, Path backup) throws IOException {
                try (OutputStream out = Files.newOutputStream(backup, StandardOpenOption.TRUNCATE_EXISTING)) {
                    out.write(Files.readAllBytes(source), 0, 6);
                }
            }
        };

        assertEquals(ConversionResultCode.CONVERSION_FAILED, failing.convertSession("abc-789", null));
        assertArrayEquals("a truncated backup must never be written back over the session",
                before, Files.readAllBytes(sessionFile));
    }

    @Test
    public void unusableBackupLeavesNoScratchFilesBehind() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-cleanup").toPath();
        writeSdkSession(projectsDir, "abc-000");
        Path projectDir = projectsDir.resolve("abc-000");

        SessionConversionService failing = new SessionConversionService(null, () -> projectsDir) {
            @Override
            void copyBackup(Path source, Path backup) throws IOException {
                try (OutputStream out = Files.newOutputStream(backup, StandardOpenOption.TRUNCATE_EXISTING)) {
                    out.write(Files.readAllBytes(source), 0, 6);
                }
            }
        };

        assertEquals(ConversionResultCode.CONVERSION_FAILED, failing.convertSession("abc-000", null));

        try (Stream<Path> entries = Files.list(projectDir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).sorted().collect(Collectors.toList());
            assertEquals(List.of("abc-000.jsonl"), names);
        }
    }

    // ── H-2: restore after a complete backup ───────────────────────────────
    //
    // The accepted path is the headline hardening here: a failure that happens after a
    // verified backup is the one case where the service can hand the user their session
    // back. The two size guards decide whether handing it back is safe, and the finally
    // block has to release the lock and remove the scratch files either way.
    //
    // The failure is injected at {@code afterCompleteBackup} rather than at
    // {@code copyBackup}, because the copyBackup variant lands on the "no complete
    // backup" branch — the opposite decision, already covered above.

    @Test
    public void failureAfterACompleteBackupRestoresTheSnapshotWhenTheSizeIsUnchanged() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-restore-same").toPath();
        String original = "{\"entrypoint\":\"sdk-cli\"}\n{\"type\":\"assistant\"}\n";
        Path sessionFile = writeSdkSession(projectsDir, "abc-101", original);

        SessionConversionService failing = new FailingAfterBackupService(projectsDir, Tamper.SAME_SIZE);

        assertEquals(ConversionResultCode.CONVERSION_FAILED, failing.convertSession("abc-101", null));

        // Same byte count as the snapshot, so the size guard let the restore through.
        // Only a restore that actually ran can put the original back.
        assertEquals("the complete backup must have been moved back over the session",
                original, Files.readString(sessionFile, StandardCharsets.UTF_8));
    }

    @Test
    public void failureAfterACompleteBackupRestoresTheSnapshotWhenTheFileShrank() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-restore-shrank").toPath();
        String original = "{\"entrypoint\":\"sdk-cli\"}\n{\"type\":\"assistant\"}\n{\"type\":\"user\"}\n";
        Path sessionFile = writeSdkSession(projectsDir, "abc-102", original);

        SessionConversionService failing = new FailingAfterBackupService(projectsDir, Tamper.SHRANK);

        assertEquals(ConversionResultCode.CONVERSION_FAILED, failing.convertSession("abc-102", null));

        assertEquals("a shrunken file must be put back from the verified backup",
                original, Files.readString(sessionFile, StandardCharsets.UTF_8));
    }

    @Test
    public void failureAfterACompleteBackupRefusesToRestoreOverAGrownFile() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-restore-grew").toPath();
        String original = "{\"entrypoint\":\"sdk-cli\"}\n{\"type\":\"assistant\"}\n";
        Path sessionFile = writeSdkSession(projectsDir, "abc-103", original);
        String grown = new String(appendPad(original.getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8);

        SessionConversionService failing = new FailingAfterBackupService(projectsDir, Tamper.GREW);

        assertEquals(ConversionResultCode.CONVERSION_FAILED, failing.convertSession("abc-103", null));

        // A writer appended after the snapshot: restoring would throw those rows away,
        // and rows newer than the backup are worth more than the older copy.
        assertEquals("the older snapshot must not overwrite a file that grew",
                grown, Files.readString(sessionFile, StandardCharsets.UTF_8));
    }

    @Test
    public void aRefusedRestoreStillReleasesTheLockAndRemovesEveryScratchFile() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-restore-cleanup").toPath();
        Path sessionFile = writeSdkSession(projectsDir, "abc-104");
        Path projectDir = projectsDir.resolve("abc-104");

        new FailingAfterBackupService(projectsDir, Tamper.GREW).convertSession("abc-104", null);

        // Both the backup and the converted temp file exist at the moment of failure, and
        // the session file is still locked by us. The finally block has to deal with all
        // three: leave exactly the session behind, nothing else.
        try (Stream<Path> entries = Files.list(projectDir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).sorted().collect(Collectors.toList());
            assertEquals(List.of("abc-104.jsonl"), names);
        }

        // A leaked lock would make the next tryLock return null — even for the same JVM
        // in the same thread — and the retry would report FILE_LOCKED instead of running.
        assertNull("the lock and channel must have been released before the restore could run",
                new SessionConversionService(null, () -> projectsDir).convertSession("abc-104", null));
        assertTrue(Files.readString(sessionFile, StandardCharsets.UTF_8).contains("\"entrypoint\":\"cli\""));
    }

    @Test
    public void anAcceptedRestoreAlsoLeavesOnlyTheSessionBehind() throws IOException {
        Path projectsDir = temporaryFolder.newFolder("projects-restore-accepted").toPath();
        writeSdkSession(projectsDir, "abc-106");
        Path projectDir = projectsDir.resolve("abc-106");

        new FailingAfterBackupService(projectsDir, Tamper.SAME_SIZE).convertSession("abc-106", null);

        // The restore is a move, so the backup is consumed by it; the temp file is not.
        try (Stream<Path> entries = Files.list(projectDir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).sorted().collect(Collectors.toList());
            assertEquals(List.of("abc-106.jsonl"), names);
        }
    }

    // ── test doubles ───────────────────────────────────────────────────────

    /** What the injected failure does to the session file between backup and restore. */
    private enum Tamper {
        /** Same byte count, different content: the size guard cannot see it. */
        SAME_SIZE,
        /** A concurrent writer appended, so the snapshot would lose those rows. */
        GREW,
        /** Something truncated the file, leaving the snapshot as the only good copy. */
        SHRANK
    }

    /**
     * Converter that fails at the {@code afterCompleteBackup} seam: it first changes the
     * session the way the named writer or truncation would, then aborts with the error a
     * rewrite that ran out of room would raise. Every assertion the tests make about
     * what is on disk afterwards is the production restore's own doing.
     */
    private static final class FailingAfterBackupService extends SessionConversionService {

        private final Tamper tamper;

        FailingAfterBackupService(Path projectsDir, Tamper tamper) {
            super(null, () -> projectsDir);
            this.tamper = tamper;
        }

        @Override
        void afterCompleteBackup(Path sessionFile) throws IOException {
            byte[] snapshot = Files.readAllBytes(sessionFile);
            byte[] tampered = switch (this.tamper) {
                case SAME_SIZE -> markTail(snapshot);
                case GREW -> appendPad(snapshot);
                case SHRANK -> cutTail(snapshot);
            };
            Files.write(sessionFile, tampered);
            throw new IOException("No space left on device while writing the converted session");
        }
    }

    /**
     * Offset just past the first newline. Every tamper leaves the first row alone on
     * purpose: it is the row that marks the file as SDK-created, and a clobbered head
     * would change what the service is being asked to do.
     */
    private static int endOfFirstLine(byte[] session) {
        for (int i = 0; i < session.length; i++) {
            if (session[i] == '\n') {
                return i + 1;
            }
        }
        return session.length;
    }

    /** Different bytes, identical length — the shape a size-based guard cannot reject. */
    private static byte[] markTail(byte[] session) {
        byte[] marked = Arrays.copyOf(session, session.length);
        Arrays.fill(marked, endOfFirstLine(session), marked.length, (byte) '#');
        return marked;
    }

    /** A concurrent writer appended past the snapshot. */
    private static byte[] appendPad(byte[] session) {
        byte[] grown = Arrays.copyOf(session, session.length + 24);
        Arrays.fill(grown, session.length, grown.length, (byte) 'x');
        return grown;
    }

    /** Something truncated the file after the snapshot was taken. */
    private static byte[] cutTail(byte[] session) {
        int head = endOfFirstLine(session);
        return Arrays.copyOf(session, head + (session.length - head) / 2);
    }

    /** Lay out {@code <projectsDir>/<sessionId>/<sessionId>.jsonl} the way the CLI does. */
    private static Path writeSdkSession(Path projectsDir, String sessionId) throws IOException {
        return writeSdkSession(projectsDir, sessionId, "{\"entrypoint\":\"sdk-cli\"}\n");
    }

    private static Path writeSdkSession(Path projectsDir, String sessionId, String content) throws IOException {
        Path projectDir = projectsDir.resolve(sessionId);
        Files.createDirectories(projectDir);
        Path file = projectDir.resolve(sessionId + ".jsonl");
        Files.writeString(file, content, StandardCharsets.UTF_8);
        return file;
    }
}
