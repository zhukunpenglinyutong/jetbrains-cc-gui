package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.Gson;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class GrokHistoryReaderRestoreTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void missingRestoreIsReportedAsNotFoundWhileLegacyListingKeepsItsEmptyFallback() throws Exception {
        GrokHistoryReader reader = new GrokHistoryReader(temporary.newFolder("sessions").toPath(), new Gson());
        assertTrue(reader.getSessionMessages("missing-session", "/fixture").isEmpty());
        assertThrows(SessionHistoryNotFoundException.class,
                () -> reader.getSessionMessages("missing-session", "/fixture", () -> false));
    }

    @Test
    public void existingSessionDirectoryWithoutItsTranscriptStaysRetryable() throws Exception {
        Path sessions = temporary.newFolder("transcript-pending").toPath();
        Files.createDirectories(sessions.resolve("encoded-workspace").resolve("pending-session"));
        GrokHistoryReader reader = new GrokHistoryReader(sessions, new Gson());

        assertTrue(reader.getSessionMessages("pending-session", "/fixture").isEmpty());
        IOException error = assertThrows(IOException.class,
                () -> reader.getSessionMessages("pending-session", "/fixture", () -> false));
        assertFalse(error instanceof java.nio.file.NoSuchFileException);
    }

    @Test
    public void unreadableSessionsRootIsARetryableFailureInsteadOfMissingHistory() throws Exception {
        Assume.assumeTrue("POSIX permissions are required",
                FileSystems.getDefault().supportedFileAttributeViews().contains("posix"));
        Path sessions = temporary.newFolder("unreadable-sessions").toPath();
        Files.createDirectories(sessions.resolve("encoded-workspace"));
        Set<PosixFilePermission> original = Files.getPosixFilePermissions(sessions);
        Files.setPosixFilePermissions(sessions, Set.of());
        try {
            Assume.assumeTrue("Permission checks are bypassed for this user", !Files.isReadable(sessions));
            GrokHistoryReader reader = new GrokHistoryReader(sessions, new Gson());

            assertTrue(reader.getSessionMessages("session", "/fixture").isEmpty());
            assertThrows(IOException.class, () -> reader.getSessionMessages("session", "/fixture", () -> false));
        } finally {
            Files.setPosixFilePermissions(sessions, original);
        }
    }
}
