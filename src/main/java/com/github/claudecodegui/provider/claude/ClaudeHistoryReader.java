package com.github.claudecodegui.provider.claude;

import com.google.gson.Gson;
import com.google.gson.JsonParser;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.TagExtractor;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Claude local history reader.
 * Reads Claude's history data directly from the local filesystem.
 */
public class ClaudeHistoryReader {

    private static final Logger LOG = Logger.getInstance(ClaudeHistoryReader.class);

    private static final String HOME_DIR = System.getProperty("user.home");
    private static final Path CLAUDE_DIR = Paths.get(HOME_DIR, ".claude");
    private static final Path HISTORY_FILE = CLAUDE_DIR.resolve("history.jsonl");
    private static final Path PROJECTS_DIR = CLAUDE_DIR.resolve("projects");

    private final Gson gson = new Gson();

    /**
     * History entry.
     */
    public static class HistoryEntry {
        public String display;
        public Map<String, Object> pastedContents;
        public long timestamp;
        public String project;
        public String sessionId;

        public HistoryEntry() {
            this.pastedContents = new HashMap<>();
        }
    }

    /**
     * Project info.
     */
    public static class ProjectInfo {
        public String path;
        public String name;
        public int count;
        public long lastAccess;
        public List<HistoryEntry> messages;

        public ProjectInfo(String path) {
            this.path = path;
            this.name = path != null ? Paths.get(path).getFileName().toString() : "Root";
            if (this.name.isEmpty()) {
                this.name = "Root";
            }
            this.count = 0;
            this.lastAccess = 0;
            this.messages = new ArrayList<>();
        }
    }

    /**
     * Conversation message (from projects directory).
     */
    public static class ConversationMessage {
        public String uuid;
        public String sessionId;
        public String parentUuid;
        public String timestamp;
        public String type;
        public Message message;
        public Boolean isMeta;
        public Boolean isSidechain;
        public String cwd;

        public static class Message {
            public String role;
            public Object content;
            public Usage usage;
        }

        public static class Usage {
            public int input_tokens;
            public int output_tokens;
            public int cache_creation_input_tokens;
            public int cache_read_input_tokens;
        }
    }

    /**
     * Token usage data structure.
     */
    public static class UsageData {
        public long inputTokens;
        public long outputTokens;
        public long cacheWriteTokens;
        public long cacheReadTokens;
        public long totalTokens;
    }

    public static class SessionSummary {
        public String sessionId;
        public long timestamp;
        public String model;
        public UsageData usage;
        public double cost;
        public String summary;
    }

    public static class DailyUsage {
        public String date;
        public int sessions;
        public UsageData usage;
        public double cost;
        public List<String> modelsUsed;
    }

    public static class ModelUsage {
        public String model;
        public double totalCost;
        public long totalTokens;
        public long inputTokens;
        public long outputTokens;
        public long cacheCreationTokens;
        public long cacheReadTokens;
        public int sessionCount;
    }

    public static class WeeklyComparison {
        public WeekData currentWeek;
        public WeekData lastWeek;
        public Trends trends;

        public static class WeekData {
            public int sessions;
            public double cost;
            public long tokens;
        }

        public static class Trends {
            public double sessions;
            public double cost;
            public double tokens;
        }
    }

    public static class ProjectStatistics {
        public String projectPath;
        public String projectName;
        public int totalSessions;
        public UsageData totalUsage;
        public double estimatedCost;
        public List<SessionSummary> sessions;
        public List<DailyUsage> dailyUsage;
        public WeeklyComparison weeklyComparison;
        public List<ModelUsage> byModel;
        public long lastUpdated;
    }

    /**
     * Read all sessions from a project directory.
     * Uses memory cache and file index for performance optimization.
     */
    public List<SessionInfo> readProjectSessions(String projectPath) throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();

        if (projectPath == null || projectPath.isEmpty()) {
            return sessions;
        }

        String sanitizedPath = PathUtils.sanitizePath(projectPath);
        Path projectDir = PROJECTS_DIR.resolve(sanitizedPath);

        if (!Files.exists(projectDir) || !Files.isDirectory(projectDir)) {
            return sessions;
        }

