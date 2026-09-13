package com.github.claudecodegui.provider.kimi;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class KimiHistoryReaderTest {

    @Test
    public void pathsMatchNormalizesWindowsSeparators() {
        assertTrue(KimiHistoryReader.pathsMatch(
                "C:\\Users\\83429\\project",
                "c:/Users/83429/project"));
        assertFalse(KimiHistoryReader.pathsMatch(
                "C:\\Users\\83429\\a",
                "C:\\Users\\83429\\b"));
    }

    @Test
    public void listsAndLoadsSessionFromStateAndWire() throws Exception {
        Path home = Files.createTempDirectory("kimi-history-test");
        String sessionId = "session_de850817-a553-410e-ad95-9ccbb2ae748d";
        Path sessionDir = home.resolve("sessions")
                .resolve("wd_project_abc")
                .resolve(sessionId);
        Files.createDirectories(sessionDir.resolve("agents").resolve("main"));

        Files.writeString(sessionDir.resolve("state.json"), """
                {
                  "createdAt": "2026-07-24T10:45:31.555Z",
                  "updatedAt": "2026-07-24T10:47:59.808Z",
                  "title": "Windows Kimi review",
                  "workDir": "C:\\\\Users\\\\83429\\\\project",
                  "lastPrompt": "hello kimi"
                }
                """, StandardCharsets.UTF_8);

        Path wire = sessionDir.resolve("agents").resolve("main").resolve("wire.jsonl");
        String wireJsonl = ""
                + "{\"type\":\"metadata\",\"protocol_version\":\"1.4\"}\n"
                + "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":["
                + "{\"type\":\"text\",\"text\":\"hello from windows\"}]},\"time\":1000}\n"
                + "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\","
                + "\"part\":{\"type\":\"think\",\"think\":\"thinking...\"}},\"time\":1001}\n"
                + "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\","
                + "\"part\":{\"type\":\"text\",\"text\":\"你好\"}},\"time\":1002}\n"
                + "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\","
                + "\"toolCallId\":\"tool_1\",\"name\":\"Bash\",\"args\":{\"command\":\"dir\"}},\"time\":1003}\n"
                + "{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.result\","
                + "\"toolCallId\":\"tool_1\",\"result\":{\"output\":\"file1.txt\"}},\"time\":1004}\n";
        Files.writeString(wire, wireJsonl, StandardCharsets.UTF_8);

        KimiHistoryReader reader = new KimiHistoryReader(home, new Gson());

        List<KimiHistoryReader.SessionInfo> listed =
                reader.listSessionsForProject("C:/Users/83429/project");
        assertEquals(1, listed.size());
        assertEquals(sessionId, listed.get(0).sessionId);
        assertEquals("Windows Kimi review", listed.get(0).title);
        assertTrue(listed.get(0).messageCount >= 2);

        List<JsonObject> messages = reader.getSessionMessages(sessionId, "C:\\Users\\83429\\project");
        assertFalse(messages.isEmpty());
        assertEquals("user", messages.get(0).get("type").getAsString());

        boolean hasThink = messages.stream().anyMatch(m ->
                m.has("message")
                        && m.getAsJsonObject("message").has("content")
                        && m.getAsJsonObject("message").getAsJsonArray("content").toString().contains("thinking"));
        boolean hasTool = messages.stream().anyMatch(m ->
                m.has("message")
                        && m.getAsJsonObject("message").has("content")
                        && m.getAsJsonObject("message").getAsJsonArray("content").toString().contains("tool_use"));
        boolean hasToolResult = messages.stream().anyMatch(m ->
                m.has("message")
                        && m.getAsJsonObject("message").has("content")
                        && m.getAsJsonObject("message").getAsJsonArray("content").toString().contains("tool_result"));
        assertTrue(hasThink);
        assertTrue(hasTool);
        assertTrue(hasToolResult);

        assertTrue(reader.deleteSession(sessionId, "C:/Users/83429/project"));
        assertTrue(reader.listSessionsForProject("C:/Users/83429/project").isEmpty());
    }

    @Test
    public void rejectsUnsafeSessionIds() {
        assertFalse(KimiHistoryReader.isSafeSessionId("../escape"));
        assertFalse(KimiHistoryReader.isSafeSessionId("C:\\evil"));
        assertTrue(KimiHistoryReader.isSafeSessionId("session_de850817-a553-410e-ad95-9ccbb2ae748d"));
    }
}
