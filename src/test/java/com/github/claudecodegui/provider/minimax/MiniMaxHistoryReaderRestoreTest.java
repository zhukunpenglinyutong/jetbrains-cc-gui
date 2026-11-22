package com.github.claudecodegui.provider.minimax;

import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class MiniMaxHistoryReaderRestoreTest {
    @Rule
    public TemporaryFolder temporary = new TemporaryFolder();

    @Test
    public void emptySnapshotStillFallsBackToDisplayLogForOrdinaryAndStartupLoads() throws Exception {
        Path home = temporary.newFolder("minimax-fallback").toPath();
        Path session = home.resolve("v2/sessions/2026/08/26/10-20-30-session");
        Files.createDirectories(session);
        Files.writeString(session.resolve("snapshot.json"), """
                {"record":{"sessionId":"fallback","workspaceDir":"/repo"},"displayMessages":[]}
                """);
        Files.writeString(session.resolve("display.jsonl"), """
                {"kind":"message.display_upserted","msgId":"m1","seq":1,"message":{"role":"user","msg_content":"saved","timestamp":1}}
                """);
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        var ordinary = reader.getSessionMessages("fallback", "/repo");
        var restored = reader.getSessionMessages("fallback", "/repo", () -> false);
        assertEquals(1, ordinary.size());
        assertEquals(ordinary, restored);
        assertEquals("saved", ordinary.get(0).getAsJsonObject("message").getAsJsonArray("content")
                .get(0).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void existingSessionWithAnEmptySnapshotIsValidEmptyHistory() throws Exception {
        Path home = temporary.newFolder("minimax-empty").toPath();
        Path session = home.resolve("v2/sessions/2026/08/26/10-20-30-session");
        Files.createDirectories(session);
        Files.writeString(session.resolve("snapshot.json"), """
                {"record":{"sessionId":"empty","workspaceDir":"/repo"},"displayMessages":[]}
                """);
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());

        assertTrue(reader.getSessionMessages("empty", "/repo").isEmpty());
        assertTrue(reader.getSessionMessages("empty", "/repo", () -> false).isEmpty());
    }

    @Test
    public void snapshotBeingRewrittenCannotHideItsSessionAsMissing() throws Exception {
        Path home = temporary.newFolder("minimax-rewrite").toPath();
        Path session = home.resolve("v2/sessions/2026/08/26/10-20-30-session");
        Files.createDirectories(session);
        Files.writeString(session.resolve("snapshot.json"),
                "{\"record\":{\"sessionId\":\"partial\",\"workspaceDir\":\"/repo\"},\"displayMes");
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());

        assertTrue(reader.getSessionMessages("partial", "/repo").isEmpty());
        IOException error = assertThrows(IOException.class,
                () -> reader.getSessionMessages("partial", "/repo", () -> false));
        assertFalse(error instanceof java.nio.file.NoSuchFileException);
    }

    @Test
    public void corruptSnapshotOfAnotherSessionStillLetsMissingHistoryRetire() throws Exception {
        Path home = temporary.newFolder("minimax-other-corrupt").toPath();
        Path other = home.resolve("v2/sessions/2026/08/26/10-20-30-other");
        Files.createDirectories(other);
        Files.writeString(other.resolve("snapshot.json"), "{\"record\":{\"sessionId\":\"other\"");
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());

        assertThrows(SessionHistoryNotFoundException.class,
                () -> reader.getSessionMessages("missing-session", "/repo", () -> false));
    }

    @Test
    public void unidentifiableSessionDirectoryKeepsMissingHistoryRetryable() throws Exception {
        Path home = temporary.newFolder("minimax-unidentified").toPath();
        Path session = home.resolve("v2/sessions/2026/08/26/10-20-30-session");
        Files.createDirectories(session);
        // display.jsonl exists before the snapshot that names its session.
        Files.writeString(session.resolve("display.jsonl"), """
                {"kind":"message.display_upserted","msgId":"m1","seq":1,"message":{"role":"user","msg_content":"saved","timestamp":1}}
                """);
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());

        assertThrows(IOException.class, () -> reader.getSessionMessages("pending", "/repo", () -> false));
    }

    @Test
    public void snapshotWithoutDisplayMessagesIsValidEmptyHistory() throws Exception {
        Path home = temporary.newFolder("minimax-no-display").toPath();
        Path session = home.resolve("v2/sessions/2026/08/26/10-20-30-session");
        Files.createDirectories(session);
        Files.writeString(session.resolve("snapshot.json"), """
                {"record":{"sessionId":"fresh","workspaceDir":"/repo"}}
                """);
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());

        assertTrue(reader.getSessionMessages("fresh", "/repo", () -> false).isEmpty());
    }

    @Test
    public void resolvedSessionWhoseTranscriptTurnsUnreadableStaysRetryable() throws Exception {
        Path session = temporary.newFolder("minimax-race").toPath();
        // The snapshot was readable when the directory was resolved and is now mid-rewrite.
        Files.writeString(session.resolve("snapshot.json"), "{\"record\":{\"sessionId\":\"race\"},\"displayMes");
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(temporary.newFolder("minimax-race-home").toPath(), new Gson());

        assertTrue(reader.readSessionDirectory(session, "race", () -> false, false).isEmpty());
        IOException error = assertThrows(IOException.class,
                () -> reader.readSessionDirectory(session, "race", () -> false, true));
        assertFalse(error instanceof java.nio.file.NoSuchFileException);
    }

    @Test
    public void missingStartupTranscriptIsNotAnEmptySuccess() throws Exception {
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(temporary.newFolder("minimax-home").toPath(), new Gson());
        assertTrue(reader.getSessionMessages("missing-session", "/fixture").isEmpty());
        assertThrows(SessionHistoryNotFoundException.class,
                () -> reader.getSessionMessages("missing-session", "/fixture", () -> false));
    }
}
