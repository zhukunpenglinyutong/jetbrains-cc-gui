package com.github.claudecodegui.provider.minimax;

import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.Gson;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
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
    public void missingStartupTranscriptIsNotAnEmptySuccess() throws Exception {
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(temporary.newFolder("minimax-home").toPath(), new Gson());
        assertTrue(reader.getSessionMessages("missing-session", "/fixture").isEmpty());
        assertThrows(SessionHistoryNotFoundException.class,
                () -> reader.getSessionMessages("missing-session", "/fixture", () -> false));
    }
}
