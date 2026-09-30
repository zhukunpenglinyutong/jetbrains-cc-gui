package com.github.claudecodegui.handler.history;

import org.junit.Before;
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
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Coverage for the headless auto-converter that runs at IDE shutdown.
 *
 * <p>The service is pointed at a temporary projects directory instead of the real
 * {@code ~/.claude/projects}, so these tests never touch the developer's sessions.
 */
public class HistoryAutoConvertServiceTest {

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    private Path projectsDir;

    @Before
    public void createProjectsDir() throws IOException {
        projectsDir = temporaryFolder.newFolder("projects-root").toPath();
    }

    private HistoryAutoConvertService serviceFor(Path projectsDir) {
        return new HistoryAutoConvertService(() -> projectsDir);
    }

    private Path writeSession(String projectName, String fileName, String content) throws IOException {
        Path projectDir = projectsDir.resolve(projectName);
        Files.createDirectories(projectDir);
        Path file = projectDir.resolve(fileName);
        Files.writeString(file, content, StandardCharsets.UTF_8);
        return file;
    }

    private static List<String> linesOf(Path file) throws IOException {
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            return lines.collect(Collectors.toList());
        }
    }

    // ── entrypoint rewriting ───────────────────────────────────────────────

    @Test
    public void convertsSdkCliEntrypointToCli() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "{\"type\":\"user\",\"entrypoint\":\"sdk-cli\"}\n");

        assertEquals(1, serviceFor(projectsDir).convertAllProjects());

        assertEquals(List.of("{\"type\":\"user\",\"entrypoint\":\"cli\"}"), linesOf(file));
    }

    @Test
    public void convertsClaudeVscodeEntrypointToCli() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "{\"type\":\"user\",\"entrypoint\":\"claude-vscode\"}\n");

        assertEquals(1, serviceFor(projectsDir).convertAllProjects());

        assertTrue(linesOf(file).get(0).contains("\"entrypoint\":\"cli\""));
    }

    @Test
    public void leavesCliSessionByteForByteUntouched() throws IOException {
        String content = "{\"type\":\"user\",\"entrypoint\":\"cli\"}\n{\"type\":\"assistant\"}\n";
        Path file = writeSession("proj", "a.jsonl", content);
        byte[] before = Files.readAllBytes(file);
        long mtimeBefore = Files.getLastModifiedTime(file).toMillis();

        assertEquals(0, serviceFor(projectsDir).convertAllProjects());

        // Content AND mtime: a rewrite would change the mtime even with identical bytes.
        assertArrayEquals(before, Files.readAllBytes(file));
        assertEquals(mtimeBefore, Files.getLastModifiedTime(file).toMillis());
    }

    @Test
    public void leavesRowWithoutEntrypointVerbatim() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "{\"type\":\"user\"}\n");

        serviceFor(projectsDir).convertAllProjects();

        assertEquals(List.of("{\"type\":\"user\"}"), linesOf(file));
    }

    @Test
    public void leavesUnrecognizedEntrypointVerbatim() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "{\"entrypoint\":\"some-future-entrypoint\"}\n");

        assertEquals(0, serviceFor(projectsDir).convertAllProjects());

        assertEquals(List.of("{\"entrypoint\":\"some-future-entrypoint\"}"), linesOf(file));
    }

    @Test
    public void leavesRemoteEntrypointVerbatim() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "{\"entrypoint\":\"remote\"}\n");

        assertEquals(0, serviceFor(projectsDir).convertAllProjects());

        assertEquals(List.of("{\"entrypoint\":\"remote\"}"), linesOf(file));
    }

    @Test
    public void survivesMalformedLinesAcrossTheRewrite() throws IOException {
        // First line must be convertible so the file is rewritten at all; the garbage
        // line in the middle has to come through untouched.
        Path file = writeSession("proj", "a.jsonl",
                "{\"entrypoint\":\"sdk-cli\"}\nthis is not json\n{\"entrypoint\":\"claude-vscode\"}\n");

        assertEquals(1, serviceFor(projectsDir).convertAllProjects());

        List<String> lines = linesOf(file);
        assertEquals(3, lines.size());
        assertTrue(lines.get(0).contains("\"entrypoint\":\"cli\""));
        assertEquals("this is not json", lines.get(1));
        assertTrue(lines.get(2).contains("\"entrypoint\":\"cli\""));
    }

    @Test
    public void convertsEveryConvertibleRowInAFile() throws IOException {
        Path file = writeSession("proj", "a.jsonl",
                "{\"entrypoint\":\"sdk-cli\"}\n{\"entrypoint\":\"claude-vscode\"}\n{\"entrypoint\":\"remote\"}\n");

        assertEquals(1, serviceFor(projectsDir).convertAllProjects());

        List<String> lines = linesOf(file);
        assertTrue(lines.get(0).contains("\"entrypoint\":\"cli\""));
        assertTrue(lines.get(1).contains("\"entrypoint\":\"cli\""));
        assertEquals("{\"entrypoint\":\"remote\"}", lines.get(2));
    }

    // ── no-op cases ────────────────────────────────────────────────────────

    @Test
    public void emptyFileIsANoOp() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "");

        assertEquals(0, serviceFor(projectsDir).convertAllProjects());

        assertEquals("", Files.readString(file, StandardCharsets.UTF_8));
    }

    @Test
    public void singleCliLineIsANoOp() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "{\"entrypoint\":\"cli\"}\n");

        assertEquals(0, serviceFor(projectsDir).convertAllProjects());

        assertEquals(List.of("{\"entrypoint\":\"cli\"}"), linesOf(file));
    }

    @Test
    public void missingProjectsDirectoryIsANoOp() {
        Path absent = temporaryFolder.getRoot().toPath().resolve("nope");

        assertEquals(0, serviceFor(absent).convertAllProjects());
    }

    // ── multi-project / file handling ──────────────────────────────────────

    @Test
    public void convertsAcrossEveryProjectDirectory() throws IOException {
        writeSession("proj-one", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");
        writeSession("proj-two", "b.jsonl", "{\"entrypoint\":\"claude-vscode\"}\n");
        writeSession("proj-three", "c.jsonl", "{\"entrypoint\":\"cli\"}\n");

        assertEquals(2, serviceFor(projectsDir).convertAllProjects());
    }

    @Test
    public void ignoresNonJsonlFilesInProjectDirectory() throws IOException {
        Path projectDir = projectsDir.resolve("proj");
        Files.createDirectories(projectDir);
        // A stray non-JSONL file that would be rewritten if the filter were broken.
        Files.writeString(projectDir.resolve("notes.txt"), "{\"entrypoint\":\"sdk-cli\"}", StandardCharsets.UTF_8);
        writeSession("proj", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");

        assertEquals(1, serviceFor(projectsDir).convertAllProjects());

        assertEquals("{\"entrypoint\":\"sdk-cli\"}",
                Files.readString(projectDir.resolve("notes.txt"), StandardCharsets.UTF_8));
    }

    @Test
    public void convertedFileIsNotRewrittenOnASecondPass() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");

        HistoryAutoConvertService service = serviceFor(projectsDir);
        assertTrue(service.convertSessionFile(file));
        assertEquals(List.of("{\"entrypoint\":\"cli\"}"), linesOf(file));

        // A second pass is a no-op: the file is now already 'cli'.
        assertFalse(service.convertSessionFile(file));
        assertEquals(List.of("{\"entrypoint\":\"cli\"}"), linesOf(file));
    }

    @Test
    public void leavesNoTempOrBackupFilesBehind() throws IOException {
        Path projectDir = projectsDir.resolve("proj");
        Files.createDirectories(projectDir);
        writeSession("proj", "converted.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");
        writeSession("proj", "kept.jsonl", "{\"entrypoint\":\"cli\"}\n");

        serviceFor(projectsDir).convertAllProjects();

        try (Stream<Path> entries = Files.list(projectDir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).sorted().collect(Collectors.toList());
            assertEquals(List.of("converted.jsonl", "kept.jsonl"), names);
        }
    }

    // ── H-1: a failed backup must never be written back over the session ────

    @Test
    public void interruptedBackupCopyLeavesTheSessionFileUntouched() throws IOException {
        String content = "{\"entrypoint\":\"sdk-cli\"}\n{\"type\":\"assistant\"}\n";
        Path file = writeSession("proj", "a.jsonl", content);
        byte[] before = Files.readAllBytes(file);

        // A copy that dies after writing only the first few bytes, the way ENOSPC, EIO
        // or a network home going away does.
        HistoryAutoConvertService service = new InterruptibleBackupService(projectsDir, 5);

        assertFalse("a failed copy must not report a conversion", service.convertSessionFile(file));

        // The whole point: the session is still the complete original, not the 5-byte
        // fragment that is sitting in the temp file.
        assertArrayEquals(before, Files.readAllBytes(file));
        assertEquals(content, Files.readString(file, StandardCharsets.UTF_8));
    }

    @Test
    public void backupCopyThatWroteNothingLeavesTheSessionFileUntouched() throws IOException {
        Path file = writeSession("proj", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");
        byte[] before = Files.readAllBytes(file);

        HistoryAutoConvertService service = new InterruptibleBackupService(projectsDir, 0);

        assertFalse(service.convertSessionFile(file));
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    public void shortBackupThatReturnsWithoutErrorIsAlsoDistrusted() throws IOException {
        // A copy that reports success but wrote fewer bytes is exactly as dangerous as
        // one that threw: restoring it would truncate the session to a prefix.
        Path file = writeSession("proj", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");
        byte[] before = Files.readAllBytes(file);

        HistoryAutoConvertService service = new ShortBackupService(projectsDir, 4);

        assertFalse(service.convertSessionFile(file));
        assertArrayEquals(before, Files.readAllBytes(file));
    }

    @Test
    public void interruptedBackupLeavesNoScratchFilesBehind() throws IOException {
        Path projectDir = projectsDir.resolve("proj");
        Files.createDirectories(projectDir);
        writeSession("proj", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");

        new InterruptibleBackupService(projectsDir, 5).convertAllProjects();

        try (Stream<Path> entries = Files.list(projectDir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).sorted().collect(Collectors.toList());
            assertEquals(List.of("a.jsonl"), names);
        }
    }

    // ── M-6: size budgets ──────────────────────────────────────────────────

    @Test
    public void oversizedSessionIsSkippedAndNeverTruncated() throws IOException {
        String content = "{\"entrypoint\":\"sdk-cli\"}\n" + "{\"pad\":\"0123456789\"}\n".repeat(20);
        Path file = writeSession("proj", "big.jsonl", content);
        byte[] before = Files.readAllBytes(file);

        HistoryAutoConvertService service = new BudgetedService(projectsDir, 64L, Long.MAX_VALUE);

        assertEquals(0, service.convertAllProjects());
        assertArrayEquals("an oversized session must be left exactly as it was",
                before, Files.readAllBytes(file));
    }

    @Test
    public void runStopsOnceTheTotalByteBudgetIsSpent() throws IOException {
        // Two convertible sessions whose combined size is above the run budget: the
        // first one converts, the second is left for a later run. The order inside a
        // directory is not defined, so the assertion is on the count, not the name.
        writeSession("proj", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");
        writeSession("proj", "b.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");
        long oneSession = Files.size(projectsDir.resolve("proj").resolve("a.jsonl"));

        HistoryAutoConvertService service = new BudgetedService(projectsDir, Long.MAX_VALUE, oneSession);

        assertEquals(1, service.convertAllProjects());
    }

    // ── M-7: per-run file count ────────────────────────────────────────────

    @Test
    public void defaultFileLimitIsTheDocumentedCap() {
        // Guards the constant against an edit that silently changes how much work a
        // shutdown run is allowed to do.
        assertEquals(2000, serviceFor(projectsDir).getMaxFilesPerRun());
    }

    @Test
    public void runStopsOnceThePerRunFileCountIsSpent() throws IOException {
        // One convertible session per project directory, so a cap of one has to stop
        // the run after the first directory and leave the second for a later run.
        writeSession("proj-one", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");
        writeSession("proj-two", "b.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");

        HistoryAutoConvertService service = new FileLimitedService(projectsDir, 1);

        assertEquals(1, service.convertAllProjects());
    }

    @Test
    public void perRunFileCountLimitLeavesNoScratchFilesBehind() throws IOException {
        Path projectDir = projectsDir.resolve("proj-one");
        Files.createDirectories(projectDir);
        writeSession("proj-one", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");
        writeSession("proj-two", "b.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");

        new FileLimitedService(projectsDir, 1).convertAllProjects();

        try (Stream<Path> entries = Files.list(projectDir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).sorted().collect(Collectors.toList());
            assertEquals(List.of("a.jsonl"), names);
        }
    }

    // ── H-2: restore after a complete backup ───────────────────────────────

    @Test
    public void failureAfterACompleteBackupRestoresTheSnapshotWhenTheSizeIsUnchanged() throws IOException {
        String original = "{\"entrypoint\":\"sdk-cli\"}\n{\"type\":\"assistant\"}\n";
        Path file = writeSession("proj", "a.jsonl", original);

        HistoryAutoConvertService service = new FailingAfterBackupService(projectsDir, Tamper.SAME_SIZE);

        assertFalse("a failed rewrite must not report a conversion", service.convertSessionFile(file));

        // Same byte count as the snapshot, so the size guard let the restore through.
        // Only a restore that actually ran can put the original back.
        assertEquals("the complete backup must have been moved back over the session",
                original, Files.readString(file, StandardCharsets.UTF_8));
    }

    @Test
    public void failureAfterACompleteBackupRestoresTheSnapshotWhenTheFileShrank() throws IOException {
        String original = "{\"entrypoint\":\"sdk-cli\"}\n{\"type\":\"assistant\"}\n{\"type\":\"user\"}\n";
        Path file = writeSession("proj", "a.jsonl", original);

        HistoryAutoConvertService service = new FailingAfterBackupService(projectsDir, Tamper.SHRANK);

        assertFalse(service.convertSessionFile(file));

        assertEquals("a shrunken file must be put back from the verified backup",
                original, Files.readString(file, StandardCharsets.UTF_8));
    }

    @Test
    public void failureAfterACompleteBackupRefusesToRestoreOverAGrownFile() throws IOException {
        String original = "{\"entrypoint\":\"sdk-cli\"}\n{\"type\":\"assistant\"}\n";
        Path file = writeSession("proj", "a.jsonl", original);
        String grown = new String(appendPad(original.getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8);

        HistoryAutoConvertService service = new FailingAfterBackupService(projectsDir, Tamper.GREW);

        assertFalse(service.convertSessionFile(file));

        // A writer appended after the snapshot: restoring would throw those rows away,
        // and rows newer than the backup are worth more than the older copy.
        assertEquals("the older snapshot must not overwrite a file that grew",
                grown, Files.readString(file, StandardCharsets.UTF_8));
    }

    @Test
    public void aRefusedRestoreStillCleansUpEveryScratchFile() throws IOException {
        Path projectDir = projectsDir.resolve("proj");
        Files.createDirectories(projectDir);
        Path file = writeSession("proj", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");

        new FailingAfterBackupService(projectsDir, Tamper.GREW).convertSessionFile(file);

        // The backup is the only scratch file here, and the finally block has to remove
        // it even though the restore deliberately left it alone.
        try (Stream<Path> entries = Files.list(projectDir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).sorted().collect(Collectors.toList());
            assertEquals(List.of("a.jsonl"), names);
        }
    }

    @Test
    public void anAcceptedRestoreAlsoLeavesNoScratchFilesBehind() throws IOException {
        Path projectDir = projectsDir.resolve("proj");
        Files.createDirectories(projectDir);
        Path file = writeSession("proj", "a.jsonl", "{\"entrypoint\":\"sdk-cli\"}\n");

        new FailingAfterBackupService(projectsDir, Tamper.SAME_SIZE).convertSessionFile(file);

        try (Stream<Path> entries = Files.list(projectDir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).sorted().collect(Collectors.toList());
            assertEquals(List.of("a.jsonl"), names);
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
     * Service that fails at the {@code afterCompleteBackup} seam: it first changes the
     * session the way the named writer or truncation would, then aborts with the error a
     * rewrite that ran out of room would raise. Everything the test observes afterwards —
     * the restore, the guards, the cleanup — is the production code's own doing.
     */
    private static final class FailingAfterBackupService extends HistoryAutoConvertService {

        private final Tamper tamper;

        FailingAfterBackupService(Path projectsDir, Tamper tamper) {
            super(() -> projectsDir);
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
     * purpose: {@code needsConversion} sniffs it to decide the file is convertible at
     * all, and a clobbered head would make the service return before it ever took a
     * backup — the very path under test would never be reached.
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

    /** Service that converts at most {@code maxFilesPerRun} sessions per run. */
    private static final class FileLimitedService extends HistoryAutoConvertService {

        private final int maxFilesPerRun;

        FileLimitedService(Path projectsDir, int maxFilesPerRun) {
            super(() -> projectsDir);
            this.maxFilesPerRun = maxFilesPerRun;
        }

        @Override
        int getMaxFilesPerRun() {
            return this.maxFilesPerRun;
        }
    }

    /**
     * Backup copy that writes {@code bytesBeforeFailure} bytes and then fails, which
     * is what an interrupted {@code Files.copy} leaves on disk.
     */
    private static final class InterruptibleBackupService extends HistoryAutoConvertService {

        private final int bytesBeforeFailure;

        InterruptibleBackupService(Path projectsDir, int bytesBeforeFailure) {
            super(() -> projectsDir);
            this.bytesBeforeFailure = bytesBeforeFailure;
        }

        @Override
        void copyBackup(Path source, Path backup) throws IOException {
            if (this.bytesBeforeFailure > 0) {
                try (OutputStream out = Files.newOutputStream(backup, StandardOpenOption.TRUNCATE_EXISTING)) {
                    out.write(Files.readAllBytes(source), 0, this.bytesBeforeFailure);
                }
            }
            throw new IOException("No space left on device");
        }
    }

    /** Backup copy that returns normally after writing only a prefix of the source. */
    private static final class ShortBackupService extends HistoryAutoConvertService {

        private final int bytesWritten;

        ShortBackupService(Path projectsDir, int bytesWritten) {
            super(() -> projectsDir);
            this.bytesWritten = bytesWritten;
        }

        @Override
        void copyBackup(Path source, Path backup) throws IOException {
            try (OutputStream out = Files.newOutputStream(backup, StandardOpenOption.TRUNCATE_EXISTING)) {
                out.write(Files.readAllBytes(source), 0, this.bytesWritten);
            }
        }
    }

    /** Service with tiny size budgets, so the limits can be tested without big files. */
    private static final class BudgetedService extends HistoryAutoConvertService {

        private final long maxSessionFileSizeBytes;
        private final long maxTotalBytesPerRun;

        BudgetedService(Path projectsDir, long maxSessionFileSizeBytes, long maxTotalBytesPerRun) {
            super(() -> projectsDir);
            this.maxSessionFileSizeBytes = maxSessionFileSizeBytes;
            this.maxTotalBytesPerRun = maxTotalBytesPerRun;
        }

        @Override
        long getMaxSessionFileSizeBytes() {
            return this.maxSessionFileSizeBytes;
        }

        @Override
        long getMaxTotalBytesPerRun() {
            return this.maxTotalBytesPerRun;
        }
    }
}
