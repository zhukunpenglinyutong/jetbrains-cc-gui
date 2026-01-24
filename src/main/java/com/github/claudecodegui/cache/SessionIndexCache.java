package com.github.claudecodegui.cache;

import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 会话索引内存缓存
 * 用于缓存历史会话列表，避免每次都从文件系统读取
 */
public class SessionIndexCache {

    private static final Logger LOG = Logger.getInstance(SessionIndexCache.class);

    // 单例
    private static final SessionIndexCache INSTANCE = new SessionIndexCache();

    // 缓存有效期: 5分钟
    private static final long CACHE_TTL_MS = 5 * 60 * 1000;

    // Claude 缓存: projectPath -> CacheEntry
    private final Map<String, CacheEntry<?>> claudeCache = new ConcurrentHashMap<>();

    // Codex 缓存: projectPath -> CacheEntry
    private final Map<String, CacheEntry<?>> codexCache = new ConcurrentHashMap<>();

    private SessionIndexCache() {
        // 私有构造函数
    }

    public static SessionIndexCache getInstance() {
        return INSTANCE;
    }

    /**
     * 缓存条目
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
         * 检查缓存是否过期
         */
        public boolean isExpired() {
            return System.currentTimeMillis() - cacheCreatedAt > CACHE_TTL_MS;
        }

        /**
         * 检查缓存是否仍然有效
         * @param currentDirModified 当前目录修改时间
         */
        public boolean isValid(long currentDirModified) {
            if (isExpired()) {
                return false;
            }
            // 如果目录修改时间没变，缓存仍然有效
            return currentDirModified == lastDirModified;
        }
    }

    /**
     * 获取 Claude 缓存的会话列表
     * @param projectPath 项目路径
     * @param projectDir 项目目录 Path（用于检查修改时间）
     * @return 缓存的会话列表，如果缓存无效则返回 null
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
     * 更新 Claude 缓存
     */
    public <T> void updateClaudeCache(String projectPath, Path projectDir, List<T> sessions) {
        long dirModified = getDirModifiedTime(projectDir);
        CacheEntry<T> entry = new CacheEntry<>(sessions, dirModified);
        claudeCache.put(projectPath, entry);
        LOG.info("[SessionIndexCache] Claude cache updated for " + projectPath + ", sessions: " + sessions.size());
    }

    /**
     * 获取 Codex 缓存的会话列表
     * @param projectPath 项目路径
     * @param sessionsDir sessions 目录 Path
     * @return 缓存的会话列表，如果缓存无效则返回 null
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
     * 更新 Codex 缓存
     */
    public <T> void updateCodexCache(String projectPath, Path sessionsDir, List<T> sessions) {
        long dirModified = getDirModifiedTime(sessionsDir);
        CacheEntry<T> entry = new CacheEntry<>(sessions, dirModified);
        codexCache.put(projectPath, entry);
        LOG.info("[SessionIndexCache] Codex cache updated for " + projectPath + ", sessions: " + sessions.size());
    }

    /**
     * 清除所有缓存
     */
    public void clearAll() {
        claudeCache.clear();
        codexCache.clear();
        LOG.info("[SessionIndexCache] All caches cleared");
    }

    /**
     * 清除指定项目的缓存
     */
    public void clearProject(String projectPath) {
        claudeCache.remove(projectPath);
        codexCache.remove(projectPath);
        LOG.info("[SessionIndexCache] Cache cleared for project: " + projectPath);
    }

    /**
     * 清除所有 Codex 缓存
     * Codex 使用 "__all__" 作为缓存键，删除会话时需要清除整个 Codex 缓存
     */
    public void clearAllCodexCache() {
        codexCache.clear();
        LOG.info("[SessionIndexCache] All Codex caches cleared");
    }

    /**
     * 获取目录的修改时间
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