        // 1. 检查内存缓存
        SessionIndexCache cache = SessionIndexCache.getInstance();
        List<SessionInfo> cachedSessions = cache.getClaudeSessions(projectPath, projectDir);
        if (cachedSessions != null) {
            LOG.info("[ClaudeHistoryReader] Using memory cache for " + projectPath + ", sessions: " + cachedSessions.size());
            return cachedSessions;
        }

        // 2. 检查索引文件和更新类型
        SessionIndexManager indexManager = SessionIndexManager.getInstance();
        SessionIndexManager.SessionIndex index = indexManager.readClaudeIndex();
        SessionIndexManager.ProjectIndex projectIndex = index.projects.get(projectPath);
        SessionIndexManager.UpdateType updateType = indexManager.getUpdateType(projectIndex, projectDir);

        if (updateType == SessionIndexManager.UpdateType.NONE) {
            // 索引有效，从索引恢复
            LOG.info("[ClaudeHistoryReader] Using file index for " + projectPath + ", sessions: " + projectIndex.sessions.size());
            sessions = restoreSessionsFromIndex(projectIndex);
            // 更新内存缓存
            cache.updateClaudeCache(projectPath, projectDir, sessions);
            return sessions;
        }

        long startTime = System.currentTimeMillis();

        if (updateType == SessionIndexManager.UpdateType.INCREMENTAL && projectIndex != null) {
            // 3a. 增量更新：只扫描新文件
            LOG.info("[ClaudeHistoryReader] Incremental scan for " + projectPath);
            sessions = incrementalScan(projectDir, projectIndex);
        } else {
            // 3b. 全量扫描
            LOG.info("[ClaudeHistoryReader] Full scan for " + projectPath);
            sessions = scanProjectSessions(projectDir);
        }

        long scanTime = System.currentTimeMillis() - startTime;
        LOG.info("[ClaudeHistoryReader] Scan completed in " + scanTime + "ms, sessions: " + sessions.size());

        // 4. 更新索引
        updateProjectIndex(index, projectPath, projectDir, sessions);
        indexManager.saveClaudeIndex(index);

        // 5. 更新内存缓存
        cache.updateClaudeCache(projectPath, projectDir, sessions);

