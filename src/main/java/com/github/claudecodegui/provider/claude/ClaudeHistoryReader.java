package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * Claude local history reader.
 * Reads Claude's history data directly from the local filesystem.
 * Acts as a Facade, delegating to specialized sub-services.
 */
public class ClaudeHistoryReader {

    private static final Logger LOG = Logger.getInstance(ClaudeHistoryReader.class);

    private static final String HOME_DIR = PlatformUtils.getHomeDirectory();
    private static final Path CLAUDE_DIR = Paths.get(HOME_DIR, ".claude");
    private static final Path HISTORY_FILE = CLAUDE_DIR.resolve("history.jsonl");
    static final Path PROJECTS_DIR = CLAUDE_DIR.resolve("projects");

    private final Gson gson = new Gson();

    // Sub-services
    private final ClaudeHistoryParser parser;
    private final ClaudeHistoryIndexService indexService;
    private final ClaudeUsageAggregator usageAggregator;
    private final ClaudeHistorySearchService searchService;

    public ClaudeHistoryReader() {
        this.parser = new ClaudeHistoryParser();
        this.indexService = new ClaudeHistoryIndexService(PROJECTS_DIR, parser);
        this.usageAggregator = new ClaudeUsageAggregator(PROJECTS_DIR, parser);
        this.searchService = new ClaudeHistorySearchService(PROJECTS_DIR, this, indexService);
    }

    // ==================== DTO Inner Classes ====================

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
     * Session info.
     */
    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public long fileSize;
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

    // ==================== Core Methods (kept in Facade) ====================

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

    // ==================== Delegated Methods ====================

    public List<SessionInfo> readProjectSessions(String projectPath) throws IOException {
        return indexService.readProjectSessions(projectPath);
    }

    public Statistics getStatistics(List<HistoryEntry> history) {
        return searchService.getStatistics(history);
    }

    public List<HistoryEntry> searchHistory(List<HistoryEntry> history, String query) {
        return searchService.searchHistory(history, query);
    }

    public Map<String, Object> getProjectDetails(String projectPath) {
        return searchService.getProjectDetails(projectPath);
    }

    public String getProjectDataAsJson(String projectPath) {
        return searchService.getProjectDataAsJson(projectPath);
    }

    public String getSessionMessagesAsJson(String projectPath, String sessionId) {
        return searchService.getSessionMessagesAsJson(projectPath, sessionId);
    }

    public String getAllDataAsJson() {
        return searchService.getAllDataAsJson();
    }

    public ProjectStatistics getProjectStatistics(String projectPath, long cutoffTime) {
        return usageAggregator.getProjectStatistics(projectPath, cutoffTime);
    }

    public String handleApiRequest(String endpoint, Map<String, String> params) {
        return searchService.handleApiRequest(endpoint, params);
    }
}
