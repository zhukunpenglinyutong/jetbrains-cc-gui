package com.github.claudecodegui.provider.omp;

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

public class OmpHistoryReaderTest {

    @Test
    public void normalizePathConvertsBackslashesAndDriveCase() {
        assertEquals("c:/Users/83429/project",
                OmpHistoryReader.normalizePath("C:\\Users\\83429\\project"));
        assertEquals("c:/Users/83429/project",
                OmpHistoryReader.normalizePath("C:/Users/83429/project/"));
    }

    @Test
    public void pathsMatchIsCaseInsensitiveOnWindowsStylePaths() {
        assertTrue(OmpHistoryReader.pathsMatch(
                "C:\\Users\\83429\\AppData\\project",
                "c:/Users/83429/AppData/project"));
        assertFalse(OmpHistoryReader.pathsMatch(
                "C:\\Users\\83429\\project-a",
                "C:\\Users\\83429\\project-b"));
    }

    @Test
    public void listsAndLoadsSessionFromJsonl() throws Exception {
        Path root = Files.createTempDirectory("omp-history-test");
        Path cwdDir = root.resolve("--C-Users-83429-project--");
        Files.createDirectories(cwdDir);

        String sessionId = "019fe705-27fd-712e-a1be-f972ef3773f3";
        Path file = cwdDir.resolve("2026-08-09T14-55-02-653Z_" + sessionId + ".jsonl");
        // omp session files lead with a type=title line; the type=session header is line 2.
        String jsonl = ""
                + "{\"type\":\"title\",\"sessionId\":\"" + sessionId + "\",\"title\":\"hello from windows\"}\n"
                + "{\"type\":\"session\",\"version\":3,\"id\":\"" + sessionId
                + "\",\"timestamp\":\"2026-08-09T14:55:02.653Z\",\"cwd\":\"C:\\\\Users\\\\83429\\\\project\"}\n"
                + "{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"2026-08-09T14:55:02.745Z\","
                + "\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"hello from windows\"}]}}\n"
                + "{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"m1\",\"timestamp\":\"2026-08-09T14:55:03.000Z\","
                + "\"message\":{\"role\":\"assistant\",\"content\":["
                + "{\"type\":\"thinking\",\"thinking\":\"hi\"},"
                + "{\"type\":\"text\",\"text\":\"你好\"},"
                + "{\"type\":\"toolCall\",\"id\":\"tool_1\",\"name\":\"bash\",\"arguments\":{\"command\":\"dir\"}}"
                + "]}}\n"
                + "{\"type\":\"message\",\"id\":\"m3\",\"parentId\":\"m2\",\"timestamp\":\"2026-08-09T14:55:04.000Z\","
                + "\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"tool_1\",\"toolName\":\"bash\","
                + "\"content\":[{\"type\":\"text\",\"text\":\"file1.txt\"}],\"isError\":false}}\n";
        Files.writeString(file, jsonl, StandardCharsets.UTF_8);

        OmpHistoryReader reader = new OmpHistoryReader(root, new Gson());

        List<OmpHistoryReader.SessionInfo> listed =
                reader.listSessionsForProject("C:/Users/83429/project");
        assertEquals(1, listed.size());
        assertEquals(sessionId, listed.get(0).sessionId);
        assertTrue(listed.get(0).title.contains("hello from windows"));
        assertTrue(listed.get(0).messageCount >= 2);

        List<JsonObject> messages = reader.getSessionMessages(sessionId, "C:\\Users\\83429\\project");
        assertFalse(messages.isEmpty());
        assertEquals("user", messages.get(0).get("type").getAsString());
        // assistant text + thinking + tool_use + tool_result
        assertTrue(messages.size() >= 3);

        boolean hasToolUse = messages.stream().anyMatch(m -> {
            if (!m.has("message") || !m.get("message").isJsonObject()) {
                return false;
            }
            JsonObject msg = m.getAsJsonObject("message");
            if (!msg.has("content") || !msg.get("content").isJsonArray()) {
                return false;
            }
            return msg.getAsJsonArray("content").toString().contains("tool_use");
        });
        assertTrue(hasToolUse);

        assertTrue(reader.deleteSession(sessionId, "C:/Users/83429/project"));
        assertTrue(reader.listSessionsForProject("C:/Users/83429/project").isEmpty());
    }

    @Test
    public void resolvesSessionWhoseHeaderIsNotOnLineOne() throws Exception {
        Path root = Files.createTempDirectory("omp-history-header-scan-test");
        Path cwdDir = root.resolve("--tmp-scratch--");
        Files.createDirectories(cwdDir);

        String sessionId = "2a2b1c4e-5d60-4a70-8b81-9c92ad03bf04";
        // No filename hint (does not end with _<id>.jsonl nor contain the id) so only the
        // header scan can match; the type=session header sits on line 3 behind title lines.
        Path file = cwdDir.resolve("2026-08-10T09-00-00-000Z_unrelated-name.jsonl");
        String jsonl = ""
                + "{\"type\":\"title\",\"sessionId\":\"" + sessionId + "\",\"title\":\"scratch session\"}\n"
                + "{\"type\":\"model\",\"provider\":\"openai\",\"modelId\":\"gpt-5.5\"}\n"
                + "{\"type\":\"session\",\"version\":3,\"id\":\"" + sessionId
                + "\",\"timestamp\":\"2026-08-10T09:00:00.000Z\",\"cwd\":\"/tmp/scratch\"}\n"
                + "{\"type\":\"message\",\"id\":\"m1\",\"parentId\":null,\"timestamp\":\"2026-08-10T09:00:01.000Z\","
                + "\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"ping\"}]}}\n";
        Files.writeString(file, jsonl, StandardCharsets.UTF_8);

        OmpHistoryReader reader = new OmpHistoryReader(root, new Gson());

        List<JsonObject> messages = reader.getSessionMessages(sessionId, "/tmp/scratch");
        assertEquals(1, messages.size());
        assertEquals("user", messages.get(0).get("type").getAsString());

        assertTrue(reader.deleteSession(sessionId, "/tmp/scratch"));
        assertTrue(reader.listSessionsForProject("/tmp/scratch").isEmpty());
    }

    @Test
    public void rejectsPathLikeSessionIds() {
        assertFalse(OmpHistoryReader.isSafeSessionId("C:\\evil\\path"));
        assertFalse(OmpHistoryReader.isSafeSessionId("../escape"));
        assertTrue(OmpHistoryReader.isSafeSessionId("019fe705-27fd-712e-a1be-f972ef3773f3"));
    }
}
