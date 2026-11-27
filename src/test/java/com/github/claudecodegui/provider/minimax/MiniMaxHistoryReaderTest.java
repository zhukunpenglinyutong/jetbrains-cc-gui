package com.github.claudecodegui.provider.minimax;

import com.github.claudecodegui.provider.common.SessionHistoryNotFoundException;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Assume;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class MiniMaxHistoryReaderTest {

    private static Path writeSession(Path home, String dayDirName, String snapshotJson) throws Exception {
        Path sessionDir = home.resolve("v2").resolve("sessions")
                .resolve("2026").resolve("08").resolve("26")
                .resolve(dayDirName);
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("snapshot.json"), snapshotJson, StandardCharsets.UTF_8);
        return sessionDir;
    }

    private static String snapshot(String sessionId, String workspaceDir, String title,
                                   String displayMessages) {
        return """
                {
                  "record": {
                    "sessionId": "%s",
                    "workspaceDir": "%s",
                    "title": "%s",
                    "createdAtMs": 1000,
                    "updatedAtMs": 2000,
                    "effectiveModel": "minimax/MiniMax-M3"
                  },
                  "displayMessages": %s
                }
                """.formatted(jsonEscape(sessionId), jsonEscape(workspaceDir),
                jsonEscape(title), displayMessages);
    }

    // Snapshot fields are embedded into raw JSON — escape like a real writer would.
    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    @Test
    public void isSafeSessionIdRejectsTraversal() {
        assertFalse(MiniMaxHistoryReader.isSafeSessionId(null));
        assertFalse(MiniMaxHistoryReader.isSafeSessionId("  "));
        assertFalse(MiniMaxHistoryReader.isSafeSessionId(".."));
        assertFalse(MiniMaxHistoryReader.isSafeSessionId("../etc"));
        assertFalse(MiniMaxHistoryReader.isSafeSessionId("a/b"));
        assertFalse(MiniMaxHistoryReader.isSafeSessionId("a\\b"));
        assertFalse(MiniMaxHistoryReader.isSafeSessionId("a b"));
        assertTrue(MiniMaxHistoryReader.isSafeSessionId("mvs_abc-123.def"));
    }

    @Test
    public void pathsMatchNormalizesWindowsSeparators() {
        assertTrue(MiniMaxHistoryReader.pathsMatch(
                "C:\\Users\\83429\\project",
                "c:/Users/83429/project"));
        assertFalse(MiniMaxHistoryReader.pathsMatch(
                "C:\\Users\\83429\\a",
                "C:\\Users\\83429\\b"));
    }

    @Test
    public void listsAndLoadsSessionFromSnapshot() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        String display = """
                [
                  {"msg_id":"umsg_1","role":"user","msg_content":"hello minimax","timestamp":1},
                  {"msg_id":"amsg_2","role":"assistant","msg_content":"hi there",
                   "thinking_content":"pondering","timestamp":2,
                   "tool_calls":[{"tool_name":"bash","tool_call_id":"call_1",
                                  "tool_call_status":2,"tool_call_args":"{\\"command\\":\\"ls\\"}",
                                  "tool_call_result_data":"{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"file1.txt\\"}]}"}]}
                ]
                """;
        writeSession(home, "10-20-30-000-session_abc",
                snapshot("mvs_abc123", "C:\\Users\\83429\\project", "Review PR", display));

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());

        List<MiniMaxHistoryReader.SessionInfo> listed =
                reader.listSessionsForProject("c:/Users/83429/project");
        assertEquals(1, listed.size());
        assertEquals("mvs_abc123", listed.get(0).sessionId);
        assertEquals("Review PR", listed.get(0).title);
        assertEquals(2, listed.get(0).messageCount);
        assertEquals(2000L, listed.get(0).lastTimestamp);

        List<JsonObject> messages = reader.getSessionMessages("mvs_abc123", "C:\\Users\\83429\\project");
        // user text + assistant thinking + assistant text + tool_use + tool_result
        assertEquals(5, messages.size());

        assertEquals("user", messages.get(0).get("type").getAsString());
        assertEquals("text", messages.get(0).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());

        assertEquals("thinking", messages.get(1).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());

        assertEquals("text", messages.get(2).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());

        JsonObject toolUse = messages.get(3).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("bash", toolUse.get("name").getAsString());
        assertEquals("ls", toolUse.getAsJsonObject("input").get("command").getAsString());

        JsonObject toolResult = messages.stream()
                .map(m -> m.getAsJsonObject("message").getAsJsonArray("content")
                        .get(0).getAsJsonObject())
                .filter(b -> "tool_result".equals(b.get("type").getAsString()))
                .findFirst().orElseThrow();
        assertEquals("call_1", toolResult.get("tool_use_id").getAsString());
        assertEquals("file1.txt", toolResult.get("content").getAsString());
        assertFalse(toolResult.get("is_error").getAsBoolean());
    }

    @Test
    public void toolResultErrorFlagRequiresTopLevelErrorField() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        // Success output whose text merely quotes the word "error" must NOT be
        // flagged; a structured top-level "error" field must be.
        String display = """
                [
                  {"msg_id":"a1","role":"assistant","msg_content":"x",
                   "tool_calls":[{"tool_name":"bash","tool_call_id":"ok_call",
                                  "tool_call_status":2,
                                  "tool_call_result_data":"{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"{\\\\\\"error\\\\\\": false}\\"}]}"},
                                 {"tool_name":"bash","tool_call_id":"bad_call",
                                  "tool_call_status":2,
                                  "tool_call_result_data":"{\\"error\\":\\"command failed\\"}"}]}
                ]
                """;
        writeSession(home, "10-20-30-000-session_err",
                snapshot("mvs_err", "/repo", "t", display));

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages("mvs_err", "/repo");

        List<JsonObject> results = messages.stream()
                .map(m -> m.getAsJsonObject("message").getAsJsonArray("content")
                        .get(0).getAsJsonObject())
                .filter(b -> "tool_result".equals(b.get("type").getAsString()))
                .toList();
        assertEquals(2, results.size());
        JsonObject okResult = results.stream()
                .filter(b -> "ok_call".equals(b.get("tool_use_id").getAsString()))
                .findFirst().orElseThrow();
        JsonObject badResult = results.stream()
                .filter(b -> "bad_call".equals(b.get("tool_use_id").getAsString()))
                .findFirst().orElseThrow();
        assertFalse(okResult.get("is_error").getAsBoolean());
        assertTrue(badResult.get("is_error").getAsBoolean());
        assertEquals("command failed", badResult.get("content").getAsString());
    }

    @Test
    public void titleFallsBackToFirstUserMessageAndTruncates() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        String longPrompt = "x".repeat(200);
        String display = """
                [
                  {"msg_id":"u1","role":"user","msg_content":"%s","timestamp":1}
                ]
                """.formatted(longPrompt);
        // Blank title -> derive from first user message, truncated to 80 chars + ellipsis.
        writeSession(home, "10-20-30-000-session_title",
                snapshot("mvs_title", "/repo", "", display));

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        List<MiniMaxHistoryReader.SessionInfo> listed = reader.listSessionsForProject("/repo");
        assertEquals(1, listed.size());
        assertEquals(81, listed.get(0).title.length());
        assertTrue(listed.get(0).title.endsWith("…"));
    }

    @Test
    public void displayJsonlFallbackDeduplicatesUpsertsBySeq() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        // Snapshot without displayMessages -> replay display.jsonl.
        Path sessionDir = writeSession(home, "10-20-30-000-session_jsonl",
                """
                { "record": { "sessionId": "mvs_jsonl", "workspaceDir": "/repo",
                              "title": "jsonl", "createdAtMs": 1, "updatedAtMs": 2 } }
                """);
        String jsonl = ""
                + "{\"kind\":\"message.display_upserted\",\"msgId\":\"m1\",\"seq\":1,"
                + "\"message\":{\"role\":\"user\",\"msg_content\":\"first\",\"timestamp\":1}}\n"
                + "not json at all\n"
                + "{\"kind\":\"message.display_upserted\",\"msgId\":\"m2\",\"seq\":1,"
                + "\"message\":{\"role\":\"assistant\",\"msg_content\":\"draft\",\"timestamp\":2}}\n"
                + "{\"kind\":\"message.display_upserted\",\"msgId\":\"m2\",\"seq\":2,"
                + "\"message\":{\"role\":\"assistant\",\"msg_content\":\"final\",\"timestamp\":3}}\n"
                + "{\"kind\":\"other.event\",\"msgId\":\"m3\",\"seq\":1,"
                + "\"message\":{\"role\":\"user\",\"msg_content\":\"ignored\",\"timestamp\":4}}\n";
        Files.writeString(sessionDir.resolve("display.jsonl"), jsonl, StandardCharsets.UTF_8);

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages("mvs_jsonl", "/repo");

        assertEquals(2, messages.size());
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertEquals("first", messages.get(0).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("assistant", messages.get(1).get("type").getAsString());
        // Higher seq upsert wins over the earlier draft.
        assertEquals("final", messages.get(1).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
    }

    @Test
    public void deleteSessionRemovesDirAndPrunesEmptyDateDirs() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        Path sessionDir = writeSession(home, "10-20-30-000-session_del",
                snapshot("mvs_del", "/repo", "t", "[]"));

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        assertTrue(reader.deleteSession("mvs_del", "/repo"));
        assertFalse(Files.exists(sessionDir));
        // Empty YYYY/MM/DD chain is pruned; the sessions root itself stays.
        assertFalse(Files.exists(home.resolve("v2").resolve("sessions").resolve("2026")));
        assertTrue(Files.isDirectory(home.resolve("v2").resolve("sessions")));

        // Unknown or unsafe ids delete nothing.
        assertFalse(reader.deleteSession("mvs_missing", "/repo"));
        assertFalse(reader.deleteSession("../escape", "/repo"));
    }

    @Test
    public void deleteSessionDoesNotFollowSymlinks() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        Path sessionDir = writeSession(home, "10-20-30-000-session_link",
                snapshot("mvs_link", "/repo", "t", "[]"));

        // A symlink inside the session dir pointing outside must be removed as
        // a link — the target's contents must survive the session deletion.
        Path victimDir = Files.createDirectory(home.resolve("victim"));
        Path victimFile = Files.writeString(victimDir.resolve("keep.txt"), "keep");
        try {
            Files.createSymbolicLink(sessionDir.resolve("linked-dir"), victimDir);
        } catch (UnsupportedOperationException | IOException | SecurityException e) {
            Assume.assumeTrue("symlinks not supported on this platform", false);
        }

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        assertTrue(reader.deleteSession("mvs_link", "/repo"));
        assertFalse(Files.exists(sessionDir));
        assertTrue("symlink target contents must survive session deletion",
                Files.exists(victimFile));
    }

    @Test
    public void mapsLastAssistantUsageIntoGeneratedMessages() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        String display = """
                [
                  {"msg_id":"umsg_1","role":"user","msg_content":"hello","timestamp":1},
                  {"msg_id":"amsg_2","role":"assistant","msg_content":"first","timestamp":2},
                  {"msg_id":"amsg_3","role":"assistant","msg_content":"second","timestamp":3,
                   "usage":{"total_tokens":30248,"context_window":400000,
                            "input_tokens":23993,"output_tokens":493,"cache_read":5762}}
                ]
                """;
        writeSession(home, "11-22-33-000-session_usage",
                snapshot("mvs_usage1", "E:/test/project", "usage", display));

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        List<JsonObject> messages = reader.getSessionMessages("mvs_usage1", "E:/test/project");

        // user + two assistant text bubbles
        assertEquals(3, messages.size());
        JsonObject firstAssistant = messages.get(1);
        assertEquals("assistant", firstAssistant.get("type").getAsString());
        assertFalse(firstAssistant.has("usage"));

        JsonObject secondAssistant = messages.get(2);
        assertEquals("assistant", secondAssistant.get("type").getAsString());
        assertTrue(secondAssistant.has("usage"));
        JsonObject usage = secondAssistant.getAsJsonObject("usage");
        assertEquals(23993, usage.get("input_tokens").getAsInt());
        assertEquals(493, usage.get("output_tokens").getAsInt());
        assertEquals(30248, usage.get("total_tokens").getAsInt());
        assertEquals(5762, usage.get("cache_read_input_tokens").getAsInt());
        assertEquals(400000, usage.get("model_context_window").getAsInt());
        assertFalse(usage.has("cache_read"));
        assertFalse(usage.has("context_window"));
    }

    @Test
    public void resolveMinimaxHomeHonorsDataDirBeforeDefault() {
        // The official Windows shims export MINIMAX_DATA_DIR and the CLI keeps
        // config + v2/sessions there; history must read the same place.
        assertEquals(Path.of("D:\\tools\\mm-data"),
                MiniMaxHistoryReader.resolveMinimaxHome(null, null, "D:\\tools\\mm-data", "C:\\Users\\tester"));
        // Whitespace is trimmed like the other overrides.
        assertEquals(Path.of("D:\\tools\\mm-data"),
                MiniMaxHistoryReader.resolveMinimaxHome(null, null, "  D:\\tools\\mm-data  ", "C:\\Users\\tester"));
    }

    @Test
    public void resolveMinimaxHomeOverridesOutrankDataDir() {
        assertEquals(Path.of("E:\\plugin-home"),
                MiniMaxHistoryReader.resolveMinimaxHome("E:\\plugin-home", null, "D:\\tools\\mm-data", "C:\\Users\\tester"));
        assertEquals(Path.of("E:\\plugin-home"),
                MiniMaxHistoryReader.resolveMinimaxHome(null, "E:\\plugin-home", "D:\\tools\\mm-data", "C:\\Users\\tester"));
    }

    @Test
    public void resolveMinimaxHomeFallsBackToDefaultDotMinimax() {
        assertEquals(Path.of("C:\\Users\\tester", ".minimax"),
                MiniMaxHistoryReader.resolveMinimaxHome(null, null, null, "C:\\Users\\tester"));
    }

    // ------------------------------------------------------------------
    // mcode 0.7.x "v2-final-dated-session" layout (manifest.json + messages.jsonl)
    // ------------------------------------------------------------------

    private static String base64SessionId(String sessionId) {
        return Base64.getEncoder().encodeToString(sessionId.getBytes(StandardCharsets.UTF_8));
    }

    private static Path writeNewLayoutSession(Path home, String dayDirName, String sessionId,
                                              String manifestJson, String messagesJsonl) throws Exception {
        Path sessionDir = home.resolve("v2").resolve("sessions")
                .resolve("2026").resolve("11").resolve("25")
                .resolve(dayDirName + "-session_" + base64SessionId(sessionId));
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("manifest.json"), manifestJson, StandardCharsets.UTF_8);
        Files.writeString(sessionDir.resolve("messages.jsonl"), messagesJsonl, StandardCharsets.UTF_8);
        return sessionDir;
    }

    @Test
    public void listsAndLoadsNewLayoutSession() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        String messages = ""
                + "{\"message_id\":\"m1\",\"message\":{\"role\":\"user\",\"content\":["
                + "{\"type\":\"text\",\"text\":\"<system-reminder>injected</system-reminder>"
                + "<plugin-hook-context>context</plugin-hook-context>\\n\\n定制客运梳理\"}]}}\n"
                + "{\"message_id\":\"m2\",\"message\":{\"role\":\"assistant\",\"content\":["
                + "{\"type\":\"thinking\",\"thinking\":\"思考中\"},"
                + "{\"type\":\"text\",\"text\":\"先看结构\"},"
                + "{\"type\":\"toolCall\",\"id\":\"call-1\",\"name\":\"bash\","
                + "\"arguments\":{\"command\":\"ls\"}}]}}\n"
                + "{\"message_id\":\"m3\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"call-1\","
                + "\"content\":[{\"type\":\"text\",\"text\":\"file1.txt\"}]}}\n"
                + "{\"message_id\":\"m4\",\"message\":{\"role\":\"custom\",\"content\":[\"<\",\"s\"]}}\n"
                + "{\"message_id\":\"m5\",\"message\":{\"role\":\"user\",\"content\":["
                + "{\"type\":\"text\",\"text\":\"<system-reminder>only reminder</system-reminder>\"}]}}\n"
                + "{\"message_id\":\"m6\",\"message\":{\"role\":\"user\",\"content\":["
                + "{\"type\":\"text\",\"text\":\"第二个问题\"}]}}\n";
        Path sessionDir = writeNewLayoutSession(home, "01-22-29-003", "mvs_new123",
                """
                        {"schemaVersion":1,"sessionId":"mvs_new123","createdAtMs":1000,"updatedAtMs":2000,
                         "source":"local-runtime","layout":"v2-final-dated-session"}""",
                messages);

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());

        // Listing: no workspace persisted, yet the session must surface in a
        // project-filtered list, with the stripped first prompt as its title.
        List<MiniMaxHistoryReader.SessionInfo> listed =
                reader.listSessionsForProject("E:\\some\\other\\project");
        assertEquals(1, listed.size());
        assertEquals("mvs_new123", listed.get(0).sessionId);
        assertEquals("定制客运梳理", listed.get(0).title);
        assertNull(listed.get(0).cwd);
        assertEquals(6, listed.get(0).messageCount);
        assertEquals(2000L, listed.get(0).lastTimestamp);

        // Loading: restored transcript, cleaned and in order.
        List<JsonObject> messages_loaded = reader.getSessionMessages("mvs_new123", "E:\\some\\other\\project");
        assertEquals(6, messages_loaded.size());
        assertEquals("user", messages_loaded.get(0).get("type").getAsString());
        assertEquals("定制客运梳理", messages_loaded.get(0).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
        assertEquals("thinking", messages_loaded.get(1).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("思考中", messages_loaded.get(1).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("thinking").getAsString());
        assertEquals("text", messages_loaded.get(2).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("type").getAsString());
        assertEquals("先看结构", messages_loaded.get(2).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
        JsonObject toolUse = messages_loaded.get(3).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_use", toolUse.get("type").getAsString());
        assertEquals("bash", toolUse.get("name").getAsString());
        assertEquals("ls", toolUse.getAsJsonObject("input").get("command").getAsString());
        JsonObject toolResult = messages_loaded.get(4).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject();
        assertEquals("tool_result", toolResult.get("type").getAsString());
        assertEquals("call-1", toolResult.get("tool_use_id").getAsString());
        assertEquals("file1.txt", toolResult.get("content").getAsString());
        assertEquals("user", messages_loaded.get(5).get("type").getAsString());
        assertEquals("第二个问题", messages_loaded.get(5).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());

        // The dir-name fast path must find the session for deletion too.
        assertTrue(reader.deleteSession("mvs_new123", "E:\\some\\other\\project"));
        assertFalse(Files.exists(sessionDir));
    }

    @Test
    public void newLayoutMissingSessionBehavesLikeMissingHistory() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());

        // Ordinary loads and listings report nothing; strict loads raise NotFound
        // so the orchestrator retires the stale session id.
        assertTrue(reader.listSessionsForProject("/repo").isEmpty());
        assertTrue(reader.getSessionMessages("mvs_missing", "/repo").isEmpty());
        assertThrows(SessionHistoryNotFoundException.class,
                () -> reader.getSessionMessages("mvs_missing", "/repo", () -> false));
    }

    @Test
    public void newLayoutUnreadableManifestIsRetryableNotMissing() throws Exception {
        Path home = Files.createTempDirectory("minimax-history-test");
        String sessionId = "mvs_partial";
        Path sessionDir = home.resolve("v2").resolve("sessions")
                .resolve("2026").resolve("11").resolve("25")
                .resolve("01-22-29-003-session_" + base64SessionId(sessionId));
        Files.createDirectories(sessionDir);
        Files.writeString(sessionDir.resolve("manifest.json"),
                "{\"sessionId\":\"mvs_partial\", \"created", StandardCharsets.UTF_8);
        Files.writeString(sessionDir.resolve("messages.jsonl"),
                "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"saved\"}]}}\n",
                StandardCharsets.UTF_8);

        MiniMaxHistoryReader reader = new MiniMaxHistoryReader(home, new Gson());
        // The dir name still identifies the session; the readable transcript wins.
        List<JsonObject> messages = reader.getSessionMessages(sessionId, "/repo", () -> false);
        assertEquals(1, messages.size());
        assertEquals("saved", messages.get(0).getAsJsonObject("message")
                .getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString());
    }
}
