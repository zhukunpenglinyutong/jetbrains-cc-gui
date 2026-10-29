package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.provider.common.GitRepositorySessionMatcher;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.nio.file.Files;
import java.nio.file.Path;
import static com.github.claudecodegui.provider.common.GitHistoryTestRepositories.create;
import static org.junit.Assert.*;

public class CodexHistoryRepositoryMatchingTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    @After public void clearCaches() { SessionIndexCache.getInstance().clearAll(); }

    @Test public void addsMatchingClonesOnlyWhenOptedInAndRetainsLocalSessions() throws Exception {
        SessionIndexCache.getInstance().clearAll();
        Path root = tmp.getRoot().toPath();
        Path project = create(root.resolve("current"), "https://host/team/game.git");
        Path clone = create(root.resolve("clone"), "git@other:fork/game.git");
        Path other = create(root.resolve("other"), "https://host/team/other.git");
        Path sessions = Files.createDirectory(root.resolve("sessions"));
        writeSession(sessions, "aaaaaaaa-1111-4111-8111-111111111111", project);
        writeSession(sessions, "bbbbbbbb-2222-4222-8222-222222222222", clone);
        writeSession(sessions, "cccccccc-3333-4333-8333-333333333333", other);
        CodexHistoryReader reader = new CodexHistoryReader(sessions, new Gson(), new SessionIndexManager(root.resolve("cache")));
        assertEquals(1, JsonParser.parseString(reader.getSessionsForProjectAsJson(project.toString()))
                .getAsJsonObject().getAsJsonArray("sessions").size());
        JsonObject matched = JsonParser.parseString(reader.getSessionsForProjectAsJson(project.toString(),
                new GitRepositorySessionMatcher(project.toString()))).getAsJsonObject();
        assertEquals(2, matched.getAsJsonArray("sessions").size());
        assertEquals(2, matched.get("sessionCount").getAsInt());
    }

    @Test public void matchesExtendedWindowsCwdWithRepositoryMatchingDisabled() throws Exception {
        org.junit.Assume.assumeTrue(java.io.File.separatorChar == '\\');
        Path root = tmp.getRoot().toPath();
        Path project = Files.createDirectories(root.resolve("project"));
        Path sessions = Files.createDirectory(root.resolve("sessions"));
        writeSession(sessions, "dddddddd-4444-4444-8444-444444444444", "\\\\?\\" + project);
        writeSession(sessions, "eeeeeeee-5555-4555-8555-555555555555", "\\\\?\\" + project + "-other");
        CodexHistoryReader reader = new CodexHistoryReader(sessions, new Gson(), new SessionIndexManager(root.resolve("cache")));
        JsonObject result = JsonParser.parseString(reader.getSessionsForProjectAsJson(project.toString())).getAsJsonObject();
        assertTrue(result.get("success").getAsBoolean());
        assertEquals(1, result.getAsJsonArray("sessions").size());
        assertEquals("dddddddd-4444-4444-8444-444444444444", result.getAsJsonArray("sessions")
                .get(0).getAsJsonObject().get("sessionId").getAsString());
    }

    private static void writeSession(Path sessions, String id, Path cwd) throws Exception {
        writeSession(sessions, id, cwd.toString());
    }

    private static void writeSession(Path sessions, String id, String cwd) throws Exception {
        JsonObject metadata = new JsonObject();metadata.addProperty("type", "session_meta");
        JsonObject payload = new JsonObject();payload.addProperty("id", id);payload.addProperty("cwd", cwd.toString());
        payload.addProperty("timestamp", "2026-10-22T01:00:00Z");metadata.add("payload", payload);
        Files.writeString(sessions.resolve(id + ".jsonl"), metadata + "\n"
                + "{\"timestamp\":\"2026-10-22T01:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Repository history fixture\"}}\n"
                + "{\"timestamp\":\"2026-10-22T01:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}}\n");
    }
}
