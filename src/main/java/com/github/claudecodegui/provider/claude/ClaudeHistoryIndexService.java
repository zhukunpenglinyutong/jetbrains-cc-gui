package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * Manages session index: cache, incremental scanning, and full scanning.
 */
class ClaudeHistoryIndexService {

    private static final Logger LOG = Logger.getInstance(ClaudeHistoryIndexService.class);

    private final Path projectsDir;
    private final ClaudeHistoryParser parser;
    private final Gson gson = new Gson();

    ClaudeHistoryIndexService(Path projectsDir, ClaudeHistoryParser parser) {
        this.projectsDir = projectsDir;
        this.parser = parser;
    }

    /**
     * Read all sessions from a project directory.
     * Uses memory cache and file index for performance optimization.
     */
    List<ClaudeHistoryReader.SessionInfo> readProjectSessions(String projectPath) throws IOException {
        List<ClaudeHistoryReader.SessionInfo> sessions = new ArrayList<>();

        if (projectPath == null || projectPath.isEmpty()) {
            return sessions;
        }

        String sanitizedPath = PathUtils.sanitizePath(projectPath);
        Path projectDir = projectsDir.resolve(sanitizedPath);

        if (!Files.exists(projectDir) || !Files.isDirectory(projectDir)) {
            return sessions;
        }

        // 1. Check memory cache
        SessionIndexCache cache = SessionIndexCache.getInstance();
        List<ClaudeHistoryReader.SessionInfo> cachedSessions = cache.getClaudeSessions(projectPath, projectDir);
        if (cachedSessions != null) {
            LOG.info("[ClaudeHistoryReader] Using memory cache for " + projectPath + ", sessions: " + cachedSessions.size());
            return cachedSessions;
        }

        // 2. Check index file and determine update type
        SessionIndexManager indexManager = SessionIndexManager.getInstance();
        SessionIndexManager.SessionIndex index = indexManager.readClaudeIndex();
        SessionIndexManager.ProjectIndex projectIndex = index.projects.get(projectPath);
        SessionIndexManager.UpdateType updateType = indexManager.getUpdateType(projectIndex, projectDir);

        if (updateType == SessionIndexManager.UpdateType.NONE) {
            // Index is valid, restore from index
            LOG.info("[ClaudeHistoryReader] Using file index for " + projectPath + ", sessions: " + projectIndex.sessions.size());
            sessions = restoreSessionsFromIndex(projectIndex);
            // Update memory cache
            cache.updateClaudeCache(projectPath, projectDir, sessions);
            return sessions;
        }

        long startTime = System.currentTimeMillis();

        if (updateType == SessionIndexManager.UpdateType.INCREMENTAL && projectIndex != null) {
            // 3a. Incremental update: only scan new files
            LOG.info("[ClaudeHistoryReader] Incremental scan for " + projectPath);
            sessions = incrementalScan(projectDir, projectIndex);
        } else {
            // 3b. Full scan
            LOG.info("[ClaudeHistoryReader] Full scan for " + projectPath);
            sessions = scanProjectSessions(projectDir);
        }

        long scanTime = System.currentTimeMillis() - startTime;
        LOG.info("[ClaudeHistoryReader] Scan completed in " + scanTime + "ms, sessions: " + sessions.size());

        // 4. Update index
        updateProjectIndex(index, projectPath, projectDir, sessions);
        indexManager.saveClaudeIndex(index);

        // 5. Update memory cache
        cache.updateClaudeCache(projectPath, projectDir, sessions);

        return sessions;
    }

