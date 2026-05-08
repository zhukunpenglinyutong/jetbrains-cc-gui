package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Handles search queries, data retrieval, and API request routing.
 */
class ClaudeHistorySearchService {

    private static final Logger LOG = Logger.getInstance(ClaudeHistorySearchService.class);

    private final Path projectsDir;
    private final ClaudeHistoryReader reader;
    private final ClaudeHistoryIndexService indexService;
    private final Gson gson = new Gson();

    ClaudeHistorySearchService(Path projectsDir, ClaudeHistoryReader reader, ClaudeHistoryIndexService indexService) {
        this.projectsDir = projectsDir;
        this.reader = reader;
        this.indexService = indexService;
    }

    /**
     * Get statistics.
     */
    ClaudeHistoryReader.Statistics getStatistics(List<ClaudeHistoryReader.HistoryEntry> history) {
        ClaudeHistoryReader.Statistics stats = new ClaudeHistoryReader.Statistics();
        stats.totalMessages = history.size();

        if (!history.isEmpty()) {
            List<ClaudeHistoryReader.HistoryEntry> sorted = new ArrayList<>(history);
            sorted.sort(Comparator.comparingLong(e -> e.timestamp));
            stats.firstMessage = sorted.get(0);
            stats.lastMessage = sorted.get(sorted.size() - 1);

            Set<String> projects = history.stream()
                                           .map(e -> e.project)
                                           .filter(Objects::nonNull)
                                           .collect(Collectors.toSet());
            stats.totalProjects = projects.size();

            for (ClaudeHistoryReader.HistoryEntry entry : history) {
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
    List<ClaudeHistoryReader.HistoryEntry> searchHistory(List<ClaudeHistoryReader.HistoryEntry> history, String query) {
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
    Map<String, Object> getProjectDetails(String projectPath) {
        Map<String, Object> details = new HashMap<>();
        details.put("path", projectPath);
        details.put("exists", false);
        details.put("conversations", new ArrayList<>());

        if (projectPath == null || projectPath.isEmpty()) {
            return details;
        }

        String sanitizedPath = PathUtils.sanitizePath(projectPath);
        Path projectDir = projectsDir.resolve(sanitizedPath);

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
                                    String content = new String(Files.readAllBytes(convFile), java.nio.charset.StandardCharsets.UTF_8);
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
    String getProjectDataAsJson(String projectPath) {
        try {
            List<ClaudeHistoryReader.SessionInfo> sessions = indexService.readProjectSessions(projectPath);

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
            return gson.toJson(ClaudeHistoryReader.ApiResponse.error("Failed to read project data: " + e.getMessage()));
        }
    }

    /**
     * Read a single session's messages.
     */
    String getSessionMessagesAsJson(String projectPath, String sessionId) {
        try {
            if (projectPath == null || projectPath.isEmpty() || sessionId == null || sessionId.isEmpty()) {
                return gson.toJson(new ArrayList<>());
            }

            String sanitizedPath = PathUtils.sanitizePath(projectPath);
            Path projectDir = projectsDir.resolve(sanitizedPath);

            if (!Files.exists(projectDir) || !Files.isDirectory(projectDir)) {
                return gson.toJson(new ArrayList<>());
            }

            Path sessionFile = projectDir.resolve(sessionId + ".jsonl");
            if (!Files.exists(sessionFile)) {
                return gson.toJson(new ArrayList<>());
            }

            List<ClaudeHistoryReader.ConversationMessage> messages = new ArrayList<>();

            try (BufferedReader br = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
                String line;
                while ((line = br.readLine()) != null) {
                    if (line.trim().isEmpty()) { continue; }

                    try {
                        ClaudeHistoryReader.ConversationMessage msg = gson.fromJson(line, ClaudeHistoryReader.ConversationMessage.class);
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
    String getAllDataAsJson() {
        try {
            List<ClaudeHistoryReader.HistoryEntry> history = reader.readHistory();
            List<ClaudeHistoryReader.ProjectInfo> projects = reader.getProjects(history);
            ClaudeHistoryReader.Statistics stats = getStatistics(history);

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("history", history.size() > 200 ? history.subList(0, 200) : history);
            result.put("projects", projects);
            result.put("stats", stats);
            result.put("total", history.size());

            return gson.toJson(result);
        } catch (Exception e) {
            return gson.toJson(ClaudeHistoryReader.ApiResponse.error("Failed to read data: " + e.getMessage()));
        }
    }

    /**
     * Handle API request.
     */
    String handleApiRequest(String endpoint, Map<String, String> params) {
        try {
            switch (endpoint) {
                case "/history":
                    return getAllDataAsJson();

                case "/stats":
                    List<ClaudeHistoryReader.HistoryEntry> historyForStats = reader.readHistory();
                    ClaudeHistoryReader.Statistics stats = getStatistics(historyForStats);
                    return gson.toJson(ClaudeHistoryReader.ApiResponse.success(stats));

                case "/search":
                    String query = params.get("q");
                    List<ClaudeHistoryReader.HistoryEntry> historyForSearch = reader.readHistory();
                    List<ClaudeHistoryReader.HistoryEntry> searchResults = searchHistory(historyForSearch, query);
                    Map<String, Object> searchResponse = new HashMap<>();
                    searchResponse.put("query", query);
                    searchResponse.put("count", searchResults.size());
                    searchResponse.put("results", searchResults);
                    return gson.toJson(ClaudeHistoryReader.ApiResponse.success(searchResponse));

                case "/project":
                    String projectPath = params.get("path");
                    Map<String, Object> projectDetails = getProjectDetails(projectPath);
                    return gson.toJson(ClaudeHistoryReader.ApiResponse.success(projectDetails));

                default:
                    return gson.toJson(ClaudeHistoryReader.ApiResponse.error("Unknown endpoint: " + endpoint));
            }
        } catch (Exception e) {
            return gson.toJson(ClaudeHistoryReader.ApiResponse.error("Failed to handle request: " + e.getMessage()));
        }
    }
}
