package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeHistoryReader;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.github.claudecodegui.provider.common.GitHistoryTestRepositories.create;
import static org.junit.Assert.*;

public class CrossDirectoryClaudeActionsTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void exportAndDeleteResolveAuthorizedTranscriptsAndRespectDisabledMatching() throws Exception {
        Path root = temporary.getRoot().toPath();
        Path project = create(root.resolve("project"), "https://host/team/game.git");
        Path clone = create(root.resolve("clone"), "git@host:team/game.git");
        Path unrelated = create(root.resolve("other"), "https://host/other/game.git");
        Path home = Files.createDirectory(root.resolve("home"));
        Path projects = Files.createDirectories(home.resolve(".claude/projects"));
        Files.createDirectories(projects.resolve(PathUtils.sanitizePath(project.toRealPath().toString())));
        String cloneId = UUID.randomUUID().toString();
        String foreignId = UUID.randomUUID().toString();
        Path transcript = writeSession(projects, clone, cloneId);
        Path foreign = writeSession(projects, unrelated, foreignId);
        AtomicBoolean enabled = new AtomicBoolean(false);
        var settings = new CodemossSettingsService() {
            @Override public boolean getSessionGitRepositoryMatchingEnabled() { return enabled.get(); }
        };
        HandlerContext context = new HandlerContext(null, null, null, settings, null) {
            @Override public String resolveEffectiveWorkingDirectory() { return project.toString(); }
        };
        Field homeField = com.github.claudecodegui.util.PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        Field historyField = ClaudeHistoryReader.class.getDeclaredField("claudeDir");
        homeField.setAccessible(true); historyField.setAccessible(true);
        Object oldHome = homeField.get(null);
        Object oldHistory = historyField.get(null);
        try {
            homeField.set(null, home.toString());
            historyField.set(null, home.resolve(".claude"));
            // All destructive fixture operations must remain inside this temporary home.
            org.junit.Assume.assumeTrue(home.toString().equals(
                    com.github.claudecodegui.bridge.NodeDetector.resolveHomeForFileOps()));
            var export = new HistoryExportService(context);
            var read = HistoryExportService.class.getDeclaredMethod("loadMessagesForExport", String.class, String.class, String.class);
            read.setAccessible(true);
            var delete = new HistoryDeleteService(context, null, null);
            var remove = HistoryDeleteService.class.getDeclaredMethod("deleteSessionFiles", String.class, String.class);
            remove.setAccessible(true);
            assertEquals(0, ((JsonElement) read.invoke(export, "claude", cloneId, project.toString())).getAsJsonArray().size());
            remove.invoke(delete, cloneId, "claude");
            assertTrue(Files.exists(transcript));
            enabled.set(true);
            var messages = ((JsonElement) read.invoke(export, "claude", cloneId, project.toString())).getAsJsonArray();
            assertEquals(1, messages.size());
            assertEquals(cloneId, messages.get(0).getAsJsonObject().get("sessionId").getAsString());
            assertEquals(0, ((JsonElement) read.invoke(export, "claude", foreignId, project.toString())).getAsJsonArray().size());
            remove.invoke(delete, foreignId, "claude");
            assertTrue(Files.exists(foreign));
            remove.invoke(delete, cloneId, "claude");
            assertFalse(Files.exists(transcript));
            assertTrue(Files.exists(foreign));
        } finally {
            historyField.set(null, oldHistory);
            homeField.set(null, oldHome);
        }
    }

    private static Path writeSession(Path projects, Path cwd, String id) throws Exception {
        Path directory = Files.createDirectories(projects.resolve(PathUtils.sanitizePath(cwd.toRealPath().toString())));
        JsonObject message = new JsonObject(); message.addProperty("role", "user"); message.addProperty("content", "History fixture");
        JsonObject line = new JsonObject(); line.addProperty("type", "user"); line.addProperty("cwd", cwd.toString());
        line.addProperty("sessionId", id); line.addProperty("timestamp", "2026-11-04T01:00:00Z"); line.add("message", message);
        Path transcript = directory.resolve(id + ".jsonl");
        Files.writeString(transcript, line + "\n");
        return transcript;
    }
}
