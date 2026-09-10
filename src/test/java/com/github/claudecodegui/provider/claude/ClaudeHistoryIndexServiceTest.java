package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.List;
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
        SessionIndexManager.SessionIndexEntry staleA =
                entry(UUID_1, "STALE A", 1, mtimeA + 1000, mtimeA + 1000, UUID_1 + ".jsonl");
        staleA.fileSize = Files.size(fileA);
        SessionIndexManager.SessionIndexEntry unchangedB =
                entry(UUID_2, "Hello B", 1, mtimeB, mtimeB, UUID_2 + ".jsonl");
        unchangedB.fileSize = Files.size(fileB);
        existing.sessions.add(staleA);
        existing.sessions.add(unchangedB);

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
        SessionIndexManager.SessionIndexEntry existingEntry =
                entry(UUID_1, "Existing A", 1, mtimeA, mtimeA, UUID_1 + ".jsonl");
        existingEntry.fileSize = Files.size(fileA);
        existing.sessions.add(existingEntry);

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
    public void incrementalScan_refreshesSizeChangedFileWhenMtimeIsUnchanged() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-size").toPath();
        Path file = writeSession(projectDir, UUID_1, "Original", "2026-04-21T10:00:00Z");
        long mtime = Files.getLastModifiedTime(file).toMillis();

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.fileCount = 1;
        SessionIndexManager.SessionIndexEntry indexed = entry(
                UUID_1, "Original", 1, mtime, mtime, UUID_1 + ".jsonl");
        indexed.fileSize = Files.size(file);
        existing.sessions.add(indexed);

        Files.writeString(
                file,
                "{\"type\":\"assistant\",\"customTitle\":\"Updated\"}\n",
                java.nio.file.StandardOpenOption.APPEND
        );
        Files.setLastModifiedTime(file, FileTime.fromMillis(mtime));

        ClaudeHistoryIndexService.ScanResult result = newService(projectDir)
                .incrementalScanLite(projectDir, existing);

        assertEquals(1, result.sessions().size());
        assertEquals("Updated", result.sessions().get(0).title);
    }

    @Test
    public void incrementalScan_usesSessionIdToBreakTimestampTies() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-tie-order").toPath();
        Path first = writeSession(projectDir, UUID_1, "First", "2026-04-21T10:00:00Z");
        Path second = writeSession(projectDir, UUID_2, "Second", "2026-04-21T10:00:00Z");
        long mtime = 1_700_000_000_000L;
        Files.setLastModifiedTime(first, FileTime.fromMillis(mtime));
        Files.setLastModifiedTime(second, FileTime.fromMillis(mtime));

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.fileCount = 2;
        SessionIndexManager.SessionIndexEntry secondEntry = entry(
                UUID_2, "Second", 1, mtime, mtime, UUID_2 + ".jsonl");
        secondEntry.fileSize = Files.size(second);
        SessionIndexManager.SessionIndexEntry firstEntry = entry(
                UUID_1, "First", 1, mtime, mtime, UUID_1 + ".jsonl");
        firstEntry.fileSize = Files.size(first);
        existing.sessions.add(secondEntry);
        existing.sessions.add(firstEntry);

        Files.writeString(
                second,
                "{\"type\":\"assistant\",\"customTitle\":\"Updated second\"}\n",
                java.nio.file.StandardOpenOption.APPEND
        );
        Files.setLastModifiedTime(second, FileTime.fromMillis(mtime));

        ClaudeHistoryIndexService.ScanResult result = newService(projectDir)
                .incrementalScanLite(projectDir, existing);

        assertEquals(2, result.sessions().size());
        assertEquals("equal timestamps must use a stable descending ID order",
                UUID_2, result.sessions().get(0).sessionId);
        assertEquals(UUID_1, result.sessions().get(1).sessionId);
    }

    @Test
    public void incrementalScan_nullEntrypointEntry_isHealedByReRead() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-heal").toPath();

        // File carries an entrypoint, but the index entry predates extraction (entrypoint=null).
        Path file = writeSessionWithEntrypoint(projectDir, UUID_1, "Hello A", "2026-04-21T10:00:00Z", "sdk-cli");
        long mtime = Files.getLastModifiedTime(file).toMillis();

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 1;
        SessionIndexManager.SessionIndexEntry stale = entry(UUID_1, "Hello A", 1, mtime, mtime, UUID_1 + ".jsonl");
        stale.entrypoint = null;
        existing.sessions.add(stale);

        ClaudeHistoryIndexService service = newService(projectDir);
        ClaudeHistoryIndexService.ScanResult result = service.incrementalScanLite(projectDir, existing);

        assertEquals(1, result.sessions().size());
        assertEquals("matching mtime must not shield a never-extracted entry from re-read",
                "sdk-cli", result.sessions().get(0).entrypoint);
    }

    @Test
    public void incrementalScan_emptyEntrypointMarker_isRestoredWithoutReRead() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-marker").toPath();

        Path file = writeSession(projectDir, UUID_1, "Hello A", "2026-04-21T10:00:00Z");
        long mtime = Files.getLastModifiedTime(file).toMillis();

        // "" records that extraction ran and the file has no entrypoint: restore, don't re-read.
        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 1;
        SessionIndexManager.SessionIndexEntry restoredEntry =
                entry(UUID_1, "RESTORED TITLE", 1, mtime, mtime, UUID_1 + ".jsonl");
        restoredEntry.fileSize = Files.size(file);
        existing.sessions.add(restoredEntry);

        ClaudeHistoryIndexService service = newService(projectDir);
        ClaudeHistoryIndexService.ScanResult result = service.incrementalScanLite(projectDir, existing);

        assertEquals(1, result.sessions().size());
        // Restored from the index (title untouched by the file), with "" surfaced as null.
        assertEquals("RESTORED TITLE", result.sessions().get(0).title);
        assertNull(result.sessions().get(0).entrypoint);
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

    @Test
    public void incrementalScan_matchesUppercaseIndexedSessionId() throws IOException {
        Path projectDir = tmp.newFolder("claude-index-uppercase-index").toPath();
        String uppercaseUuid = UUID_1.toUpperCase(java.util.Locale.ROOT);
        Path file = writeSession(projectDir, uppercaseUuid, "Upper Case", "2026-04-21T10:00:00Z");
        long mtime = Files.getLastModifiedTime(file).toMillis();

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 1;
        SessionIndexManager.SessionIndexEntry uppercaseEntry =
                entry(uppercaseUuid, "Upper Case", 1, mtime, mtime, uppercaseUuid + ".jsonl");
        uppercaseEntry.fileSize = Files.size(file);
        existing.sessions.add(uppercaseEntry);

        ClaudeHistoryIndexService.ScanResult result = newService(projectDir).incrementalScanLite(projectDir, existing);

        assertEquals(1, result.sessions().size());
        assertEquals(UUID_1, result.sessions().get(0).sessionId);
        assertEquals("Upper Case", result.sessions().get(0).title);
    }

    @Test
    public void readProjectSessions_reloadsChangedFileWhenDirectoryMtimeIsUnchanged() throws IOException {
        Path projectsDir = tmp.newFolder("claude-projects").toPath();
        String projectPath = "claude-index-reload-" + tmp.getRoot().getName();
        Path projectDir = projectsDir.resolve(projectPath);
        Files.createDirectories(projectDir);
        Path sessionFile = writeSession(projectDir, UUID_1, "Original title", "2026-04-21T10:00:00Z");

        long indexedFileMtime = Files.getLastModifiedTime(sessionFile).toMillis();
        long directoryMtime = Files.getLastModifiedTime(projectDir).toMillis();
        SessionIndexCache cache = SessionIndexCache.getInstance();
        SessionIndexManager indexManager = new SessionIndexManager(tmp.newFolder("reload-index-cache").toPath());
        cache.clearProject(projectPath);

        try {
            ClaudeHistoryIndexService service = new ClaudeHistoryIndexService(
                    projectsDir, new ClaudeHistoryParser(), indexManager);
            List<ClaudeHistoryReader.SessionInfo> initial = service.readProjectSessions(projectPath);
            assertEquals(1, initial.size());
            assertEquals("Original title", initial.get(0).title);
            assertEquals(1, initial.get(0).messageCount);

            Files.writeString(
                    sessionFile,
                    "{\"type\":\"assistant\",\"customTitle\":\"Updated title\"}\n",
                    java.nio.file.StandardOpenOption.APPEND
            );
            Files.setLastModifiedTime(sessionFile, FileTime.fromMillis(indexedFileMtime + 2_000));
            Files.setLastModifiedTime(projectDir, FileTime.fromMillis(directoryMtime));

            List<ClaudeHistoryReader.SessionInfo> updated = service.readProjectSessions(projectPath);
            assertEquals(1, updated.size());
            assertEquals("Updated title", updated.get(0).title);
            assertEquals(2, updated.get(0).messageCount);
        } finally {
            cache.clearProject(projectPath);
            indexManager.clearProjectIndex("claude", projectPath);
        }
    }

    @Test
    public void readProjectSessions_appliesPaginationAfterIncrementalRefresh() throws IOException {
        Path projectsDir = tmp.newFolder("paginated-projects").toPath();
        String projectPath = "paginated-" + tmp.getRoot().getName();
        Path projectDir = Files.createDirectory(projectsDir.resolve(projectPath));
        Path first = writeSession(projectDir, UUID_1, "First", "2026-04-21T10:00:00Z");
        Path second = writeSession(projectDir, UUID_2, "Second", "2026-04-21T11:00:00Z");
        Files.setLastModifiedTime(first, FileTime.fromMillis(1_700_000_000_000L));
        Files.setLastModifiedTime(second, FileTime.fromMillis(1_700_000_002_000L));
        long directoryMtime = Files.getLastModifiedTime(projectDir).toMillis();
        SessionIndexManager indexManager = new SessionIndexManager(tmp.newFolder("isolated-index-cache").toPath());
        SessionIndexCache cache = SessionIndexCache.getInstance();
        cache.clearProject(projectPath);
        try {
            ClaudeHistoryIndexService service = new ClaudeHistoryIndexService(
                    projectsDir, new ClaudeHistoryParser(), indexManager);
            assertEquals(2, service.readProjectSessions(projectPath).size());
            Files.setLastModifiedTime(first, FileTime.fromMillis(1_700_000_004_000L));
            Files.setLastModifiedTime(projectDir, FileTime.fromMillis(directoryMtime));

            List<ClaudeHistoryReader.SessionInfo> page = service.readProjectSessions(projectPath, 1, 0);
            assertEquals(1, page.size());
            assertEquals(UUID_1, page.get(0).sessionId);
            page = service.readProjectSessions(projectPath, 1, 1);
            assertEquals(1, page.size());
            assertEquals(UUID_2, page.get(0).sessionId);
            assertTrue(service.readProjectSessions(projectPath, 1, 2).isEmpty());
            assertEquals(2, service.readProjectSessions(projectPath).size());
        } finally {
            cache.clearProject(projectPath);
            indexManager.clearProjectIndex("claude", projectPath);
        }
    }

    @Test
    public void readProjectSessions_ignoresJsonlDirectoriesInPersistedFileCount() throws IOException {
        Path projectsDir = tmp.newFolder("directory-projects").toPath();
        String projectPath = "directory-" + tmp.getRoot().getName();
        Path projectDir = Files.createDirectory(projectsDir.resolve(projectPath));
        writeSession(projectDir, UUID_1, "Real session", "2026-04-21T10:00:00Z");
        Files.createDirectory(projectDir.resolve(UUID_2 + ".jsonl"));
        SessionIndexManager indexManager = new SessionIndexManager(tmp.newFolder("isolated-index-cache").toPath());
        SessionIndexCache cache = SessionIndexCache.getInstance();
        cache.clearProject(projectPath);
        try {
            ClaudeHistoryIndexService service = new ClaudeHistoryIndexService(
                    projectsDir, new ClaudeHistoryParser(), indexManager);
            assertEquals(1, service.readProjectSessions(projectPath).size());
            SessionIndexManager.ProjectIndex index = indexManager.readClaudeIndex().projects.get(projectPath);
            assertEquals(1, index.fileCount);
            assertEquals(SessionIndexManager.UpdateType.NONE, indexManager.getUpdateType(index, projectDir));
        } finally {
            cache.clearProject(projectPath);
            indexManager.clearProjectIndex("claude", projectPath);
        }
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

    private Path writeSessionWithEntrypoint(
            Path projectDir, String sessionId, String firstUserText, String timestamp, String entrypoint
    ) throws IOException {
        Path file = projectDir.resolve(sessionId + ".jsonl");
        String line = "{\"type\":\"user\",\"entrypoint\":\"" + entrypoint
                + "\",\"message\":{\"role\":\"user\",\"content\":\""
                + firstUserText.replace("\"", "\\\"")
                + "\"},\"timestamp\":\"" + timestamp + "\"}\n";
        Files.writeString(file, line);
        return file;
    }

    /**
     * Builds a SessionIndexEntry with explicit separation between the business
     * timestamps (lastTimestamp/firstTimestamp) and the indexed file mtime. This lets
     * tests construct scenarios where the indexed mtime has drifted without confusing
     * the two concepts. Entrypoint defaults to "" (the modern "extracted, file has
     * none" marker); tests for the null-healing path override it explicitly.
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
        e.entrypoint = "";
        return e;
    }
}
