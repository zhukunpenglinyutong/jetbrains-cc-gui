package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.util.PathUtils;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

public class ClaudeHistoryReaderRefactorTest {

    @Test
    public void parserTracksEarliestAndLatestTimestampsIndependently() throws IOException {
        Path sessionFile = Files.createTempFile("claude-history-parser", ".jsonl");
        try {
            Files.write(sessionFile, List.of(
                    line("2026-03-10T10:10:00Z", "assistant", "Here is the summary."),
                    line("2026-03-10T10:00:00Z", "user", "Explain this diff")
            ));

            ClaudeHistoryParser parser = new ClaudeHistoryParser();

            ClaudeHistoryReader.SessionInfo session = parser.scanSingleSession(sessionFile);

            assertNotNull(session);
            assertEquals(Instant.parse("2026-03-10T10:00:00Z").toEpochMilli(), session.firstTimestamp);
            assertEquals(Instant.parse("2026-03-10T10:10:00Z").toEpochMilli(), session.lastTimestamp);
        } finally {
            Files.deleteIfExists(sessionFile);
        }
    }

    @Test
    public void fullScanAndIndexRestoreKeepEarliestTimestamp() throws IOException {
        Path projectsDir = Files.createTempDirectory("claude-history-index");
        String projectPath = "/workspace/demo";
        String sanitizedProjectPath = PathUtils.sanitizePath(projectPath);
        Path projectDir = projectsDir.resolve(sanitizedProjectPath);
        Files.createDirectories(projectDir);

        try {
            Files.write(projectDir.resolve("session-1.jsonl"), List.of(
                    line("2026-03-10T10:12:00Z", "assistant", "Applied the fix."),
                    line("2026-03-10T10:00:00Z", "user", "Investigate the regression"),
                    line("2026-03-10T10:05:00Z", "assistant", "Looking into it.")
            ));

            SessionIndexCache.getInstance().clearProject(projectPath);
            SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);

            ClaudeHistoryIndexService indexService = new ClaudeHistoryIndexService(projectsDir, new ClaudeHistoryParser());

            List<ClaudeHistoryReader.SessionInfo> scannedSessions = indexService.readProjectSessions(projectPath);

            assertEquals(1, scannedSessions.size());
            assertEquals(Instant.parse("2026-03-10T10:00:00Z").toEpochMilli(), scannedSessions.get(0).firstTimestamp);
            assertEquals(Instant.parse("2026-03-10T10:12:00Z").toEpochMilli(), scannedSessions.get(0).lastTimestamp);

            SessionIndexCache.getInstance().clearProject(projectPath);
            List<ClaudeHistoryReader.SessionInfo> restoredSessions = indexService.readProjectSessions(projectPath);

            assertEquals(1, restoredSessions.size());
            assertEquals(Instant.parse("2026-03-10T10:00:00Z").toEpochMilli(), restoredSessions.get(0).firstTimestamp);
            assertEquals(Instant.parse("2026-03-10T10:12:00Z").toEpochMilli(), restoredSessions.get(0).lastTimestamp);
        } finally {
            SessionIndexCache.getInstance().clearProject(projectPath);
            SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
            deleteDirectory(projectsDir);
        }
    }

    private String line(String timestamp, String type, String text) {
        return "{\"type\":\"" + type + "\",\"timestamp\":\"" + timestamp + "\",\"message\":{\"content\":\"" + text + "\"}}";
    }

    private void deleteDirectory(Path dir) throws IOException {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                });
    }
}
