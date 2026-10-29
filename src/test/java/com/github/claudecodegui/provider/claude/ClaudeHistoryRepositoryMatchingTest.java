package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.provider.common.GitRepositorySessionMatcher;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import static com.github.claudecodegui.provider.common.GitHistoryTestRepositories.create;
import static org.junit.Assert.*;

public class ClaudeHistoryRepositoryMatchingTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();
    @After public void clearCaches() { SessionIndexCache.getInstance().clearAll(); }

    @Test public void includesMatchingHistoryAndFindsItsOriginalTranscriptDirectory() throws Exception {
        Path root = tmp.getRoot().toPath();
        Path project = create(root.resolve("project"), "https://host/team/game.git");
        Path clone = create(root.resolve("clone"), "git@other:fork/game.git");
        Path other = create(root.resolve("other"), "https://host/team/different.git");
        Path projects = Files.createDirectory(root.resolve("history"));
        String currentId = writeSession(projects, project);
        String cloneId = writeSession(projects, clone);
        String otherId = writeSession(projects, other);
        ClaudeHistoryParser parser = new ClaudeHistoryParser();
        ClaudeHistoryIndexService index = new ClaudeHistoryIndexService(projects, parser, new SessionIndexManager(root.resolve("cache")));
        GitRepositorySessionMatcher matcher = new GitRepositorySessionMatcher(project.toString());
        assertEquals(1, index.readProjectSessions(project.toString()).size());
        var sessions = index.readProjectSessions(project.toString(), matcher);
        assertEquals(2, sessions.size());
        assertTrue(sessions.stream().anyMatch(session -> cloneId.equals(session.sessionId)));
        assertFalse(sessions.stream().anyMatch(session -> otherId.equals(session.sessionId)));
        ClaudeHistorySearchService search = new ClaudeHistorySearchService(projects, null, index);
        assertEquals(clone.toString(), search.findSessionHistoryCwd(cloneId, project.toString(), matcher));
        assertEquals(project.toString(), search.findSessionHistoryCwd(currentId, project.toString(), matcher));
        assertEquals(project.toString(), search.findSessionHistoryCwd(otherId, project.toString(), matcher));
        assertEquals(project.toString(), search.findSessionHistoryCwd("../bad", project.toString(), matcher));
        assertEquals(project.toString(), search.findSessionHistoryCwd(cloneId, project.toString(), null));
    }

    private static String writeSession(Path projects, Path cwd) throws Exception {
        Path directory = Files.createDirectories(projects.resolve(PathUtils.sanitizePath(cwd.toRealPath().toString())));
        String id = UUID.randomUUID().toString();
        JsonObject message = new JsonObject();message.addProperty("role", "user");message.addProperty("content", "History fixture for repository matching");
        JsonObject line = new JsonObject();line.addProperty("type", "user");line.addProperty("cwd", cwd.toString());
        line.addProperty("sessionId", id);line.addProperty("timestamp", "2026-10-22T01:00:00Z");line.add("message", message);
        Files.writeString(directory.resolve(id + ".jsonl"), line + "\n");
        return id;
    }
}
