package com.github.claudecodegui.cache;

import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.TextSanitizer;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Stream;

/**
 * Session index file manager.
 * Handles reading, writing, and incremental updates of index files.
 * Index file location: ~/.codemoss/cache/
 */
public class SessionIndexManager {

    private static final Logger LOG = Logger.getInstance(SessionIndexManager.class);

    private static final Path DEFAULT_CODEMOSS_CACHE_DIR = Paths.get(PlatformUtils.getHomeDirectory(), ".codemoss", "cache");
    private static final String CLAUDE_INDEX_FILE = "claude-session-index.json";
    private static final String CODEX_INDEX_FILE = "codex-session-index.json";
    private static final int INDEX_REPLACE_MAX_ATTEMPTS = 5;
    // Linear backoff base. Sleeps happen while holding indexFileLock, so keep the worst-case
    // total (sum 1..N-1 * base) within ~100ms to avoid blocking concurrent index reads/writes.
    private static final long INDEX_REPLACE_RETRY_DELAY_MS = 10L;

    // v3 (2026-04): SessionIndexEntry.fileLastModified now populated and used by incremental
    // scan for mtime-driven re-read of already indexed sessions. Bumping forces rebuild of any
    // v2 index, which was produced by the legacy full-parser and has different metadata semantics
    // (title/messageCount/lastTimestamp) than the lite-read pipeline.
    private static final int INDEX_VERSION = 3;

    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();
    private final Path codemossCacheDir;
    private final Object indexFileLock = new Object();

    // Singleton
    private static final SessionIndexManager INSTANCE = new SessionIndexManager();

    private SessionIndexManager() {
        this(DEFAULT_CODEMOSS_CACHE_DIR);
    }

    SessionIndexManager(Path codemossCacheDir) {
        this.codemossCacheDir = codemossCacheDir;
        ensureCacheDir();
    }

    public static SessionIndexManager getInstance() {
        return INSTANCE;
    }

    /**
     * Index file structure.
     */
    public static class SessionIndex {
        public int version = INDEX_VERSION;
        public long lastUpdated;
        public Map<String, ProjectIndex> projects = new HashMap<>();
    }

    /**
     * Project index structure.
     */
    public static class ProjectIndex {
        public long lastDirScanTime;
        public int fileCount;
        public List<SessionIndexEntry> sessions = new ArrayList<>();

        /**
         * Returns the set of already-indexed session IDs.
         */
        public Set<String> getIndexedSessionIds() {
            Set<String> ids = new HashSet<>();
            for (SessionIndexEntry entry : sessions) {
                ids.add(entry.sessionId);
            }
            return ids;
        }
    }

    /**
     * Update type enumeration.
     */
    public enum UpdateType {
        NONE,           // No update needed
        INCREMENTAL,    // Incremental update (new files only)
        FULL            // Full rebuild
    }

    /**
     * Session index entry.
     */
    public static class SessionIndexEntry {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public long fileSize;
        public String cwd;  // Codex only

        // Used to detect whether the file has changed
        public long fileLastModified;

        // Path relative to the provider's root dir (Claude: projectDir; Codex: sessionsDir).
        // Enables sessionId -> file lookup during incremental rescan even when the session ID
        // does not equal the file basename (e.g. Codex session_meta.id overrides).
        public String fileRelativePath;
    }

    /**
     * Ensures the cache directory exists.
     */
    private void ensureCacheDir() {
        try {
            if (!Files.exists(codemossCacheDir)) {
                Files.createDirectories(codemossCacheDir);
                LOG.info("[SessionIndexManager] Created cache directory: " + codemossCacheDir);
            }
        } catch (IOException e) {
            LOG.error("[SessionIndexManager] Failed to create cache directory: " + e.getMessage(), e);
        }
    }

    /**
     * Returns the file path for the Claude index.
     */
    public Path getClaudeIndexPath() {
        return codemossCacheDir.resolve(CLAUDE_INDEX_FILE);
    }

