package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.cache.SessionIndexManager;
import com.google.gson.Gson;
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
import static org.junit.Assert.assertTrue;

/**
 * Verifies Codex incrementalScanLite uses fileRelativePath (not sessionId) for index lookup,
 * which matters because Codex session IDs can be overridden by session_meta.id. Also
 * verifies that file mtime is carried from scan to index-update.
 */
public class CodexHistoryIndexServiceTest {

    @Rule
    public final TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void incrementalScan_matchesIndexByRelativePath_andRefreshesDriftedFile() throws IOException {
        Path sessionsDir = tmp.newFolder("codex-index-incr").toPath();
        Path nested = sessionsDir.resolve("2026/04/21");
        Files.createDirectories(nested);

        // File name "rollout-<uuid>.jsonl" with session_meta.id = "thread_xxx" override.
        Path file = writeSessionFile(nested, "rollout-alpha.jsonl", "thread_abc1234567");
        long mtime = Files.getLastModifiedTime(file).toMillis();
        String relative = sessionsDir.relativize(file).toString();

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 1;
        SessionIndexManager.SessionIndexEntry entry = new SessionIndexManager.SessionIndexEntry();
        entry.sessionId = "thread_abc1234567";
        entry.title = "STALE TITLE";
        entry.messageCount = 0;
        entry.lastTimestamp = mtime + 5000;
        entry.firstTimestamp = mtime + 5000;
        entry.fileRelativePath = relative;
        entry.fileLastModified = mtime + 5000;  // drifted from actual file mtime
        existing.sessions.add(entry);

        CodexHistoryIndexService service = newService(sessionsDir);
        CodexHistoryIndexService.ScanResult result = service.incrementalScanLite(existing);

        assertEquals(1, result.sessions().size());
        CodexHistoryReader.SessionInfo restored = result.sessions().get(0);
        assertEquals("thread_abc1234567", restored.sessionId);
        assertNotNull(restored.title);
        assertTrue("title should come from the fresh file, not the stale index",
                !"STALE TITLE".equals(restored.title));

        // sessionFiles must carry the path AND the fresh mtime for updateCodexIndex.
        CodexHistoryIndexService.FileMeta meta = result.sessionFiles().get("thread_abc1234567");
        assertNotNull(meta);
        assertEquals("mtime from scan should reflect the actual file on disk", mtime, meta.mtime());
    }

    @Test
    public void incrementalScan_restoresUnchangedEntry_withoutReadingFile() throws IOException {
        Path sessionsDir = tmp.newFolder("codex-index-unchanged").toPath();
        Path nested = sessionsDir.resolve("2026/04/21");
        Files.createDirectories(nested);

        Path file = writeSessionFile(nested, "rollout-beta.jsonl", "thread_beta987654321");
        long mtime = Files.getLastModifiedTime(file).toMillis();
        String relative = sessionsDir.relativize(file).toString();

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 1;
        SessionIndexManager.SessionIndexEntry entry = new SessionIndexManager.SessionIndexEntry();
        entry.sessionId = "thread_beta987654321";
        entry.title = "Indexed Title";
        entry.messageCount = 7;
        entry.lastTimestamp = mtime;
        entry.firstTimestamp = mtime;
        entry.fileRelativePath = relative;
        entry.fileLastModified = mtime;  // matches actual file mtime
        existing.sessions.add(entry);

        CodexHistoryIndexService service = newService(sessionsDir);
        CodexHistoryIndexService.ScanResult result = service.incrementalScanLite(existing);

        assertEquals(1, result.sessions().size());
        CodexHistoryReader.SessionInfo restored = result.sessions().get(0);
        assertEquals("Indexed Title", restored.title);
        assertEquals(7, restored.messageCount);

        // Unchanged entries must still contribute a FileMeta so updateCodexIndex can re-persist the mtime.
        CodexHistoryIndexService.FileMeta meta = result.sessionFiles().get("thread_beta987654321");
        assertNotNull(meta);
        assertEquals(mtime, meta.mtime());
    }

    @Test
    public void incrementalScan_picksUpFileMissingFromIndex() throws IOException {
        Path sessionsDir = tmp.newFolder("codex-index-newfile").toPath();
        Path nested = sessionsDir.resolve("2026/04/21");
        Files.createDirectories(nested);

        Path existingFile = writeSessionFile(nested, "rollout-old.jsonl", "thread_old1234567890");
        long mtime = Files.getLastModifiedTime(existingFile).toMillis();
        String relative = sessionsDir.relativize(existingFile).toString();

        SessionIndexManager.ProjectIndex existing = new SessionIndexManager.ProjectIndex();
        existing.lastDirScanTime = System.currentTimeMillis();
        existing.fileCount = 1;
        SessionIndexManager.SessionIndexEntry entry = new SessionIndexManager.SessionIndexEntry();
        entry.sessionId = "thread_old1234567890";
        entry.title = "Old";
        entry.messageCount = 1;
        entry.lastTimestamp = mtime;
        entry.firstTimestamp = mtime;
        entry.fileRelativePath = relative;
        entry.fileLastModified = mtime;
        existing.sessions.add(entry);

        writeSessionFile(nested, "rollout-new.jsonl", "thread_new0987654321");

        CodexHistoryIndexService service = newService(sessionsDir);
        CodexHistoryIndexService.ScanResult result = service.incrementalScanLite(existing);

        Map<String, CodexHistoryReader.SessionInfo> byId = result.sessions().stream()
                .collect(Collectors.toMap(s -> s.sessionId, s -> s));
        assertEquals(2, byId.size());
        assertNotNull(byId.get("thread_old1234567890"));
        assertNotNull(byId.get("thread_new0987654321"));
    }

    // --- helpers -----------------------------------------------------------

    private CodexHistoryIndexService newService(Path sessionsDir) {
        return new CodexHistoryIndexService(sessionsDir, new CodexHistoryParser(new Gson()));
    }

    private Path writeSessionFile(Path dir, String fileName, String sessionMetaId) throws IOException {
        Path file = dir.resolve(fileName);
        StringBuilder sb = new StringBuilder();
        sb.append("{\"timestamp\":\"2026-04-21T10:00:00Z\",\"type\":\"session_meta\",")
                .append("\"payload\":{\"id\":\"").append(sessionMetaId)
                .append("\",\"cwd\":\"/workspace/demo\",\"timestamp\":\"2026-04-21T10:00:00Z\"}}\n");
        sb.append("{\"timestamp\":\"2026-04-21T10:00:05Z\",\"type\":\"event_msg\",")
                .append("\"payload\":{\"type\":\"user_message\",\"message\":\"Fresh title for ")
                .append(sessionMetaId).append("\"}}\n");
        sb.append("{\"timestamp\":\"2026-04-21T10:00:10Z\",\"type\":\"response_item\",")
                .append("\"payload\":{\"type\":\"message\"}}\n");
        Files.writeString(file, sb.toString());
        return file;
    }
}
