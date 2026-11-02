package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
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

    @Test
    public void stripsGlobalGrokRulesAndAppendedContextFromRestoredUserMessagesAndTitle() throws Exception {
        Path sessionsRoot = temporary.newFolder("sessions-sanitize").toPath();
        String cwd = "/work/my-project";
        String encodedCwd = GrokHistoryReader.encodeCwd(cwd);
        Path sessionDir = sessionsRoot.resolve(encodedCwd).resolve("session-sanitize-1");
        Files.createDirectories(sessionDir);

        String chatHistory = "{\"type\":\"user\",\"content\":[{\"type\":\"text\",\"text\":"
                + "\"<user_query>hi\\n\\n## Global Grok Rules (~/.grok/grok-rules.md)\\n\\n- Never read large files\\n\\n"
                + "## IDE Context (opened files)\\n```json\\n{\\\"active\\\":\\\"App.java\\\"}\\n```</user_query>\"}]}\n"
                + "{\"type\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Hello!\"}]}\n";
        Files.writeString(sessionDir.resolve("chat_history.jsonl"), chatHistory, StandardCharsets.UTF_8);

        GrokHistoryReader reader = new GrokHistoryReader(sessionsRoot, new Gson());
        List<JsonObject> messages = reader.getSessionMessages("session-sanitize-1", cwd);
        assertEquals(2, messages.size());

        JsonObject userMsg = messages.get(0);
        String restoredText = userMsg.getAsJsonObject("message")
                .getAsJsonArray("content")
                .get(0).getAsJsonObject()
                .get("text").getAsString();
        assertEquals("hi", restoredText);

        List<GrokHistoryReader.SessionInfo> sessions = reader.listAllSessions();
        assertEquals(1, sessions.size());
        assertEquals("hi", sessions.get(0).title);
    }
}
