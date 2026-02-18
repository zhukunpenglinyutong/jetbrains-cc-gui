package com.github.claudecodegui.cache;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.lang.reflect.Type;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Stream;

/**
 * Session index file manager.
 * Handles reading, writing, and incremental updates of index files.
 * Index file location: ~/.codemoss/cache/
 */
public class SessionIndexManager {

    private static final Logger LOG = Logger.getInstance(SessionIndexManager.class);

    private static final String HOME_DIR = System.getProperty("user.home");
    private static final Path CODEMOSS_CACHE_DIR = Paths.get(HOME_DIR, ".codemoss", "cache");
    private static final String CLAUDE_INDEX_FILE = "claude-session-index.json";
    private static final String CODEX_INDEX_FILE = "codex-session-index.json";

    private static final int INDEX_VERSION = 2;

    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();

    // Singleton
    private static final SessionIndexManager INSTANCE = new SessionIndexManager();

    private SessionIndexManager() {
        // Ensure cache directory exists
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
    }

    /**
     * Ensures the cache directory exists.
     */
    private void ensureCacheDir() {
        try {
            if (!Files.exists(CODEMOSS_CACHE_DIR)) {
                Files.createDirectories(CODEMOSS_CACHE_DIR);
                LOG.info("[SessionIndexManager] Created cache directory: " + CODEMOSS_CACHE_DIR);
            }
        } catch (IOException e) {
            LOG.error("[SessionIndexManager] Failed to create cache directory: " + e.getMessage(), e);
        }
    }

    /**
     * Returns the file path for the Claude index.
     */
    public Path getClaudeIndexPath() {
        return CODEMOSS_CACHE_DIR.resolve(CLAUDE_INDEX_FILE);
    }

    /**
     * Returns the file path for the Codex index.
     */
    public Path getCodexIndexPath() {
        return CODEMOSS_CACHE_DIR.resolve(CODEX_INDEX_FILE);
    }

    /**
     * Reads the Claude index.
     */
    public SessionIndex readClaudeIndex() {
        return readIndex(getClaudeIndexPath());
    }

    /**
     * Reads the Codex index.
     */
    public SessionIndex readCodexIndex() {
        return readIndex(getCodexIndexPath());
    }

    /**
     * Saves the Claude index.
     */
    public void saveClaudeIndex(SessionIndex index) {
        saveIndex(getClaudeIndexPath(), index);
    }

    /**
     * Saves the Codex index.
     */
    public void saveCodexIndex(SessionIndex index) {
        saveIndex(getCodexIndexPath(), index);
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
            SessionIndex index = gson.fromJson(reader, SessionIndex.class);
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

        try (Writer writer = Files.newBufferedWriter(indexPath, StandardCharsets.UTF_8)) {
            gson.toJson(index, writer);
            LOG.info("[SessionIndexManager] Saved index to " + indexPath);
        } catch (Exception e) {
            LOG.error("[SessionIndexManager] Failed to save index: " + e.getMessage(), e);
        }
    }

    /**
     * Checks whether the project index needs to be updated.
     * @param projectIndex the project index
     * @param projectDir the project directory
     * @return true if an update is needed
     */
    public boolean needsUpdate(ProjectIndex projectIndex, Path projectDir) {
        return getUpdateType(projectIndex, projectDir) != UpdateType.NONE;
    }

    /**
     * Determines the type of update required.
     * @param projectIndex the project index
     * @param projectDir the project directory
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
            // For Codex, check the root directory's modification time
            long currentDirModified = Files.getLastModifiedTime(sessionsDir).toMillis();

            if (currentDirModified <= projectIndex.lastDirScanTime) {
                return UpdateType.NONE;
            }

            // Directory timestamp changed; count current files
            long currentFileCount;
            try (Stream<Path> paths = Files.walk(sessionsDir)) {
                currentFileCount = paths
                    .filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".jsonl"))
                    .count();
            }

            if (currentFileCount > projectIndex.fileCount) {
                LOG.info("[SessionIndexManager] Codex file count increased: " + projectIndex.fileCount + " -> " + currentFileCount + ", incremental update");
                return UpdateType.INCREMENTAL;
            } else if (currentFileCount < projectIndex.fileCount) {
                LOG.info("[SessionIndexManager] Codex file count decreased, full update");
                return UpdateType.FULL;
            } else {
                // File count is the same but directory timestamp changed; content may have been updated
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
        try {
            Files.deleteIfExists(getClaudeIndexPath());
            Files.deleteIfExists(getCodexIndexPath());
            LOG.info("[SessionIndexManager] All indexes cleared");
        } catch (IOException e) {
            LOG.error("[SessionIndexManager] Failed to clear indexes: " + e.getMessage(), e);
        }
    }

    /**
     * Clears the index for a specific project.
     */
    public void clearProjectIndex(String provider, String projectPath) {
        if ("claude".equals(provider)) {
            SessionIndex index = readClaudeIndex();
            index.projects.remove(projectPath);
            saveClaudeIndex(index);
        } else if ("codex".equals(provider)) {
            SessionIndex index = readCodexIndex();
            index.projects.remove(projectPath);
            saveCodexIndex(index);
        }
        LOG.info("[SessionIndexManager] Cleared index for " + provider + " project: " + projectPath);
    }

    /**
     * Clears all Codex indexes.
     * Codex uses "__all__" as its index key, so deleting a session requires clearing the entire Codex index.
     */
    public void clearAllCodexIndex() {
        SessionIndex index = new SessionIndex();
        saveCodexIndex(index);
        LOG.info("[SessionIndexManager] All Codex indexes cleared");
    }
}