    /**
     * Returns the file path for the Codex index.
     */
    public Path getCodexIndexPath() {
        return codemossCacheDir.resolve(CODEX_INDEX_FILE);
    }

    /**
     * Reads the Claude index.
     */
    public SessionIndex readClaudeIndex() {
        synchronized (indexFileLock) {
            return readIndex(getClaudeIndexPath());
        }
    }

    /**
     * Reads the Codex index.
     */
    public SessionIndex readCodexIndex() {
        synchronized (indexFileLock) {
            return readIndex(getCodexIndexPath());
        }
    }

    /**
     * Saves the Claude index.
     */
    public void saveClaudeIndex(SessionIndex index) {
        synchronized (indexFileLock) {
            saveIndex(getClaudeIndexPath(), index);
        }
    }

    /**
     * Saves the Codex index.
     */
    public void saveCodexIndex(SessionIndex index) {
        synchronized (indexFileLock) {
            saveIndex(getCodexIndexPath(), index);
        }
    }

    /**
     * Reads an index file from disk.
     */
    private SessionIndex readIndex(Path indexPath) {
        if (!Files.exists(indexPath)) {
            LOG.info("[SessionIndexManager] Index file not found: " + indexPath);
            return new SessionIndex();
        }

        try (Reader reader = Files.newBufferedReader(indexPath, StandardCharsets.UTF_8)) {
            SessionIndex index = this.gson.fromJson(reader, SessionIndex.class);
            if (index == null) {
                return new SessionIndex();
            }
            // Version check
            if (index.version != INDEX_VERSION) {
                LOG.info("[SessionIndexManager] Index version mismatch, rebuilding");
                return new SessionIndex();
            }
            LOG.info("[SessionIndexManager] Loaded index from " + indexPath + ", projects: " + index.projects.size());
            return index;
        } catch (Exception e) {
            LOG.error("[SessionIndexManager] Failed to read index: " + e.getMessage(), e);
            return new SessionIndex();
        }
    }

    /**
     * Saves an index file to disk.
     */
    private void saveIndex(Path indexPath, SessionIndex index) {
        ensureCacheDir();
        index.lastUpdated = System.currentTimeMillis();
        sanitizeIndex(index);

        Path parent = indexPath.getParent();
        if (parent == null) {
            LOG.warn("[SessionIndexManager] Failed to save index because parent directory is null: " + indexPath);
            return;
        }

        String prefix = indexPath.getFileName() != null ? indexPath.getFileName() + "-" : "session-index-";
        Path tmp = null;
        try {
            tmp = Files.createTempFile(parent, prefix, ".tmp");
            try (Writer writer = Files.newBufferedWriter(tmp, StandardCharsets.UTF_8)) {
                gson.toJson(index, writer);
            }
            replaceIndexFile(tmp, indexPath);
            LOG.info("[SessionIndexManager] Saved index to " + indexPath);
        } catch (Exception e) {
            LOG.error("[SessionIndexManager] Failed to save index: " + e.getMessage(), e);
        } finally {
            if (tmp != null) {
                try {
                    Files.deleteIfExists(tmp);
                } catch (IOException e) {
                    LOG.debug("[SessionIndexManager] Failed to cleanup temp file: " + tmp + " (" + e.getMessage() + ")");
                }
            }
        }
    }

