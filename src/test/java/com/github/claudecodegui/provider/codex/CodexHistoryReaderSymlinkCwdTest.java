package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assume.assumeTrue;

/**
 * Sessions opened through a symlinked project path record the physical cwd in the
 * rollout file (the CLI resolves symlinks), so filtering by the symlink path must
 * still match via its resolved form (issue #1789).
 */
public class CodexHistoryReaderSymlinkCwdTest {

    private Path isolatedCacheDir;

    /**
     * The index service consults two shared stores that leak between tests otherwise:
     * the SessionIndexManager singleton reads the developer's real ~/.codemoss/cache
     * (a leftover __all__ index whose fileCount happens to equal the fixture's makes
     * getUpdateTypeRecursive return NONE and restore unrelated sessions), and the
     * SessionIndexCache memory cache keys the "__all__" entry without a sessionsDir
     * dimension, so one test's scan is served to the next. Isolate both.
     */
    @Before
    public void isolateSharedIndexState() throws IOException {
        isolatedCacheDir = Files.createTempDirectory("codex-symlink-index-cache");
        SessionIndexCache.getInstance().clearAll();
    }

    @After
    public void cleanupIsolatedCache() throws IOException {
        SessionIndexCache.getInstance().clearAll();
        deleteRecursively(isolatedCacheDir);
    }

    @Test
    public void matchesSessionsRecordedUnderPhysicalCwdWhenQueriedViaSymlink() throws IOException {
        Path realDir = Files.createTempDirectory("codex-symlink-real");
        Path linkPath = Paths.get(realDir + "-link");
        try {
            boolean linkCreated;
            try {
                Files.createSymbolicLink(linkPath, realDir);
                linkCreated = true;
            } catch (IOException | UnsupportedOperationException e) {
                linkCreated = false;
            }
            assumeTrue("filesystem refuses symlink creation", linkCreated);

            Path sessionsDir = Files.createTempDirectory("codex-symlink-sessions");
            try {
                String sessionId = "c0ffee11-1111-2222-3333-444455556666";
                String sessionMeta = "{\"timestamp\":\"2026-09-10T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{"
                        + "\"id\":\"" + sessionId + "\",\"cwd\":\"" + realDir + "\",\"timestamp\":\"2026-09-10T10:00:00Z\"}}";
                // A real Codex session always carries at least one user message; sessions
                // without one are dropped as invalid by the reader (no title, 0 messages)
                String userMessage = "{\"timestamp\":\"2026-09-10T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{"
                        + "\"type\":\"user_message\",\"message\":\"check the session list\"}}";
                String assistantReply = "{\"timestamp\":\"2026-09-10T10:00:02Z\",\"type\":\"response_item\",\"payload\":{"
                        + "\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}}";
                Files.write(sessionsDir.resolve(sessionId + ".jsonl"),
                        (sessionMeta + "\n" + userMessage + "\n" + assistantReply + "\n").getBytes(StandardCharsets.UTF_8));

                SessionIndexManager indexManager = new SessionIndexManager(isolatedCacheDir);
                CodexHistoryReader reader = new CodexHistoryReader(sessionsDir, new Gson(), indexManager);
                String json = reader.getSessionsForProjectAsJson(linkPath.toString());

                Map<String, Object> result = new Gson().fromJson(json, new TypeToken<Map<String, Object>>() { }.getType());
                assertEquals(Boolean.TRUE, result.get("success"));
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> sessions = (List<Map<String, Object>>) result.get("sessions");
                assertEquals(1, sessions.size());
                assertEquals(realDir.toString(), sessions.get(0).get("cwd"));
            } finally {
                deleteRecursively(sessionsDir);
            }
        } finally {
            Files.deleteIfExists(linkPath);
            deleteRecursively(realDir);
        }
    }

    private static void deleteRecursively(Path dir) throws IOException {
        if (dir == null || !Files.exists(dir)) {
            return;
        }
        try (java.util.stream.Stream<Path> paths = Files.walk(dir)) {
            paths.sorted(java.util.Comparator.reverseOrder()).map(Path::toFile).forEach(File::delete);
        }
    }
}
