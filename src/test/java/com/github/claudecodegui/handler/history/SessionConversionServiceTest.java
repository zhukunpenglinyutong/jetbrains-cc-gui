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
        // covered in HistoryAutoConvertServiceTest — the IntelliJ test logger turns the
        // LOG.error in this service's catch block into a test failure, which aborts the
        // very block under test.
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

    /** Lay out {@code <projectsDir>/<sessionId>/<sessionId>.jsonl} the way the CLI does. */
    private static Path writeSdkSession(Path projectsDir, String sessionId) throws IOException {
        Path projectDir = projectsDir.resolve(sessionId);
        Files.createDirectories(projectDir);
        Path file = projectDir.resolve(sessionId + ".jsonl");
        Files.writeString(file, "{\"entrypoint\":\"sdk-cli\"}\n", StandardCharsets.UTF_8);
        return file;
    }
}
