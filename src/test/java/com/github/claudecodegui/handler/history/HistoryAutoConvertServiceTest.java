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

    // ── test doubles ───────────────────────────────────────────────────────

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
