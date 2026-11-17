package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.util.ClaudeConfigDir;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ClaudeHistoryCustomProfileTest {

    private static final String SESSION_A = "aaaaaaaa-1111-4111-8111-111111111111";
    private static final String SESSION_B = "bbbbbbbb-2222-4222-8222-222222222222";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void restoreSettingReader() {
        ClaudeConfigDir.setSettingReaderForTests(null);
    }

    private Path project() throws Exception {
        return tmp.newFolder("project").toPath().toRealPath();
    }

    private void writeSession(Path profile, Path project, String id, String text) throws Exception {
        Path directory = Files.createDirectories(profile.resolve("projects").resolve(PathUtils.sanitizePath(project.toString())));
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        message.addProperty("content", text);
        JsonObject line = new JsonObject();
        line.addProperty("type", "user");
        line.addProperty("cwd", project.toString());
        line.addProperty("sessionId", id);
        line.addProperty("timestamp", "2026-11-04T01:00:00Z");
        line.add("message", message);
        Files.writeString(directory.resolve(id + ".jsonl"), line + "\n");
    }

    private List<String> listSessions(Path project) throws Exception {
        SessionIndexManager isolatedIndex = new SessionIndexManager(tmp.newFolder().toPath());
        ClaudeHistoryIndexService service = new ClaudeHistoryIndexService(
                ClaudeHistoryReader.projectsDir(), new ClaudeHistoryParser(), isolatedIndex);
        return service.readProjectSessions(project.toString()).stream()
                .map(session -> session.sessionId)
                .collect(Collectors.toList());
    }

    @Test
    public void readerLooksForProjectsInTheConfiguredProfile() throws Exception {
        Path profile = tmp.newFolder("work-profile").toPath();
        ClaudeConfigDir.setSettingReaderForTests(() -> profile.toString());

        assertEquals(profile.resolve("projects"), ClaudeHistoryReader.projectsDir());
    }

    @Test
    public void listsSessionsStoredInTheConfiguredProfile() throws Exception {
        Path profile = tmp.newFolder("work-profile").toPath();
        Path project = project();
        writeSession(profile, project, SESSION_A, "Second profile prompt");
        ClaudeConfigDir.setSettingReaderForTests(() -> profile.toString());

        assertEquals(List.of(SESSION_A), listSessions(project));
    }

    @Test
    public void readsMessagesOfASessionStoredInTheConfiguredProfile() throws Exception {
        Path profile = tmp.newFolder("work-profile").toPath();
        Path project = project();
        writeSession(profile, project, SESSION_A, "Second profile prompt");
        ClaudeConfigDir.setSettingReaderForTests(() -> profile.toString());

        String json = new ClaudeHistoryReader().getSessionMessagesAsJson(project.toString(), SESSION_A);

        assertTrue(json, json.contains("Second profile prompt"));
    }

    @Test
    public void doesNotSeeProfileSessionsWhenNoProfileIsConfigured() throws Exception {
        Assume.assumeTrue("CLAUDE_CONFIG_DIR is set in this environment", System.getenv("CLAUDE_CONFIG_DIR") == null);
        Path profile = tmp.newFolder("work-profile").toPath();
        Path project = project();
        writeSession(profile, project, SESSION_A, "Second profile prompt");
        ClaudeConfigDir.setSettingReaderForTests(() -> null);

        assertEquals(List.of(), listSessions(project));
    }

    @Test
    public void followsTheSettingWhenItChangesWithoutARestart() throws Exception {
        Path profileA = tmp.newFolder("profile-a").toPath();
        Path profileB = tmp.newFolder("profile-b").toPath();
        Path project = project();
        writeSession(profileA, project, SESSION_A, "from a");
        writeSession(profileB, project, SESSION_B, "from b");

        ClaudeConfigDir.setSettingReaderForTests(() -> profileA.toString());
        assertEquals(List.of(SESSION_A), listSessions(project));

        ClaudeConfigDir.setSettingReaderForTests(() -> profileB.toString());
        assertEquals(List.of(SESSION_B), listSessions(project));
    }
}