    private void replaceIndexFile(Path tmp, Path indexPath) throws IOException {
        IOException lastFailure = null;
        boolean atomicMoveSupported = true;

        for (int attempt = 1; attempt <= INDEX_REPLACE_MAX_ATTEMPTS; attempt++) {
            try {
                if (atomicMoveSupported) {
                    Files.move(tmp, indexPath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } else {
                    Files.move(tmp, indexPath, StandardCopyOption.REPLACE_EXISTING);
                }
                return;
            } catch (AtomicMoveNotSupportedException e) {
                atomicMoveSupported = false;
                lastFailure = e;
            } catch (AccessDeniedException e) {
                lastFailure = e;
            }

            if (attempt < INDEX_REPLACE_MAX_ATTEMPTS) {
                sleepBeforeRetry(attempt);
            }
        }

        throw lastFailure;
    }

    private void sleepBeforeRetry(int attempt) {
        try {
            Thread.sleep(INDEX_REPLACE_RETRY_DELAY_MS * attempt);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void sanitizeIndex(SessionIndex index) {
        if (index == null || index.projects == null || index.projects.isEmpty()) {
            return;
        }
        Map<String, ProjectIndex> sanitizedProjects = new HashMap<>();
        for (Map.Entry<String, ProjectIndex> projectEntry : index.projects.entrySet()) {
            String sanitizedProjectPath = TextSanitizer.sanitizeInvalidSurrogates(projectEntry.getKey());
            ProjectIndex projectIndex = projectEntry.getValue();
            if (projectIndex != null && projectIndex.sessions != null) {
                for (SessionIndexEntry sessionEntry : projectIndex.sessions) {
                    if (sessionEntry == null) {
                        continue;
                    }
                    sessionEntry.sessionId = TextSanitizer.sanitizeInvalidSurrogates(sessionEntry.sessionId);
                    sessionEntry.title = TextSanitizer.sanitizeInvalidSurrogates(sessionEntry.title);
                    sessionEntry.cwd = TextSanitizer.sanitizeInvalidSurrogates(sessionEntry.cwd);
                }
            }
            sanitizedProjects.put(sanitizedProjectPath, projectIndex);
        }
        index.projects = sanitizedProjects;
    }

    /**
     * Checks whether the project index needs to be updated.
     *
     * @param projectIndex the project index
     * @param projectDir   the project directory
     * @return true if an update is needed
     */
    public boolean needsUpdate(ProjectIndex projectIndex, Path projectDir) {
        return getUpdateType(projectIndex, projectDir) != UpdateType.NONE;
    }

    /**
     * Determines the type of update required.
     *
     * @param projectIndex the project index
     * @param projectDir   the project directory
     * @return the update type
     */
    public UpdateType getUpdateType(ProjectIndex projectIndex, Path projectDir) {
        if (projectIndex == null || projectIndex.sessions.isEmpty()) {
            return UpdateType.FULL;
        }

        try {
            // Check file count
            long currentFileCount;
            try (Stream<Path> paths = Files.list(projectDir)) {
                currentFileCount = paths.filter(p -> p.toString().endsWith(".jsonl")).count();
            }

            if (currentFileCount == projectIndex.fileCount) {
                // File count unchanged; check directory modification time
                long currentDirModified = Files.getLastModifiedTime(projectDir).toMillis();
                if (currentDirModified <= projectIndex.lastDirScanTime) {
                    return UpdateType.NONE;
                }
                // Directory timestamp changed but file count is the same -- content may have changed, requiring a full update
                return UpdateType.FULL;
            } else if (currentFileCount > projectIndex.fileCount) {
                // File count increased; an incremental update is sufficient
                LOG.info("[SessionIndexManager] File count increased: " + projectIndex.fileCount + " -> " + currentFileCount + ", incremental update");
                return UpdateType.INCREMENTAL;
            } else {
                // File count decreased; a full update is needed
                LOG.info("[SessionIndexManager] File count decreased: " + projectIndex.fileCount + " -> " + currentFileCount + ", full update");
                return UpdateType.FULL;
            }
        } catch (IOException e) {
            LOG.warn("[SessionIndexManager] Failed to check update type: " + e.getMessage());
            return UpdateType.FULL;
        }
    }

    /**
     * Determines the update type for Codex (recursive directory scan).
     */
    public UpdateType getUpdateTypeRecursive(ProjectIndex projectIndex, Path sessionsDir) {
        if (projectIndex == null || projectIndex.sessions.isEmpty()) {
            return UpdateType.FULL;
        }

        try {
            // Count files first (recursive walk for nested year/month/day structure)
            long currentFileCount;
            try (Stream<Path> paths = Files.walk(sessionsDir)) {
                currentFileCount = paths
                        .filter(Files::isRegularFile)
                        .filter(p -> p.toString().endsWith(".jsonl"))
                        .count();
            }

            if (currentFileCount == projectIndex.fileCount) {
                return UpdateType.NONE;
            } else if (currentFileCount > projectIndex.fileCount) {
                LOG.info("[SessionIndexManager] Codex file count increased: " + projectIndex.fileCount + " -> " + currentFileCount + ", incremental update");
                return UpdateType.INCREMENTAL;
            } else {
                LOG.info("[SessionIndexManager] Codex file count decreased: " + projectIndex.fileCount + " -> " + currentFileCount + ", full update");
                return UpdateType.FULL;
            }
        } catch (IOException e) {
            LOG.warn("[SessionIndexManager] Failed to check Codex update type: " + e.getMessage());
            return UpdateType.FULL;
        }
    }

    /**
     * Converts an index entry to a ClaudeHistoryReader.SessionInfo representation.
     */
    public static Object toClaudeSessionInfo(SessionIndexEntry entry) {
        // Returns a Map for the caller to convert (avoids reflection dependency)
        Map<String, Object> info = new HashMap<>();
        info.put("sessionId", entry.sessionId);
        info.put("title", entry.title);
        info.put("messageCount", entry.messageCount);
        info.put("lastTimestamp", entry.lastTimestamp);
        info.put("firstTimestamp", entry.firstTimestamp);
        return info;
    }

    /**
     * Creates a new index entry.
     */
    public static SessionIndexEntry createEntry(
            String sessionId,
            String title,
            int messageCount,
            long lastTimestamp,
            long firstTimestamp,
            long fileSize,
            long fileLastModified,
            String cwd
    ) {
        SessionIndexEntry entry = new SessionIndexEntry();
        entry.sessionId = sessionId;
        entry.title = title;
        entry.messageCount = messageCount;
        entry.lastTimestamp = lastTimestamp;
        entry.firstTimestamp = firstTimestamp;
        entry.fileSize = fileSize;
        entry.fileLastModified = fileLastModified;
        entry.cwd = cwd;
        return entry;
    }

    /**
     * Clears all indexes.
     */
    public void clearAllIndexes() {
        synchronized (indexFileLock) {
            try {
                Files.deleteIfExists(getClaudeIndexPath());
                Files.deleteIfExists(getCodexIndexPath());
                LOG.info("[SessionIndexManager] All indexes cleared");
            } catch (IOException e) {
                LOG.error("[SessionIndexManager] Failed to clear indexes: " + e.getMessage(), e);
            }
        }
    }

    /**
     * Clears the index for a specific project.
     */
    public void clearProjectIndex(String provider, String projectPath) {
        synchronized (indexFileLock) {
            if ("claude".equals(provider)) {
                SessionIndex index = readIndex(getClaudeIndexPath());
                index.projects.remove(projectPath);
                saveIndex(getClaudeIndexPath(), index);
            } else if ("codex".equals(provider)) {
                SessionIndex index = readIndex(getCodexIndexPath());
                index.projects.remove(projectPath);
                saveIndex(getCodexIndexPath(), index);
            }
        }
        LOG.info("[SessionIndexManager] Cleared index for " + provider + " project: " + projectPath);
    }

    /**
     * Clears all Codex indexes.
     * Codex uses "__all__" as its index key, so deleting a session requires clearing the entire Codex index.
     */
    public void clearAllCodexIndex() {
        synchronized (indexFileLock) {
            SessionIndex index = new SessionIndex();
            saveIndex(getCodexIndexPath(), index);
        }
        LOG.info("[SessionIndexManager] All Codex indexes cleared");
    }
}
