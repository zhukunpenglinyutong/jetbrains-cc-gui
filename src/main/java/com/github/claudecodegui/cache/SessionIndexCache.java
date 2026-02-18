package com.github.claudecodegui.cache;

import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory cache for session indexes.
 * Caches historical session lists to avoid reading from the filesystem on every access.
 */
public class SessionIndexCache {

    private static final Logger LOG = Logger.getInstance(SessionIndexCache.class);

    // Singleton
    private static final SessionIndexCache INSTANCE = new SessionIndexCache();

    // Cache TTL: 5 minutes
    private static final long CACHE_TTL_MS = 5 * 60 * 1000;

    // Claude cache: projectPath -> CacheEntry
    private final Map<String, CacheEntry<?>> claudeCache = new ConcurrentHashMap<>();

    // Codex cache: projectPath -> CacheEntry
    private final Map<String, CacheEntry<?>> codexCache = new ConcurrentHashMap<>();

    private SessionIndexCache() {
        // Private constructor
    }

    public static SessionIndexCache getInstance() {
        return INSTANCE;
    }

    /**
     * Cache entry.
     */
    public static class CacheEntry<T> {
        private final List<T> sessions;
        private final long lastDirModified;
        private final long cacheCreatedAt;

        public CacheEntry(List<T> sessions, long lastDirModified) {
            this.sessions = sessions;
            this.lastDirModified = lastDirModified;
            this.cacheCreatedAt = System.currentTimeMillis();
        }

        public List<T> getSessions() {
            return sessions;
        }

        public long getLastDirModified() {
            return lastDirModified;
        }

        public long getCacheCreatedAt() {
            return cacheCreatedAt;
        }

        /**
         * Checks whether the cache has expired.
         */
        public boolean isExpired() {
            return System.currentTimeMillis() - cacheCreatedAt > CACHE_TTL_MS;
        }

        /**
         * Checks whether the cache is still valid.
         * @param currentDirModified current directory modification time
         */
        public boolean isValid(long currentDirModified) {
            if (isExpired()) {
                return false;
            }
            // If the directory modification time hasn't changed, the cache is still valid
            return currentDirModified == lastDirModified;
        }
    }

    /**
     * Returns the cached Claude session list.
     * @param projectPath the project path
     * @param projectDir the project directory Path (used to check modification time)
     * @return the cached session list, or null if the cache is invalid
     */
    @SuppressWarnings("unchecked")
    public <T> List<T> getClaudeSessions(String projectPath, Path projectDir) {
        CacheEntry<T> entry = (CacheEntry<T>) claudeCache.get(projectPath);
        if (entry == null) {
            LOG.info("[SessionIndexCache] Claude cache miss: no entry for " + projectPath);
            return null;
        }

        long currentDirModified = getDirModifiedTime(projectDir);
        if (!entry.isValid(currentDirModified)) {
            LOG.info("[SessionIndexCache] Claude cache invalid: expired or dir changed for " + projectPath);
            claudeCache.remove(projectPath);
            return null;
        }

        LOG.info("[SessionIndexCache] Claude cache hit for " + projectPath + ", sessions: " + entry.getSessions().size());
        return entry.getSessions();
    }

    /**
     * Updates the Claude cache.
     */
    public <T> void updateClaudeCache(String projectPath, Path projectDir, List<T> sessions) {
        long dirModified = getDirModifiedTime(projectDir);
        CacheEntry<T> entry = new CacheEntry<>(sessions, dirModified);
        claudeCache.put(projectPath, entry);
        LOG.info("[SessionIndexCache] Claude cache updated for " + projectPath + ", sessions: " + sessions.size());
    }

    /**
     * Returns the cached Codex session list.
     * @param projectPath the project path
     * @param sessionsDir the sessions directory Path
     * @return the cached session list, or null if the cache is invalid
     */
    @SuppressWarnings("unchecked")
    public <T> List<T> getCodexSessions(String projectPath, Path sessionsDir) {
        CacheEntry<T> entry = (CacheEntry<T>) codexCache.get(projectPath);
        if (entry == null) {
            LOG.info("[SessionIndexCache] Codex cache miss: no entry for " + projectPath);
            return null;
        }

        long currentDirModified = getDirModifiedTime(sessionsDir);
        if (!entry.isValid(currentDirModified)) {
            LOG.info("[SessionIndexCache] Codex cache invalid: expired or dir changed for " + projectPath);
            codexCache.remove(projectPath);
            return null;
        }

        LOG.info("[SessionIndexCache] Codex cache hit for " + projectPath + ", sessions: " + entry.getSessions().size());
        return entry.getSessions();
    }

    /**
     * Updates the Codex cache.
     */
    public <T> void updateCodexCache(String projectPath, Path sessionsDir, List<T> sessions) {
        long dirModified = getDirModifiedTime(sessionsDir);
        CacheEntry<T> entry = new CacheEntry<>(sessions, dirModified);
        codexCache.put(projectPath, entry);
        LOG.info("[SessionIndexCache] Codex cache updated for " + projectPath + ", sessions: " + sessions.size());
    }

    /**
     * Clears all caches.
     */
    public void clearAll() {
        claudeCache.clear();
        codexCache.clear();
        LOG.info("[SessionIndexCache] All caches cleared");
    }

    /**
     * Clears the cache for a specific project.
     */
    public void clearProject(String projectPath) {
        claudeCache.remove(projectPath);
        codexCache.remove(projectPath);
        LOG.info("[SessionIndexCache] Cache cleared for project: " + projectPath);
    }

    /**
     * Clears all Codex caches.
     * Codex uses "__all__" as the cache key, so deleting a session requires clearing the entire Codex cache.
     */
    public void clearAllCodexCache() {
        codexCache.clear();
        LOG.info("[SessionIndexCache] All Codex caches cleared");
    }

    /**
     * Returns the modification time of a directory.
     */
    private long getDirModifiedTime(Path dir) {
        if (dir == null || !Files.exists(dir)) {
            return 0;
        }
        try {
            return Files.getLastModifiedTime(dir).toMillis();
        } catch (Exception e) {
            LOG.warn("[SessionIndexCache] Failed to get dir modified time: " + e.getMessage());
            return 0;
        }
    }
}
