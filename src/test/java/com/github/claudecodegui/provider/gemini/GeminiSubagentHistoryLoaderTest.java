package com.github.claudecodegui.provider.gemini;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class GeminiSubagentHistoryLoaderTest {

    private static final String PARENT_ID = "019fa70f-0653-73e2-a613-1fb0a9e83a2b";
    private static final String CHILD_A_ID = "019fb0fe-c344-7da0-9d10-20659f884100";
    private static final String CHILD_B_ID = "019fb0fe-c344-7da0-9d10-20659f884200";

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void parsesCompletionEnvelopeCorrectly() {
        String line = "[Message] timestamp=2026-10-12T22:12:54Z sender=" + CHILD_A_ID + " priority=MESSAGE_PRIORITY_HIGH content=Subagent completed successfully.";
        GeminiSubagentHistoryLoader.CompletionMessage msg = GeminiSubagentHistoryLoader.parseCompletionEnvelope(line);
        assertNotNull(msg);
        assertEquals(CHILD_A_ID, msg.sender());
        assertEquals("Subagent completed successfully.", msg.content());

        // Multi-line and control characters
        String multiLine = "System envelope header\n[Message] timestamp=2026-10-12T22:12:54Z sender=" + CHILD_B_ID + " priority=NORMAL content=Line 1\u0000\u0001\nTrailing garbage";
        GeminiSubagentHistoryLoader.CompletionMessage multiMsg = GeminiSubagentHistoryLoader.parseCompletionEnvelope(multiLine);
        assertNotNull(multiMsg);
        assertEquals(CHILD_B_ID, multiMsg.sender());
        assertEquals("Line 1", multiMsg.content());
    }

    @Test
    public void ignoresTaskSendersAndMalformedLines() {
        // Background command task sender containing /task-
        String task1 = "[Message] timestamp=2026-10-12T22:12:54Z sender=" + PARENT_ID + "/task-283 priority=MESSAGE_PRIORITY_HIGH content=Task finished";
        assertNull(GeminiSubagentHistoryLoader.parseCompletionEnvelope(task1));

        // Task sender starting with task-
        String task2 = "[Message] timestamp=2026-10-12T22:12:54Z sender=task-10 priority=MESSAGE_PRIORITY_HIGH content=Done";
        assertNull(GeminiSubagentHistoryLoader.parseCompletionEnvelope(task2));

        // Malformed line
        assertNull(GeminiSubagentHistoryLoader.parseCompletionEnvelope("Not a message line"));
        assertNull(GeminiSubagentHistoryLoader.parseCompletionEnvelope((byte[]) null));
        assertNull(GeminiSubagentHistoryLoader.parseCompletionEnvelope(""));
    }

    @Test
    public void loadsParentStep101CompletionsWithLatestStepPrecedence() throws Exception {
        Path home = temporaryFolder.newFolder("gemini-home").toPath();
        Path conversationsDir = home.resolve("conversations");
        Files.createDirectories(conversationsDir);

        Path parentDb = conversationsDir.resolve(PARENT_ID + ".db");
        createDb(parentDb,
                // Older completion for child A (idx 5)
                step(5, 101, "[Message] timestamp=2026-10-12T20:00:00Z sender=" + CHILD_A_ID + " priority=HIGH content=Older result"),
                // Task notification (idx 6) - should be ignored
                step(6, 101, "[Message] timestamp=2026-10-12T20:05:00Z sender=" + PARENT_ID + "/task-1 priority=HIGH content=Task done"),
                // Newer completion for child A (idx 10) - should win
                step(10, 101, "[Message] timestamp=2026-10-12T20:10:00Z sender=" + CHILD_A_ID + " priority=HIGH content=Latest result A"),
                // Completion for child B (idx 8)
                step(8, 101, "[Message] timestamp=2026-10-12T20:08:00Z sender=" + CHILD_B_ID + " priority=HIGH content=Result B"),
                // Normal user step (idx 1)
                step(1, 14, "User query")
        );

        GeminiSubagentHistoryLoader loader = new GeminiSubagentHistoryLoader(home);
        Map<String, String> completions = loader.loadParentStep101Completions(PARENT_ID);

        assertEquals(2, completions.size());
        assertEquals("Latest result A", completions.get(CHILD_A_ID.toLowerCase()));
        assertEquals("Result B", completions.get(CHILD_B_ID.toLowerCase()));
    }

    @Test
    public void loadStatusesReturnsRunningForMissingChildDbAndCompletedWhenStep101Present() throws Exception {
        Path home = temporaryFolder.newFolder("gemini-statuses").toPath();
        Path conversationsDir = home.resolve("conversations");
        Files.createDirectories(conversationsDir);

        Path parentDb = conversationsDir.resolve(PARENT_ID + ".db");
        createDb(parentDb,
                step(10, 101, "[Message] timestamp=2026-10-12T20:10:00Z sender=" + CHILD_A_ID + " priority=HIGH content=Done A")
        );

        // Child A DB exists
        createDb(conversationsDir.resolve(CHILD_A_ID + ".db"),
                step(1, 14, "child task")
        );

        // Child B DB does not exist yet

        GeminiSubagentHistoryLoader loader = new GeminiSubagentHistoryLoader(home);
        List<GeminiSubagentHistoryLoader.StatusResult> results = loader.loadStatuses(PARENT_ID, List.of(
                new GeminiSubagentHistoryLoader.StatusRequest("call-a", CHILD_A_ID),
                new GeminiSubagentHistoryLoader.StatusRequest("call-b", CHILD_B_ID),
                new GeminiSubagentHistoryLoader.StatusRequest("call-bad", "invalid/id")
        ));

        assertEquals(3, results.size());

        // Child A is completed
        GeminiSubagentHistoryLoader.StatusResult resA = results.get(0);
        assertEquals("call-a", resA.toolUseId());
        assertEquals(CHILD_A_ID, resA.agentId());
        assertTrue(resA.success());
        assertEquals("completed", resA.status());
        assertTrue(resA.completed());
        assertEquals("Done A", resA.resultText());
        assertNull(resA.error());

        // Child B is running (file not found yet)
        GeminiSubagentHistoryLoader.StatusResult resB = results.get(1);
        assertEquals("call-b", resB.toolUseId());
        assertEquals(CHILD_B_ID, resB.agentId());
        assertFalse(resB.success());
        assertEquals("running", resB.status());
        assertFalse(resB.completed());
        assertNull(resB.resultText());
        assertEquals("Subagent log not found yet", resB.error());

        // Child bad has invalid id
        GeminiSubagentHistoryLoader.StatusResult resBad = results.get(2);
        assertEquals("call-bad", resBad.toolUseId());
        assertFalse(resBad.success());
        assertEquals("error", resBad.status());
        assertEquals("Invalid agent id", resBad.error());

        assertNotNull(resA.messages());
    }

    @Test
    public void loadStatusesCompletesFromStep101WhenChildDbIsMissing() throws Exception {
        Path home = temporaryFolder.newFolder("gemini-missing-completed").toPath();
        Path conversationsDir = home.resolve("conversations");
        Files.createDirectories(conversationsDir);

        Path parentDb = conversationsDir.resolve(PARENT_ID + ".db");
        createDb(parentDb,
                step(10, 101, "[Message] timestamp=2026-10-12T20:10:00Z sender=" + CHILD_A_ID + " priority=HIGH content=Done without file")
        );

        GeminiSubagentHistoryLoader loader = new GeminiSubagentHistoryLoader(home);
        List<GeminiSubagentHistoryLoader.StatusResult> results = loader.loadStatuses(PARENT_ID, List.of(
                new GeminiSubagentHistoryLoader.StatusRequest("call-a", CHILD_A_ID)
        ));

        assertEquals(1, results.size());
        GeminiSubagentHistoryLoader.StatusResult res = results.get(0);
        assertTrue(res.success());
        assertEquals("completed", res.status());
        assertTrue(res.completed());
        assertEquals("Done without file", res.resultText());
        assertNull(res.error());
    }

    @Test
    public void loadStatusesKeepsExistingChildDbRunningWithoutMatchingSender() throws Exception {
        Path home = temporaryFolder.newFolder("gemini-running-child").toPath();
        Path conversationsDir = home.resolve("conversations");
        Files.createDirectories(conversationsDir);

        Path parentDb = conversationsDir.resolve(PARENT_ID + ".db");
        createDb(parentDb,
                step(10, 101, "[Message] timestamp=2026-10-12T20:10:00Z sender=" + CHILD_B_ID + " priority=HIGH content=Other child")
        );
        Path childDb = conversationsDir.resolve(CHILD_A_ID + ".db");
        createDbWithBlobs(childDb,
                blobStep(1, 14, protoMessage(19, protoField(2, "Still working")))
        );

        GeminiSubagentHistoryLoader loader = new GeminiSubagentHistoryLoader(home);
        List<GeminiSubagentHistoryLoader.StatusResult> results = loader.loadStatuses(PARENT_ID, List.of(
                new GeminiSubagentHistoryLoader.StatusRequest("call-a", CHILD_A_ID)
        ));

        assertEquals(1, results.size());
        GeminiSubagentHistoryLoader.StatusResult res = results.get(0);
        assertTrue(res.success());
        assertEquals("running", res.status());
        assertFalse(res.completed());
        assertNull(res.resultText());
        assertEquals(1, res.messages().size());
        assertEquals("Still working", textOf(res.messages().get(0)));
    }

    @Test
    public void loadChildSessionReturnsMessagesAndCompletionStatus() throws Exception {
        Path home = temporaryFolder.newFolder("gemini-session").toPath();
        Path conversationsDir = home.resolve("conversations");
        Files.createDirectories(conversationsDir);

        Path parentDb = conversationsDir.resolve(PARENT_ID + ".db");
        createDb(parentDb,
                step(10, 101, "[Message] timestamp=2026-10-12T20:10:00Z sender=" + CHILD_A_ID + " priority=HIGH content=Final answer")
        );

        // Child A DB with live-shaped messages
        Path childDb = conversationsDir.resolve(CHILD_A_ID + ".db");
        createDbWithBlobs(childDb,
                blobStep(1, 14, protoMessage(19, protoField(2, "Subagent task prompt"))),
                blobStep(2, 15, protoMessage(20, protoField(3, "Subagent response text")))
        );

        GeminiSubagentHistoryLoader loader = new GeminiSubagentHistoryLoader(home);
        GeminiSubagentHistoryLoader.SessionResult sessionResult = loader.loadChildSession(PARENT_ID, "call-a", CHILD_A_ID);

        assertTrue(sessionResult.success());
        assertEquals("completed", sessionResult.status());
        assertTrue(sessionResult.completed());
        assertEquals("Final answer", sessionResult.resultText());
        assertNotNull(sessionResult.messages());
        assertEquals(2, sessionResult.messages().size());
        assertEquals("Subagent task prompt", textOf(sessionResult.messages().get(0)));
        assertEquals("Subagent response text", textOf(sessionResult.messages().get(1)));
    }

    @Test
    public void loadChildSessionCompletesWhenChildDbIsMissing() throws Exception {
        Path home = temporaryFolder.newFolder("gemini-session-missing").toPath();
        Path conversationsDir = home.resolve("conversations");
        Files.createDirectories(conversationsDir);

        Path parentDb = conversationsDir.resolve(PARENT_ID + ".db");
        createDb(parentDb,
                step(10, 101, "[Message] timestamp=2026-10-12T20:10:00Z sender=" + CHILD_A_ID + " priority=HIGH content=Final without file")
        );

        GeminiSubagentHistoryLoader loader = new GeminiSubagentHistoryLoader(home);
        GeminiSubagentHistoryLoader.SessionResult sessionResult = loader.loadChildSession(PARENT_ID, "call-a", CHILD_A_ID);

        assertTrue(sessionResult.success());
        assertEquals("completed", sessionResult.status());
        assertTrue(sessionResult.completed());
        assertEquals("Final without file", sessionResult.resultText());
        assertTrue(sessionResult.messages().isEmpty());
    }

    private static String textOf(JsonObject message) {
        if (!message.has("message") || !message.getAsJsonObject("message").has("content")) {
            return null;
        }
        for (var el : message.getAsJsonObject("message").getAsJsonArray("content")) {
            JsonObject block = el.getAsJsonObject();
            if ("text".equals(block.get("type").getAsString())) {
                return block.get("text").getAsString();
            }
        }
        return null;
    }

    private record StepRow(int idx, int stepType, byte[] payload) {}

    private static StepRow step(int idx, int stepType, String text) {
        return new StepRow(idx, stepType, text.getBytes(StandardCharsets.UTF_8));
    }

    private static StepRow blobStep(int idx, int stepType, byte[] payload) {
        return new StepRow(idx, stepType, payload);
    }

    private static void createDb(Path db, StepRow... rows) throws Exception {
        Files.createDirectories(db.getParent());
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath());
             Statement statement = conn.createStatement()) {
            statement.execute("CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, step_payload BLOB)");
            for (StepRow row : rows) {
                try (PreparedStatement insert = conn.prepareStatement(
                        "INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)")) {
                    insert.setInt(1, row.idx);
                    insert.setInt(2, row.stepType);
                    insert.setBytes(3, row.payload);
                    insert.executeUpdate();
                }
            }
        }
    }

    private static void createDbWithBlobs(Path db, StepRow... rows) throws Exception {
        createDb(db, rows);
    }

    private static byte[] protoField(int fieldNumber, String value) {
        byte[] text = value.getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeVarint(out, ((long) fieldNumber << 3) | 2);
        writeVarint(out, text.length);
        out.writeBytes(text);
        return out.toByteArray();
    }

    private static byte[] protoMessage(int fieldNumber, byte[] content) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeVarint(out, ((long) fieldNumber << 3) | 2);
        writeVarint(out, content.length);
        out.writeBytes(content);
        return out.toByteArray();
    }

    private static void writeVarint(ByteArrayOutputStream out, long value) {
        long v = value;
        while ((v & ~0x7FL) != 0) {
            out.write((int) ((v & 0x7F) | 0x80));
            v >>>= 7;
        }
        out.write((int) v);
    }
}
