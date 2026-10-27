package com.github.claudecodegui.handler.history;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Coverage for the shared {@code agent-*.jsonl} ownership check. Both the fork
 * (copy under the new id) and the delete path (remove the copies) rely on it, so a
 * drift here would either orphan sidecars or delete another session's transcripts.
 */
public class AgentFileMatcherTest {

    private static final String SESSION_ID = "11111111-2222-3333-4444-555555555555";
    private static final String OTHER_ID = "99999999-8888-7777-6666-555555555555";

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    private Path writeAgentFile(String name, List<String> lines) throws IOException {
        Path dir = temporaryFolder.getRoot().toPath();
        return Files.write(dir.resolve(name), lines, StandardCharsets.UTF_8);
    }

    @Test
    public void matchesSessionIdInTheHeadOfTheTranscript() throws IOException {
        Path agentFile = writeAgentFile("agent-head.jsonl", List.of(
                "{\"uuid\":\"a1\",\"sessionId\":\"" + SESSION_ID + "\",\"type\":\"assistant\"}"));

        assertTrue(AgentFileMatcher.isRelatedToSession(agentFile, SESSION_ID));
    }

    @Test
    public void matchesParentSessionIdInTheHeadOfTheTranscript() throws IOException {
        Path agentFile = writeAgentFile("agent-parent.jsonl", List.of(
                "{\"uuid\":\"a1\",\"parentSessionId\":\"" + SESSION_ID + "\"}"));

        assertTrue(AgentFileMatcher.isRelatedToSession(agentFile, SESSION_ID));
    }

    @Test
    public void ignoresReferencesBeyondTheScannedHead() throws IOException {
        // The check only reads the head; a session id that only shows up deep in the
        // transcript is treated as unrelated, matching the previous inline behaviour.
        List<String> lines = new ArrayList<>();
        for (int i = 0; i < 25; i++) {
            lines.add("{\"uuid\":\"filler-" + i + "\"}");
        }
        lines.add("{\"uuid\":\"late\",\"sessionId\":\"" + SESSION_ID + "\"}");
        Path agentFile = writeAgentFile("agent-late.jsonl", lines);

        assertFalse(AgentFileMatcher.isRelatedToSession(agentFile, SESSION_ID));
    }

    @Test
    public void rejectsNeighbouringSessionId() throws IOException {
        Path agentFile = writeAgentFile("agent-neighbour.jsonl", List.of(
                "{\"uuid\":\"a1\",\"sessionId\":\"" + OTHER_ID + "\"}"));

        assertFalse(AgentFileMatcher.isRelatedToSession(agentFile, SESSION_ID));
    }

    @Test
    public void rejectsBlankSessionIdWithoutTouchingTheFile() throws IOException {
        Path agentFile = writeAgentFile("agent-blank.jsonl", List.of(
                "{\"uuid\":\"a1\",\"sessionId\":\"" + SESSION_ID + "\"}"));

        assertFalse(AgentFileMatcher.isRelatedToSession(agentFile, null));
        assertFalse(AgentFileMatcher.isRelatedToSession(agentFile, ""));
    }

    @Test
    public void missingFileIsTreatedAsUnrelated() {
        Path missing = temporaryFolder.getRoot().toPath().resolve("agent-gone.jsonl");

        assertFalse(AgentFileMatcher.isRelatedToSession(missing, SESSION_ID));
    }
}
