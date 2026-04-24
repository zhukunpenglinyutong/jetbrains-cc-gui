package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cache.SessionIndexManager;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Verifies that incrementalScanLite correctly distinguishes unchanged / mtime-drifted /
 * brand-new session files and re-reads only what is needed, and that mtimes are carried
 * from scan to index-update without a second stat.
 */
public class ClaudeHistoryIndexServiceTest {

    private static final String UUID_1 = "aaaaaaaa-1111-4111-8111-111111111111";
    private static final String UUID_2 = "bbbbbbbb-2222-4222-8222-222222222222";
    private static final String UUID_3 = "cccccccc-3333-4333-8333-333333333333";

    @Rule
    public final TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void incrementalScan_restoresUnchangedEntries_andRereadsDriftedFile() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-incr").toPath();

        Path fileA = writeSession(projectDir, UUID_1, "Hello A", "2026-04-21T10:00:00Z");
        Path fileB = writeSession(projectDir, UUID_2, "Hello B", "2026-04-21T10:05:00Z");

        long mtimeA = Files.getLastModifiedTime(fileA).toMillis();
        long mtimeB = Files.getLastModifiedTime(fileB).toMillis();

        // Seed index: A has a drifted mtime (stale title should be replaced), B matches (title preserved).
        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 2;
        existing.sessions.add(entry(UUID_1, "STALE A", 1, mtimeA + 1000, mtimeA + 1000, UUID_1 + ".jsonl"));
        existing.sessions.add(entry(UUID_2, "Hello B", 1, mtimeB, mtimeB, UUID_2 + ".jsonl"));

        ClaudeHistoryIndexService service = newService(projectDir);
        ClaudeHistoryIndexService.ScanResult result = service.incrementalScanLite(projectDir, existing);

        Map<String, ClaudeHistoryReader.SessionInfo> byId = result.sessions().stream()
                .collect(Collectors.toMap(s -> s.sessionId, s -> s));

        assertEquals("two sessions expected", 2, byId.size());
        assertEquals("Hello A", byId.get(UUID_1).title);
        assertEquals("Hello B", byId.get(UUID_2).title);

        // Mtime map must include entries for both sessions so updateProjectIndex can persist them.
        assertEquals(Long.valueOf(mtimeA), result.sessionMtimes().get(UUID_1));
        assertEquals(Long.valueOf(mtimeB), result.sessionMtimes().get(UUID_2));
    }

    @Test
    public void incrementalScan_picksUpBrandNewSessionFile() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-new").toPath();

        Path fileA = writeSession(projectDir, UUID_1, "Existing A", "2026-04-21T10:00:00Z");
        long mtimeA = Files.getLastModifiedTime(fileA).toMillis();

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 1;
        existing.sessions.add(entry(UUID_1, "Existing A", 1, mtimeA, mtimeA, UUID_1 + ".jsonl"));

        writeSession(projectDir, UUID_3, "Brand New", "2026-04-21T11:00:00Z");

        ClaudeHistoryIndexService service = newService(projectDir);
        ClaudeHistoryIndexService.ScanResult result = service.incrementalScanLite(projectDir, existing);

        Map<String, ClaudeHistoryReader.SessionInfo> byId = result.sessions().stream()
                .collect(Collectors.toMap(s -> s.sessionId, s -> s));
        assertEquals(2, byId.size());
        assertEquals("Existing A", byId.get(UUID_1).title);
        assertNotNull("new session must be surfaced", byId.get(UUID_3));
        assertEquals("Brand New", byId.get(UUID_3).title);
    }

    @Test
    public void incrementalScan_legacyEntryWithoutMtime_triggersReRead() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-legacy").toPath();

        writeSession(projectDir, UUID_1, "Fresh A", "2026-04-21T10:00:00Z");

        // Simulate a v2-era entry: fileLastModified = 0 (never written), fileRelativePath = null.
        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 1;
        existing.sessions.add(entry(UUID_1, "STALE LEGACY", 42, 9999L, 0L, null));

        ClaudeHistoryIndexService service = newService(projectDir);
        ClaudeHistoryIndexService.ScanResult result = service.incrementalScanLite(projectDir, existing);

        assertEquals(1, result.sessions().size());
        assertEquals("legacy entry should be refreshed from file", "Fresh A", result.sessions().get(0).title);
    }

    @Test
    public void incrementalScan_skipsNonUuidJsonlFiles() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-skip").toPath();

        // A backup file with non-UUID filename must not go through lite-read.
        Path backup = projectDir.resolve("some-random-backup.jsonl");
        Files.writeString(backup, "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"irrelevant\"}}\n");

        writeSession(projectDir, UUID_1, "Real session", "2026-04-21T10:00:00Z");

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 2;

        ClaudeHistoryIndexService service = newService(projectDir);
        ClaudeHistoryIndexService.ScanResult result = service.incrementalScanLite(projectDir, existing);

        assertEquals("non-UUID .jsonl must be ignored", 1, result.sessions().size());
        assertEquals(UUID_1, result.sessions().get(0).sessionId);
        assertNull("backup file must not appear in mtime map",
                result.sessionMtimes().get("some-random-backup"));
        assertTrue("real session's mtime must be recorded", result.sessionMtimes().containsKey(UUID_1));
    }

    @Test
    public void extractSessionId_normalizesUppercaseUuidToLowercase() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-uppercase").toPath();

        // Write a session with uppercase UUID in filename
        String uppercaseUuid = "AAAAAAAA-1111-4111-8111-111111111111";
        Path file = writeSession(projectDir, uppercaseUuid, "Upper Case", "2026-04-21T10:00:00Z");

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 0;

        ClaudeHistoryIndexService service = newService(projectDir);
        ClaudeHistoryIndexService.ScanResult result = service.incrementalScanLite(projectDir, existing);

        assertEquals("uppercase UUID session must be recognized", 1, result.sessions().size());
        // sessionId should be normalized to lowercase
        assertEquals(UUID_1, result.sessions().get(0).sessionId);
        assertTrue("mtime map should use normalized lowercase key",
                result.sessionMtimes().containsKey(UUID_1));
    }

    // --- helpers -----------------------------------------------------------

    private ClaudeHistoryIndexService newService(Path projectDir) {
        return new ClaudeHistoryIndexService(projectDir, new ClaudeHistoryParser());
    }

    private Path writeSession(Path projectDir, String sessionId, String firstUserText, String timestamp) throws IOException {
        Path file = projectDir.resolve(sessionId + ".jsonl");
        String line = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\""
                + firstUserText.replace("\"", "\\\"")
                + "\"},\"timestamp\":\"" + timestamp + "\"}\n";
        Files.writeString(file, line);
        return file;
    }

    /**
     * Builds a SessionIndexEntry with explicit separation between the business
     * timestamps (lastTimestamp/firstTimestamp) and the indexed file mtime. This lets
     * tests construct scenarios where the indexed mtime has drifted without confusing
     * the two concepts.
     */
    private SessionIndexManager.SessionIndexEntry entry(
            String sessionId,
            String title,
            int messageCount,
            long lastTimestamp,
            long indexedFileMtime,
            String fileRelativePath
    ) {
        SessionIndexManager.SessionIndexEntry e = new SessionIndexManager.SessionIndexEntry();
        e.sessionId = sessionId;
        e.title = title;
        e.messageCount = messageCount;
        e.lastTimestamp = lastTimestamp;
        e.firstTimestamp = lastTimestamp;
        e.fileLastModified = indexedFileMtime;
        e.fileRelativePath = fileRelativePath;
        return e;
    }
}