    /**
     * Incremental scan: only scan new files and merge with existing index.
     */
    private List<ClaudeHistoryReader.SessionInfo> incrementalScan(Path projectDir, SessionIndexManager.ProjectIndex existingIndex) throws IOException {
        Set<String> indexedIds = existingIndex.getIndexedSessionIds();
        List<ClaudeHistoryReader.SessionInfo> sessions = restoreSessionsFromIndex(existingIndex);

        List<ClaudeHistoryReader.SessionInfo> newSessions = new ArrayList<>();
        Files.list(projectDir)
                .filter(path -> path.toString().endsWith(".jsonl"))
                .filter(path -> {
                    String fileName = path.getFileName().toString();
                    String sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));
                    return !indexedIds.contains(sessionId);
                })
                .filter(path -> {
                    try {
                        return Files.size(path) > 0;
                    } catch (IOException e) {
                        return false;
                    }
                })
                .forEach(path -> {
                    try {
                        ClaudeHistoryReader.SessionInfo session = parser.scanSingleSession(path);
                        if (session != null) {
                            newSessions.add(session);
                        }
                    } catch (Exception e) {
                        LOG.error("[ClaudeHistoryReader] Failed to scan new session file: " + e.getMessage());
                    }
                });

        LOG.info("[ClaudeHistoryReader] Incremental scan found " + newSessions.size() + " new sessions");
        sessions.addAll(newSessions);
        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        return sessions;
    }

    /**
     * Restore session list from index.
     */
    private List<ClaudeHistoryReader.SessionInfo> restoreSessionsFromIndex(SessionIndexManager.ProjectIndex projectIndex) {
        List<ClaudeHistoryReader.SessionInfo> sessions = new ArrayList<>();
        for (SessionIndexManager.SessionIndexEntry entry : projectIndex.sessions) {
            ClaudeHistoryReader.SessionInfo session = new ClaudeHistoryReader.SessionInfo();
            session.sessionId = entry.sessionId;
            session.title = entry.title;
            session.messageCount = entry.messageCount;
            session.lastTimestamp = entry.lastTimestamp;
            session.firstTimestamp = entry.firstTimestamp;
            sessions.add(session);
        }
        return sessions;
    }

    /**
     * Update project index.
     */
    private void updateProjectIndex(
            SessionIndexManager.SessionIndex index,
            String projectPath,
            Path projectDir,
            List<ClaudeHistoryReader.SessionInfo> sessions
    ) {
        SessionIndexManager.ProjectIndex projectIndex = new SessionIndexManager.ProjectIndex();
        projectIndex.lastDirScanTime = System.currentTimeMillis();

        try (Stream<Path> paths = Files.list(projectDir)) {
            projectIndex.fileCount = (int) paths.filter(p -> p.toString().endsWith(".jsonl")).count();
        } catch (IOException e) {
            projectIndex.fileCount = sessions.size();
        }

        for (ClaudeHistoryReader.SessionInfo session : sessions) {
            SessionIndexManager.SessionIndexEntry entry = new SessionIndexManager.SessionIndexEntry();
            entry.sessionId = session.sessionId;
            entry.title = session.title;
            entry.messageCount = session.messageCount;
            entry.lastTimestamp = session.lastTimestamp;
            entry.firstTimestamp = session.firstTimestamp;
            projectIndex.sessions.add(entry);
        }

        index.projects.put(projectPath, projectIndex);
    }

    /**
     * Scan the project directory to build the session list (full scan).
     */
    private List<ClaudeHistoryReader.SessionInfo> scanProjectSessions(Path projectDir) throws IOException {
        List<ClaudeHistoryReader.SessionInfo> sessions = new ArrayList<>();
        Map<String, List<ClaudeHistoryReader.ConversationMessage>> sessionMessagesMap = new HashMap<>();

        Files.list(projectDir)
                .filter(path -> path.toString().endsWith(".jsonl"))
                .filter(path -> {
                    try {
                        return Files.size(path) > 0;
                    } catch (IOException e) {
                        return false;
                    }
                })
                .forEach(path -> {
                    try (BufferedReader reader = Files.newBufferedReader(path, java.nio.charset.StandardCharsets.UTF_8)) {
                        String fileName = path.getFileName().toString();
                        String sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));

                        List<ClaudeHistoryReader.ConversationMessage> messages = new ArrayList<>();
                        String line;

                        while ((line = reader.readLine()) != null) {
                            if (line.trim().isEmpty()) continue;

                            try {
                                ClaudeHistoryReader.ConversationMessage msg = gson.fromJson(line, ClaudeHistoryReader.ConversationMessage.class);
                                if (msg != null) {
                                    messages.add(msg);
                                }
                            } catch (Exception e) {
                                LOG.error("[ClaudeHistoryReader] Failed to parse message line: " + e.getMessage());
                            }
                        }

                        if (!messages.isEmpty()) {
                            sessionMessagesMap.put(sessionId, messages);
                        }

                    } catch (Exception e) {
                        LOG.error("[ClaudeHistoryReader] Failed to read session file: " + e.getMessage());
                    }
                });

        for (Map.Entry<String, List<ClaudeHistoryReader.ConversationMessage>> entry : sessionMessagesMap.entrySet()) {
            String sessionId = entry.getKey();
            List<ClaudeHistoryReader.ConversationMessage> messages = entry.getValue();

            if (messages.isEmpty()) continue;

            String summary = parser.generateSummary(messages);

            ClaudeHistoryParser.TimestampBounds timestampBounds = parser.extractTimestampBounds(messages);

            if (!parser.isValidSession(sessionId, summary, messages.size())) {
                continue;
            }

            ClaudeHistoryReader.SessionInfo session = new ClaudeHistoryReader.SessionInfo();
            session.sessionId = sessionId;
            session.title = summary;
            session.messageCount = messages.size();
            session.lastTimestamp = timestampBounds.lastTimestamp;
            session.firstTimestamp = timestampBounds.firstTimestamp;

            sessions.add(session);
        }

        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        return sessions;
    }
}
