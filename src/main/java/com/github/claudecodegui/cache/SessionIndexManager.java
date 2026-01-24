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
 * 会话索引文件管理器
 * 负责索引文件的读写和增量更新
 * 索引文件位置: ~/.codemoss/cache/
 */
public class SessionIndexManager {

    private static final Logger LOG = Logger.getInstance(SessionIndexManager.class);

    private static final String HOME_DIR = System.getProperty("user.home");
    private static final Path CODEMOSS_CACHE_DIR = Paths.get(HOME_DIR, ".codemoss", "cache");
    private static final String CLAUDE_INDEX_FILE = "claude-session-index.json";
    private static final String CODEX_INDEX_FILE = "codex-session-index.json";

    private static final int INDEX_VERSION = 2;

    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();

    // 单例
    private static final SessionIndexManager INSTANCE = new SessionIndexManager();

    private SessionIndexManager() {
        // 确保缓存目录存在
        ensureCacheDir();
    }

    public static SessionIndexManager getInstance() {
        return INSTANCE;
    }

    /**
     * 索引文件结构
     */
    public static class SessionIndex {
        public int version = INDEX_VERSION;
        public long lastUpdated;
        public Map<String, ProjectIndex> projects = new HashMap<>();
    }

    /**
     * 项目索引结构
     */
    public static class ProjectIndex {
        public long lastDirScanTime;
        public int fileCount;
        public List<SessionIndexEntry> sessions = new ArrayList<>();

        /**
         * 获取已索引的 sessionId 集合
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
     * 更新类型枚举
     */
    public enum UpdateType {
        NONE,           // 不需要更新
        INCREMENTAL,    // 增量更新（只有新增文件）
        FULL            // 全量更新
    }

    /**
     * 会话索引条目
     */
    public static class SessionIndexEntry {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public long fileSize;
        public String cwd;  // Codex 专用

        // 用于检测文件是否变化
        public long fileLastModified;
    }

    /**
     * 确保缓存目录存在
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
     * 获取 Claude 索引文件路径
     */
    public Path getClaudeIndexPath() {
        return CODEMOSS_CACHE_DIR.resolve(CLAUDE_INDEX_FILE);
    }

    /**
     * 获取 Codex 索引文件路径
     */
    public Path getCodexIndexPath() {
        return CODEMOSS_CACHE_DIR.resolve(CODEX_INDEX_FILE);
    }

    /**
     * 读取 Claude 索引
     */
    public SessionIndex readClaudeIndex() {
        return readIndex(getClaudeIndexPath());
    }

    /**
     * 读取 Codex 索引
     */
    public SessionIndex readCodexIndex() {
        return readIndex(getCodexIndexPath());
    }

    /**
     * 保存 Claude 索引
     */
    public void saveClaudeIndex(SessionIndex index) {
        saveIndex(getClaudeIndexPath(), index);
    }

    /**
     * 保存 Codex 索引
     */
    public void saveCodexIndex(SessionIndex index) {
        saveIndex(getCodexIndexPath(), index);
    }

    /**
     * 读取索引文件
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
            // 版本检查
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
     * 保存索引文件
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
     * 检查项目索引是否需要更新
     * @param projectIndex 项目索引
     * @param projectDir 项目目录
     * @return true 如果需要更新
     */
    public boolean needsUpdate(ProjectIndex projectIndex, Path projectDir) {
        return getUpdateType(projectIndex, projectDir) != UpdateType.NONE;
    }

    /**
     * 获取更新类型
     * @param projectIndex 项目索引
     * @param projectDir 项目目录
     * @return 更新类型
     */
    public UpdateType getUpdateType(ProjectIndex projectIndex, Path projectDir) {
        if (projectIndex == null || projectIndex.sessions.isEmpty()) {
            return UpdateType.FULL;
        }

        try {
            // 检查文件数量
            long currentFileCount;
            try (Stream<Path> paths = Files.list(projectDir)) {
                currentFileCount = paths.filter(p -> p.toString().endsWith(".jsonl")).count();
            }

            if (currentFileCount == projectIndex.fileCount) {
                // 文件数量相同，检查目录修改时间
                long currentDirModified = Files.getLastModifiedTime(projectDir).toMillis();
                if (currentDirModified <= projectIndex.lastDirScanTime) {
                    return UpdateType.NONE;
                }
                // 目录时间变了但文件数量相同，可能是文件内容变化，需要全量更新
                return UpdateType.FULL;
            } else if (currentFileCount > projectIndex.fileCount) {
                // 文件数量增加，可以增量更新
                LOG.info("[SessionIndexManager] File count increased: " + projectIndex.fileCount + " -> " + currentFileCount + ", incremental update");
                return UpdateType.INCREMENTAL;
            } else {
                // 文件数量减少，需要全量更新
                LOG.info("[SessionIndexManager] File count decreased: " + projectIndex.fileCount + " -> " + currentFileCount + ", full update");
                return UpdateType.FULL;
            }
        } catch (IOException e) {
            LOG.warn("[SessionIndexManager] Failed to check update type: " + e.getMessage());
            return UpdateType.FULL;
        }
    }

    /**
     * 获取 Codex 更新类型（递归目录）
     */
    public UpdateType getUpdateTypeRecursive(ProjectIndex projectIndex, Path sessionsDir) {
        if (projectIndex == null || projectIndex.sessions.isEmpty()) {
            return UpdateType.FULL;
        }

        try {
            // 对于 Codex，检查根目录的修改时间
            long currentDirModified = Files.getLastModifiedTime(sessionsDir).toMillis();

            if (currentDirModified <= projectIndex.lastDirScanTime) {
                return UpdateType.NONE;
            }

            // 目录时间变了，统计当前文件数量
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
                // 文件数量相同但目录时间变了，可能是内容更新
                return UpdateType.FULL;
            }
        } catch (IOException e) {
            LOG.warn("[SessionIndexManager] Failed to check Codex update type: " + e.getMessage());
            return UpdateType.FULL;
        }
    }

    /**
     * 从索引条目转换为 ClaudeHistoryReader.SessionInfo
     */
    public static Object toClaudeSessionInfo(SessionIndexEntry entry) {
        // 使用反射或直接创建，这里返回一个 Map 供调用方转换
        Map<String, Object> info = new HashMap<>();
        info.put("sessionId", entry.sessionId);
        info.put("title", entry.title);
        info.put("messageCount", entry.messageCount);
        info.put("lastTimestamp", entry.lastTimestamp);
        info.put("firstTimestamp", entry.firstTimestamp);
        return info;
    }

    /**
     * 创建索引条目
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
     * 清除所有索引
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
     * 清除指定项目的索引
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
     * 清除所有 Codex 索引
     * Codex 使用 "__all__" 作为索引键，删除会话时需要清除整个 Codex 索引
     */
    public void clearAllCodexIndex() {
        SessionIndex index = new SessionIndex();
        saveCodexIndex(index);
        LOG.info("[SessionIndexManager] All Codex indexes cleared");
    }
}
