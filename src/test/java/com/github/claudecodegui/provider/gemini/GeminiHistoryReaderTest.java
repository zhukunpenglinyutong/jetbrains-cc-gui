package com.github.claudecodegui.provider.gemini;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class GeminiHistoryReaderTest {

    @Rule
    public TemporaryFolder tempDir = new TemporaryFolder();

    @Test
    public void testListSessionsAndParseSummary() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "12345678-abcd-ef01-2345-6789abcdef01";
        File sessionDir = new File(brainDir, sessionId);
        File logsDir = new File(sessionDir, ".system_generated/logs");
        assertTrue(logsDir.mkdirs());

        File transcriptFile = new File(logsDir, "transcript.jsonl");
        String transcriptContent =
                "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"created_at\":\"2026-08-07T10:00:00Z\",\"content\":\"<USER_REQUEST>Test Gemini Request</USER_REQUEST>\"}\n" +
                "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-08-07T10:00:05Z\",\"content\":\"Here is the response\"}\n";
        Files.writeString(transcriptFile.toPath(), transcriptContent, StandardCharsets.UTF_8);

        String historyContent = "{\"conversationId\":\"" + sessionId + "\",\"workspace\":\"/test/project/path\"}\n";
        Files.writeString(historyFile.toPath(), historyContent, StandardCharsets.UTF_8);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        List<GeminiHistoryReader.SessionInfo> sessions = reader.listAllSessions();

        assertEquals(1, sessions.size());
        GeminiHistoryReader.SessionInfo info = sessions.get(0);
        assertEquals(sessionId, info.sessionId);
        assertEquals("Test Gemini Request", info.title);
        assertEquals(2, info.messageCount);
        assertEquals("/test/project/path", info.cwd);
        assertEquals("gemini", info.provider);

        String jsonResult = reader.getSessionsForProjectAsJson("/test/project/path");
        JsonObject json = JsonParser.parseString(jsonResult).getAsJsonObject();
        assertTrue(json.get("success").getAsBoolean());
        assertEquals(1, json.get("sessionCount").getAsInt());
    }

    @Test
    public void testDeleteSession() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "session-to-delete";
        File sessionDir = new File(brainDir, sessionId);
        assertTrue(sessionDir.mkdirs());
        File dummyFile = new File(sessionDir, "data.txt");
        assertTrue(dummyFile.createNewFile());

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        assertTrue(reader.deleteSession(sessionId));
        assertFalse(sessionDir.exists());
    }

    @Test
    public void testGetSessionMessages() throws Exception {
        File brainDir = tempDir.newFolder("brain");
        File historyFile = tempDir.newFile("history.jsonl");

        String sessionId = "session-messages-test";
        File sessionDir = new File(brainDir, sessionId);
        File logsDir = new File(sessionDir, ".system_generated/logs");
        assertTrue(logsDir.mkdirs());

        File transcriptFile = new File(logsDir, "transcript.jsonl");
        String transcriptContent =
                "{\"step_index\":0,\"source\":\"USER_EXPLICIT\",\"type\":\"USER_INPUT\",\"created_at\":\"2026-08-07T10:00:00Z\",\"content\":\"<USER_REQUEST>Hello AI</USER_REQUEST>\"}\n" +
                "{\"step_index\":1,\"source\":\"MODEL\",\"type\":\"PLANNER_RESPONSE\",\"created_at\":\"2026-08-07T10:00:05Z\",\"content\":\"Hello Human!\",\"tool_calls\":[{\"name\":\"view_file\",\"args\":{\"AbsolutePath\":\"/tmp/test\"}}]}\n" +
                "{\"step_index\":2,\"source\":\"MODEL\",\"type\":\"VIEW_FILE\",\"created_at\":\"2026-08-07T10:00:06Z\",\"content\":\"File content here\"}\n";
        Files.writeString(transcriptFile.toPath(), transcriptContent, StandardCharsets.UTF_8);

        GeminiHistoryReader reader = new GeminiHistoryReader(brainDir.toPath(), historyFile.toPath(), new Gson());
        List<JsonObject> messages = reader.getSessionMessages(sessionId, null);

        assertNotNull(messages);
        assertFalse(messages.isEmpty());

        // Should have user text message, assistant text + tool_use, and tool_result
        assertTrue(messages.size() >= 3);
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertEquals("assistant", messages.get(1).get("type").getAsString());

        String jsonMessages = reader.getSessionMessagesAsJson(sessionId);
        assertNotNull(jsonMessages);
        assertTrue(jsonMessages.contains("Hello Human!"));
    }
}