        return sessions;
    }

    /**
     * 增量扫描：只扫描新文件，合并已有索引
     */
    private List<SessionInfo> incrementalScan(Path projectDir, SessionIndexManager.ProjectIndex existingIndex) throws IOException {
        // 获取已索引的 sessionId 集合
        Set<String> indexedIds = existingIndex.getIndexedSessionIds();

        // 从现有索引恢复已有会话
        List<SessionInfo> sessions = restoreSessionsFromIndex(existingIndex);

        // 扫描新文件
        List<SessionInfo> newSessions = new ArrayList<>();
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
                    SessionInfo session = scanSingleSession(path);
                    if (session != null) {
                        newSessions.add(session);
                    }
                } catch (Exception e) {
                    LOG.error("[ClaudeHistoryReader] Failed to scan new session file: " + e.getMessage());
                }
            });

        LOG.info("[ClaudeHistoryReader] Incremental scan found " + newSessions.size() + " new sessions");

        // 合并新旧会话
        sessions.addAll(newSessions);

        // 按时间排序
        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        return sessions;
    }

    /**
     * 扫描单个会话文件
     */
    private SessionInfo scanSingleSession(Path path) {
        try (BufferedReader reader = Files.newBufferedReader(path, java.nio.charset.StandardCharsets.UTF_8)) {
            String fileName = path.getFileName().toString();
            String sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));

            List<ConversationMessage> messages = new ArrayList<>();
            String line;

            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;

                try {
                    ConversationMessage msg = gson.fromJson(line, ConversationMessage.class);
                    if (msg != null) {
                        messages.add(msg);
                    }
                } catch (Exception e) {
                    // Skip parse errors
                }
            }

            if (messages.isEmpty()) {
                return null;
            }

            String summary = generateSummary(messages);

            long lastTimestamp = 0;
            for (ConversationMessage msg : messages) {
                if (msg.timestamp != null) {
                    try {
                        long ts = parseTimestamp(msg.timestamp);
                        if (ts > lastTimestamp) {
                            lastTimestamp = ts;
                        }
                    } catch (Exception e) {
                        // Ignore
                    }
                }
            }

            if (!isValidSession(sessionId, summary, messages.size())) {
                return null;
            }

            SessionInfo session = new SessionInfo();
            session.sessionId = sessionId;
            session.title = summary;
            session.messageCount = messages.size();
            session.lastTimestamp = lastTimestamp;
            session.firstTimestamp = lastTimestamp;

            return session;
        } catch (Exception e) {
            LOG.error("[ClaudeHistoryReader] Failed to scan session: " + e.getMessage());
            return null;
        }
    }

    /**
     * 从索引恢复会话列表
     */
    private List<SessionInfo> restoreSessionsFromIndex(SessionIndexManager.ProjectIndex projectIndex) {
        List<SessionInfo> sessions = new ArrayList<>();
        for (SessionIndexManager.SessionIndexEntry entry : projectIndex.sessions) {
            SessionInfo session = new SessionInfo();
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
     * 更新项目索引
     */
    private void updateProjectIndex(
            SessionIndexManager.SessionIndex index,
            String projectPath,
            Path projectDir,
            List<SessionInfo> sessions
    ) {
        SessionIndexManager.ProjectIndex projectIndex = new SessionIndexManager.ProjectIndex();
        projectIndex.lastDirScanTime = System.currentTimeMillis();

        try (Stream<Path> paths = Files.list(projectDir)) {
            projectIndex.fileCount = (int) paths.filter(p -> p.toString().endsWith(".jsonl")).count();
        } catch (IOException e) {
            projectIndex.fileCount = sessions.size();
        }

        for (SessionInfo session : sessions) {
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
     * 扫描项目目录获取会话列表（原有逻辑）
     */
    private List<SessionInfo> scanProjectSessions(Path projectDir) throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();
        Map<String, List<ConversationMessage>> sessionMessagesMap = new HashMap<>();

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

                    List<ConversationMessage> messages = new ArrayList<>();
                    String line;

                    while ((line = reader.readLine()) != null) {
                        if (line.trim().isEmpty()) continue;

                        try {
                            ConversationMessage msg = gson.fromJson(line, ConversationMessage.class);
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

        for (Map.Entry<String, List<ConversationMessage>> entry : sessionMessagesMap.entrySet()) {
            String sessionId = entry.getKey();
            List<ConversationMessage> messages = entry.getValue();

            if (messages.isEmpty()) continue;

            String summary = generateSummary(messages);

            long lastTimestamp = 0;
            for (ConversationMessage msg : messages) {
                if (msg.timestamp != null) {
                    try {
                        long ts = parseTimestamp(msg.timestamp);
                        if (ts > lastTimestamp) {
                            lastTimestamp = ts;
                        }
                    } catch (Exception e) {
                        // Ignore invalid timestamp
                    }
                }
            }

            if (!isValidSession(sessionId, summary, messages.size())) {
                continue;
            }

            SessionInfo session = new SessionInfo();
            session.sessionId = sessionId;
            session.title = summary;
            session.messageCount = messages.size();
            session.lastTimestamp = lastTimestamp;
            session.firstTimestamp = lastTimestamp;

            sessions.add(session);
        }

        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        return sessions;
    }

    private String generateSummary(List<ConversationMessage> messages) {
        for (ConversationMessage msg : messages) {
            if ("user".equals(msg.type) &&
                (msg.isMeta == null || !msg.isMeta) &&
                msg.message != null &&
                msg.message.content != null) {

                String text = extractTextFromContent(msg.message.content);
                if (text != null && !text.isEmpty()) {
                    text = TagExtractor.extractCommandMessageContent(text);
                    text = text.replace("\n", " ").trim();
                    if (text.length() > 45) {
                        text = text.substring(0, 45) + "...";
                    }
                    return text;
                }
            }
        }
        return null;
    }

    private boolean isValidSession(String sessionId, String summary, int messageCount) {
        if (sessionId != null && sessionId.startsWith("agent-")) {
            return false;
        }

        if (summary == null || summary.isEmpty()) {
            return false;
        }

        String lowerSummary = summary.toLowerCase();
        if (lowerSummary.equals("warmup") ||
            lowerSummary.equals("no prompt") ||
            lowerSummary.startsWith("warmup") ||
            lowerSummary.startsWith("no prompt")) {
            return false;
        }

        if (messageCount < 2) {
            return false;
        }

        return true;
    }

    private String extractTextFromContent(Object content) {
        if (content instanceof String) {
            return (String) content;
        } else if (content instanceof List) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> contentList = (List<Map<String, Object>>) content;
            StringBuilder sb = new StringBuilder();

            for (Map<String, Object> item : contentList) {
                String type = (String) item.get("type");

                if ("text".equals(type)) {
                    Object text = item.get("text");
                    if (text instanceof String) {
                        if (sb.length() > 0) {
                            sb.append(" ");
                        }
                        sb.append((String) text);
                    }
                } else if ("tool_use".equals(type)) {
                    // Skip tool_use, don't display tool usage text
                }
            }

            String result = sb.toString().trim();
            return result.isEmpty() ? null : result;
        } else if (content instanceof com.google.gson.JsonArray) {
            com.google.gson.JsonArray contentArray = (com.google.gson.JsonArray) content;
            StringBuilder sb = new StringBuilder();

            for (int i = 0; i < contentArray.size(); i++) {
                com.google.gson.JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    com.google.gson.JsonObject item = element.getAsJsonObject();

                    String type = item.has("type") && !item.get("type").isJsonNull()
                        ? item.get("type").getAsString()
                        : null;

                    if ("text".equals(type) && item.has("text") && !item.get("text").isJsonNull()) {
                        if (sb.length() > 0) {
                            sb.append(" ");
                        }
                        sb.append(item.get("text").getAsString());
                    } else if ("tool_use".equals(type)) {
                        // Skip tool_use, don't display tool usage text
                    }
                }
            }

            String result = sb.toString().trim();
            return result.isEmpty() ? null : result;
        }

        return null;
    }

    private long parseTimestamp(String timestamp) {
        try {
            java.time.Instant instant = java.time.Instant.parse(timestamp);
            return instant.toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Session info.
     */
    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
    }

    /**
     * Statistics.
     */
    public static class Statistics {
        public int totalMessages;
        public int totalProjects;
        public HistoryEntry firstMessage;
        public HistoryEntry lastMessage;
        public Map<String, Integer> messagesByDay;

        public Statistics() {
            this.messagesByDay = new HashMap<>();
        }
    }

    /**
     * API response.
     */
    public static class ApiResponse {
        public boolean success;
        public String error;
        public Object data;

        public static ApiResponse success(Object data) {
            ApiResponse response = new ApiResponse();
            response.success = true;
            response.data = data;
            return response;
        }

        public static ApiResponse error(String message) {
            ApiResponse response = new ApiResponse();
            response.success = false;
            response.error = message;
            return response;
        }
    }

    /**
     * Read all history entries.
     */
    public List<HistoryEntry> readHistory() throws IOException {
        List<HistoryEntry> history = new ArrayList<>();

        if (!Files.exists(HISTORY_FILE)) {
            return history;
        }

        try (BufferedReader reader = Files.newBufferedReader(HISTORY_FILE, java.nio.charset.StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.trim().isEmpty()) {
                    try {
                        HistoryEntry entry = gson.fromJson(line, HistoryEntry.class);
                        if (entry != null) {
                            history.add(entry);
                        }
                    } catch (Exception e) {
                        // Skip parse failures
                    }
                }
            }
        }

        history.sort((a, b) -> Long.compare(b.timestamp, a.timestamp));

        return history;
    }

    /**
     * Get project list.
     */
    public List<ProjectInfo> getProjects(List<HistoryEntry> history) {
        Map<String, ProjectInfo> projectsMap = new HashMap<>();

        for (HistoryEntry entry : history) {
            if (entry.project != null) {
                ProjectInfo project = projectsMap.computeIfAbsent(
                    entry.project,
                    ProjectInfo::new
                );
                project.count++;
                project.messages.add(entry);
                if (entry.timestamp > project.lastAccess) {
                    project.lastAccess = entry.timestamp;
                }
            }
        }

        return projectsMap.values().stream()
            .sorted((a, b) -> Long.compare(b.lastAccess, a.lastAccess))
            .collect(Collectors.toList());
    }

    /**
     * Get statistics.
     */
    public Statistics getStatistics(List<HistoryEntry> history) {
        Statistics stats = new Statistics();
        stats.totalMessages = history.size();

        if (!history.isEmpty()) {
            List<HistoryEntry> sorted = new ArrayList<>(history);
            sorted.sort(Comparator.comparingLong(e -> e.timestamp));
            stats.firstMessage = sorted.get(0);
            stats.lastMessage = sorted.get(sorted.size() - 1);

            Set<String> projects = history.stream()
                .map(e -> e.project)
                .filter(Objects::nonNull)
                .collect(Collectors.toSet());
            stats.totalProjects = projects.size();

            for (HistoryEntry entry : history) {
                if (entry.timestamp > 0) {
                    Date date = new Date(entry.timestamp);
                    String dateStr = String.format("%tF", date);
                    stats.messagesByDay.merge(dateStr, 1, Integer::sum);
                }
            }
        }

        return stats;
    }

    /**
     * Search history.
     */
    public List<HistoryEntry> searchHistory(List<HistoryEntry> history, String query) {
        if (query == null || query.trim().isEmpty()) {
            return history;
        }

        String lowerQuery = query.toLowerCase();
        return history.stream()
            .filter(entry -> {
                String display = entry.display != null ? entry.display.toLowerCase() : "";
                return display.contains(lowerQuery);
            })
            .limit(100)
            .collect(Collectors.toList());
    }

    /**
     * Read project details.
     */
    public Map<String, Object> getProjectDetails(String projectPath) {
        Map<String, Object> details = new HashMap<>();
        details.put("path", projectPath);
        details.put("exists", false);
        details.put("conversations", new ArrayList<>());

        if (projectPath == null || projectPath.isEmpty()) {
            return details;
        }

        String sanitizedPath = PathUtils.sanitizePath(projectPath);
        Path projectDir = PROJECTS_DIR.resolve(sanitizedPath);

        if (Files.exists(projectDir) && Files.isDirectory(projectDir)) {
            details.put("exists", true);

            try {
                List<Map<String, Object>> conversations = new ArrayList<>();

                Files.list(projectDir)
                    .filter(Files::isDirectory)
                    .forEach(subDir -> {
                        Path convFile = subDir.resolve("conversation.json");
                        if (Files.exists(convFile)) {
                            try {
                                String content = new String(Files.readAllBytes(convFile));
                                Map<String, Object> convData = new HashMap<>();
                                convData.put("id", subDir.getFileName().toString());
                                convData.put("data", JsonParser.parseString(content));
                                convData.put("timestamp", Files.getLastModifiedTime(convFile).toMillis());
                                conversations.add(convData);
                            } catch (Exception e) {
                                // Skip read failures
                            }
                        }
                    });

                details.put("conversations", conversations);
            } catch (IOException e) {
                // Ignore read failures
            }
        }

        return details;
    }

    /**
     * Get project data as JSON string.
     */
    public String getProjectDataAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = readProjectSessions(projectPath);

            int totalMessages = sessions.stream()
                .mapToInt(s -> s.messageCount)
                .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("currentProject", projectPath);
            result.put("total", totalMessages);
            result.put("sessionCount", sessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            return gson.toJson(ApiResponse.error("Failed to read project data: " + e.getMessage()));
        }
    }

    /**
     * Read a single session's messages.
     */
    public String getSessionMessagesAsJson(String projectPath, String sessionId) {
        try {
            if (projectPath == null || projectPath.isEmpty() || sessionId == null || sessionId.isEmpty()) {
                return gson.toJson(new ArrayList<>());
            }

            String sanitizedPath = PathUtils.sanitizePath(projectPath);
            Path projectDir = PROJECTS_DIR.resolve(sanitizedPath);

            if (!Files.exists(projectDir) || !Files.isDirectory(projectDir)) {
                return gson.toJson(new ArrayList<>());
            }

            Path sessionFile = projectDir.resolve(sessionId + ".jsonl");
            if (!Files.exists(sessionFile)) {
                return gson.toJson(new ArrayList<>());
            }

            List<ConversationMessage> messages = new ArrayList<>();

            try (BufferedReader reader = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;

                    try {
                        ConversationMessage msg = gson.fromJson(line, ConversationMessage.class);
                        if (msg != null) {
                            messages.add(msg);
                        }
                    } catch (Exception e) {
                        LOG.error("[ClaudeHistoryReader] Failed to parse message line during export: " + e.getMessage());
                    }
                }
            }

            return gson.toJson(messages);
        } catch (Exception e) {
            LOG.error("[ClaudeHistoryReader] Failed to read session messages: " + e.getMessage(), e);
            return gson.toJson(new ArrayList<>());
        }
    }

    /**
     * Get all data as JSON string.
     */
    public String getAllDataAsJson() {
        try {
            List<HistoryEntry> history = readHistory();
            List<ProjectInfo> projects = getProjects(history);
            Statistics stats = getStatistics(history);

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("history", history.size() > 200 ? history.subList(0, 200) : history);
            result.put("projects", projects);
            result.put("stats", stats);
            result.put("total", history.size());

            return gson.toJson(result);
        } catch (Exception e) {
            return gson.toJson(ApiResponse.error("Failed to read data: " + e.getMessage()));
        }
    }

    // ==================== Statistics related code ====================

    private static final Map<String, Map<String, Double>> MODEL_PRICING = new HashMap<>();
    static {
        Map<String, Double> opus = new HashMap<>();
        opus.put("input", 15.0);
        opus.put("output", 75.0);
        opus.put("cacheWrite", 18.75);
        opus.put("cacheRead", 1.50);
        MODEL_PRICING.put("claude-opus-4", opus);

        Map<String, Double> sonnet = new HashMap<>();
        sonnet.put("input", 3.0);
        sonnet.put("output", 15.0);
        sonnet.put("cacheWrite", 3.75);
        sonnet.put("cacheRead", 0.30);
        MODEL_PRICING.put("claude-sonnet-4", sonnet);

        Map<String, Double> haiku = new HashMap<>();
        haiku.put("input", 0.8);
        haiku.put("output", 4.0);
        haiku.put("cacheWrite", 1.0);
        haiku.put("cacheRead", 0.08);
        MODEL_PRICING.put("claude-haiku-4", haiku);
    }

    private Map<String, Double> getModelPricing(String model) {
        String modelLower = model.toLowerCase();
        if (modelLower.contains("opus-4") || modelLower.contains("claude-opus-4")) {
            return MODEL_PRICING.get("claude-opus-4");
        } else if (modelLower.contains("haiku-4") || modelLower.contains("claude-haiku-4")) {
            return MODEL_PRICING.get("claude-haiku-4");
        }
        return MODEL_PRICING.get("claude-sonnet-4");
    }

    private String getProjectFolderName(String projectPath) {
        if (projectPath == null) return "";
        return PathUtils.sanitizePath(projectPath);
    }

    /**
     * Get project usage statistics.
     */
    public ProjectStatistics getProjectStatistics(String projectPath) {
        ProjectStatistics stats = new ProjectStatistics();
        stats.projectPath = projectPath;
        stats.projectName = projectPath.equals("all") ? "All Projects" : Paths.get(projectPath).getFileName().toString();
        stats.totalUsage = new UsageData();
        stats.sessions = new ArrayList<>();
        stats.dailyUsage = new ArrayList<>();
        stats.byModel = new ArrayList<>();
        stats.weeklyComparison = new WeeklyComparison();
        stats.lastUpdated = System.currentTimeMillis();

        try {
            List<SessionSummary> allSessions = new ArrayList<>();

            if ("all".equals(projectPath)) {
                if (Files.exists(PROJECTS_DIR)) {
                    Files.list(PROJECTS_DIR)
                        .filter(Files::isDirectory)
                        .forEach(dir -> {
                            try {
                                allSessions.addAll(readSessionsFromDir(dir));
                            } catch (Exception e) {
                                // Skip read failures
                            }
                        });
                }
            } else {
                String folderName1 = projectPath.replaceAll("[^a-zA-Z0-9]", "-");
                Path dir1 = PROJECTS_DIR.resolve(folderName1);

                String folderName2 = getProjectFolderName(projectPath);
                Path dir2 = PROJECTS_DIR.resolve(folderName2);

                if (Files.exists(dir1)) {
                    allSessions.addAll(readSessionsFromDir(dir1));
                } else if (Files.exists(dir2)) {
                    allSessions.addAll(readSessionsFromDir(dir2));
                }
            }

            stats.totalSessions = allSessions.size();

            processSessions(allSessions, stats);

            return stats;

        } catch (Exception e) {
            return stats;
        }
    }

    private List<SessionSummary> readSessionsFromDir(Path projectDir) {
        List<SessionSummary> sessions = new ArrayList<>();
        Set<String> processedHashes = new HashSet<>();

        try {
            Files.list(projectDir)
                .filter(p -> p.toString().endsWith(".jsonl"))
                .forEach(p -> {
                    SessionSummary session = parseSessionFile(p, processedHashes);
                    if (session != null) {
                        sessions.add(session);
                    }
                });
        } catch (IOException e) {
            // Ignore read failures
        }
        return sessions;
    }

    private SessionSummary parseSessionFile(Path filePath, Set<String> processedHashes) {
        try (BufferedReader reader = Files.newBufferedReader(filePath, java.nio.charset.StandardCharsets.UTF_8)) {
            UsageData usage = new UsageData();
            double totalCost = 0;
            String model = "unknown";
            long firstTimestamp = 0;
            String summary = null;

            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;

                try {
                    ConversationMessage msg = gson.fromJson(line, ConversationMessage.class);

                    if (firstTimestamp == 0 && msg.timestamp != null) {
                        firstTimestamp = parseTimestamp(msg.timestamp);
                    }

                    if ("summary".equals(msg.type) && msg.message != null && msg.message.content instanceof String) {
                        Map<String, Object> rawMap = gson.fromJson(line, Map.class);
                        if (rawMap.containsKey("summary")) {
                            Object s = rawMap.get("summary");
                            if (s instanceof String) summary = (String) s;
                        }
                    }

                    if ("assistant".equals(msg.type) && msg.message != null && msg.message.usage != null) {
                        ConversationMessage.Usage u = msg.message.usage;

                        if (u.input_tokens > 0 || u.output_tokens > 0 || u.cache_creation_input_tokens > 0 || u.cache_read_input_tokens > 0) {
                             usage.inputTokens += u.input_tokens;
                             usage.outputTokens += u.output_tokens;
                             usage.cacheWriteTokens += u.cache_creation_input_tokens;
                             usage.cacheReadTokens += u.cache_read_input_tokens;

                             if (msg.message.role != null && model.equals("unknown")) {
                                 Map<String, Object> rawMap = gson.fromJson(line, Map.class);
                                 if (rawMap.containsKey("message")) {
                                     Map m = (Map) rawMap.get("message");
                                     if (m.containsKey("model")) {
                                         model = (String) m.get("model");
                                     }
                                 }
                             }

                             Map<String, Double> pricing = getModelPricing(model);
                             double cost = (u.input_tokens * pricing.get("input") +
                                          u.output_tokens * pricing.get("output") +
                                          u.cache_creation_input_tokens * pricing.get("cacheWrite") +
                                          u.cache_read_input_tokens * pricing.get("cacheRead")) / 1_000_000.0;
                             totalCost += cost;
                        }
                    }
                } catch (Exception e) {
                    // ignore
                }
            }

            usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;

            if (usage.totalTokens == 0) return null;

            SessionSummary session = new SessionSummary();
            session.sessionId = filePath.getFileName().toString().replace(".jsonl", "");
            session.timestamp = firstTimestamp > 0 ? firstTimestamp : System.currentTimeMillis();
            session.model = model;
            session.usage = usage;
            session.cost = totalCost;
            session.summary = summary;

            return session;

        } catch (IOException e) {
            return null;
        }
    }

    private void processSessions(List<SessionSummary> sessions, ProjectStatistics stats) {
        Map<String, DailyUsage> dailyMap = new HashMap<>();
        Map<String, ModelUsage> modelMap = new HashMap<>();

        long now = System.currentTimeMillis();
        long oneWeekAgo = now - 7L * 24 * 3600 * 1000;
        long twoWeeksAgo = now - 14L * 24 * 3600 * 1000;

        WeeklyComparison.WeekData currentWeek = new WeeklyComparison.WeekData();
        WeeklyComparison.WeekData lastWeek = new WeeklyComparison.WeekData();

        for (SessionSummary session : sessions) {
            stats.totalUsage.inputTokens += session.usage.inputTokens;
            stats.totalUsage.outputTokens += session.usage.outputTokens;
            stats.totalUsage.cacheWriteTokens += session.usage.cacheWriteTokens;
            stats.totalUsage.cacheReadTokens += session.usage.cacheReadTokens;
            stats.totalUsage.totalTokens += session.usage.totalTokens;
            stats.estimatedCost += session.cost;

            String dateStr = String.format("%tF", new Date(session.timestamp));
            DailyUsage daily = dailyMap.computeIfAbsent(dateStr, k -> {
                DailyUsage d = new DailyUsage();
                d.date = k;
                d.usage = new UsageData();
                d.modelsUsed = new ArrayList<>();
                return d;
            });
            daily.sessions++;
            daily.cost += session.cost;
            daily.usage.inputTokens += session.usage.inputTokens;
            daily.usage.outputTokens += session.usage.outputTokens;
            if (!daily.modelsUsed.contains(session.model)) {
                daily.modelsUsed.add(session.model);
            }

            ModelUsage modelStat = modelMap.computeIfAbsent(session.model, k -> {
                ModelUsage m = new ModelUsage();
                m.model = k;
                return m;
            });
            modelStat.sessionCount++;
            modelStat.totalCost += session.cost;
            modelStat.totalTokens += session.usage.totalTokens;
            modelStat.inputTokens += session.usage.inputTokens;
            modelStat.outputTokens += session.usage.outputTokens;
            modelStat.cacheCreationTokens += session.usage.cacheWriteTokens;
            modelStat.cacheReadTokens += session.usage.cacheReadTokens;

            if (session.timestamp > oneWeekAgo) {
                currentWeek.sessions++;
                currentWeek.cost += session.cost;
                currentWeek.tokens += session.usage.totalTokens;
            } else if (session.timestamp > twoWeeksAgo) {
                lastWeek.sessions++;
                lastWeek.cost += session.cost;
                lastWeek.tokens += session.usage.totalTokens;
            }
        }

        stats.dailyUsage = new ArrayList<>(dailyMap.values());
        stats.dailyUsage.sort(Comparator.comparing(d -> d.date));

        stats.byModel = new ArrayList<>(modelMap.values());
        stats.byModel.sort((a, b) -> Double.compare(b.totalCost, a.totalCost));

        stats.sessions = sessions;
        stats.sessions.sort((a, b) -> Long.compare(b.timestamp, a.timestamp));
        if (stats.sessions.size() > 200) {
            stats.sessions = stats.sessions.subList(0, 200);
        }

        stats.weeklyComparison.currentWeek = currentWeek;
        stats.weeklyComparison.lastWeek = lastWeek;
        stats.weeklyComparison.trends = new WeeklyComparison.Trends();
        stats.weeklyComparison.trends.sessions = calculateTrend(currentWeek.sessions, lastWeek.sessions);
        stats.weeklyComparison.trends.cost = calculateTrend(currentWeek.cost, lastWeek.cost);
        stats.weeklyComparison.trends.tokens = calculateTrend(currentWeek.tokens, lastWeek.tokens);
    }

    private double calculateTrend(double current, double last) {
        if (last == 0) return 0;
        return ((current - last) / last) * 100;
    }

    /**
     * Handle API request.
     */
    public String handleApiRequest(String endpoint, Map<String, String> params) {
        try {
            switch (endpoint) {
                case "/history":
                    return getAllDataAsJson();

                case "/stats":
                    List<HistoryEntry> historyForStats = readHistory();
                    Statistics stats = getStatistics(historyForStats);
                    return gson.toJson(ApiResponse.success(stats));

                case "/search":
                    String query = params.get("q");
                    List<HistoryEntry> historyForSearch = readHistory();
                    List<HistoryEntry> searchResults = searchHistory(historyForSearch, query);
                    Map<String, Object> searchResponse = new HashMap<>();
                    searchResponse.put("query", query);
                    searchResponse.put("count", searchResults.size());
                    searchResponse.put("results", searchResults);
                    return gson.toJson(ApiResponse.success(searchResponse));

                case "/project":
                    String projectPath = params.get("path");
                    Map<String, Object> projectDetails = getProjectDetails(projectPath);
                    return gson.toJson(ApiResponse.success(projectDetails));

                default:
                    return gson.toJson(ApiResponse.error("Unknown endpoint: " + endpoint));
            }
        } catch (Exception e) {
            return gson.toJson(ApiResponse.error("Failed to handle request: " + e.getMessage()));
        }
    }
}
