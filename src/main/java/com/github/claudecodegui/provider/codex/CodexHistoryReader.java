package com.github.claudecodegui.provider.codex;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Codex local history reader.
 * Reads Codex CLI session history from ~/.codex/sessions directory.
 */
public class CodexHistoryReader {

    private static final Logger LOG = Logger.getInstance(CodexHistoryReader.class);

    private static final String HOME_DIR = System.getProperty("user.home");
    private static final Path CODEX_SESSIONS_DIR = Paths.get(HOME_DIR, ".codex", "sessions");

    private final Gson gson = new Gson();

    /**
     * Session info.
     */
    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
    }

    /**
     * Usage data structure (compatible with Claude format).
     */
    public static class UsageData {
        public long inputTokens;
        public long outputTokens;
        public long cacheWriteTokens;
        public long cacheReadTokens;
        public long totalTokens;
    }

    /**
     * Session summary for statistics.
     */
    public static class SessionSummary {
        public String sessionId;
        public long timestamp;
        public String model;
        public UsageData usage;
        public double cost;
        public String summary;
    }

    /**
     * Daily usage statistics.
     */
    public static class DailyUsage {
        public String date;
        public int sessions;
        public UsageData usage;
        public double cost;
        public List<String> modelsUsed;
    }

    /**
     * Model usage statistics.
     */
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

    /**
     * Weekly comparison data.
     */
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

    /**
     * Project statistics.
     */
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
     * Codex message format.
     */
    public static class CodexMessage {
        public String timestamp;
        public String type;
        public JsonObject payload;
    }

    /**
     * Read all Codex sessions.
     * Returns all sessions regardless of project.
     */
    public List<SessionInfo> readAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();

        if (!Files.exists(CODEX_SESSIONS_DIR) || !Files.isDirectory(CODEX_SESSIONS_DIR)) {
            LOG.info("[CodexHistoryReader] Codex sessions directory not found: " + CODEX_SESSIONS_DIR);
            return sessions;
        }

        try (Stream<Path> paths = Files.walk(CODEX_SESSIONS_DIR)) {
            List<Path> jsonlFiles = paths
                .filter(Files::isRegularFile)
                .filter(path -> path.toString().endsWith(".jsonl"))
                .filter(path -> {
                    try {
                        return Files.size(path) > 0;
                    } catch (IOException e) {
                        return false;
                    }
                })
                .collect(Collectors.toList());

            LOG.info("[CodexHistoryReader] Found " + jsonlFiles.size() + " Codex session files");

            for (Path sessionFile : jsonlFiles) {
                try {
                    SessionInfo session = parseSessionFile(sessionFile);
                    if (session != null && isValidSession(session)) {
                        sessions.add(session);
                    }
                } catch (Exception e) {
                    LOG.warn("[CodexHistoryReader] Failed to parse session file: " + sessionFile + " - " + e.getMessage());
                }
            }
        }

        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        LOG.info("[CodexHistoryReader] Successfully loaded " + sessions.size() + " valid Codex sessions");
        return sessions;
    }

    /**
     * Parse a single session file.
     */
    private SessionInfo parseSessionFile(Path sessionFile) throws IOException {
        SessionInfo session = new SessionInfo();

        String fileName = sessionFile.getFileName().toString();
        session.sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));

        List<CodexMessage> messages = new ArrayList<>();
        String sessionMeta = null;
        int messageCount = 0;

        try (BufferedReader reader = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;

                try {
                    CodexMessage msg = gson.fromJson(line, CodexMessage.class);
                    if (msg != null) {
                        messages.add(msg);

                        if ("session_meta".equals(msg.type) && msg.payload != null) {
                            sessionMeta = msg.payload.toString();

                            if (msg.payload.has("cwd")) {
                                session.cwd = msg.payload.get("cwd").getAsString();
                            }

                            if (msg.payload.has("timestamp")) {
                                try {
                                    String ts = msg.payload.get("timestamp").getAsString();
                                    session.firstTimestamp = parseTimestamp(ts);
                                    session.lastTimestamp = session.firstTimestamp;
                                } catch (Exception e) {
                                    // Ignore timestamp parse error
                                }
                            }
                        }

                        if ("response_item".equals(msg.type)) {
                            messageCount++;
                        }

                        if (msg.timestamp != null) {
                            try {
                                long ts = parseTimestamp(msg.timestamp);
                                if (ts > session.lastTimestamp) {
                                    session.lastTimestamp = ts;
                                }
                            } catch (Exception e) {
                                // Ignore timestamp parse error
                            }
                        }
                    }
                } catch (Exception e) {
                    LOG.debug("[CodexHistoryReader] Failed to parse line: " + e.getMessage());
                }
            }
        }

        session.messageCount = messageCount;
        session.title = generateTitle(messages);

        return session;
    }

    /**
     * Generate session title.
     * Extracts content from the first user_message event_msg.
     */
    private String generateTitle(List<CodexMessage> messages) {
        for (CodexMessage msg : messages) {
            if ("event_msg".equals(msg.type) && msg.payload != null) {
                JsonObject payload = msg.payload;

                if (payload.has("type") && "user_message".equals(payload.get("type").getAsString())) {
                    if (payload.has("message")) {
                        String text = payload.get("message").getAsString();
                        if (text != null && !text.isEmpty()) {
                            text = text.replace("\n", " ").trim();
                            if (text.length() > 45) {
                                text = text.substring(0, 45) + "...";
                            }
                            return text;
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * Extract text from content.
     */
    private String extractTextFromContent(JsonElement contentElem) {
        if (contentElem == null) {
            return null;
        }

        if (contentElem.isJsonPrimitive()) {
            return contentElem.getAsString();
        }

        if (contentElem.isJsonArray()) {
            JsonArray contentArray = contentElem.getAsJsonArray();
            StringBuilder sb = new StringBuilder();

            for (JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    JsonObject itemObj = item.getAsJsonObject();

                    if (itemObj.has("type") && "text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append(" ");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    } else if (itemObj.has("type") && "input_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append(" ");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                }
            }

            String result = sb.toString().trim();
            return result.isEmpty() ? null : result;
        }

        return null;
    }

    /**
     * Check if session is valid.
     */
    private boolean isValidSession(SessionInfo session) {
        if (session.title == null || session.title.isEmpty()) {
            return false;
        }

        if (session.messageCount < 1) {
            return false;
        }

        return true;
    }

    /**
     * Parse timestamp (ISO 8601 format).
     */
    private long parseTimestamp(String timestamp) {
        try {
            java.time.Instant instant = java.time.Instant.parse(timestamp);
            return instant.toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Get all sessions as JSON string.
     */
    public String getAllSessionsAsJson() {
        try {
            List<SessionInfo> sessions = readAllSessions();

            int totalMessages = sessions.stream()
                .mapToInt(s -> s.messageCount)
                .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("total", totalMessages);
            result.put("sessionCount", sessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Codex sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    /**
     * Get sessions filtered by project path as JSON string.
     * Only returns sessions whose cwd matches or is under the specified project path.
     * @param projectPath The project path to filter by
     */
    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> allSessions = readAllSessions();

            // Normalize the project path for comparison
            String normalizedProjectPath = normalizePath(projectPath);

            LOG.info("[CodexHistoryReader] Filtering sessions for project: " + normalizedProjectPath);
            LOG.info("[CodexHistoryReader] Total sessions before filtering: " + allSessions.size());

            // Filter sessions by cwd
            List<SessionInfo> filteredSessions = allSessions.stream()
                .filter(session -> {
                    if (session.cwd == null || session.cwd.isEmpty()) {
                        return false;
                    }
                    String normalizedCwd = normalizePath(session.cwd);
                    // Match if cwd equals project path or is a subdirectory of it
                    boolean matches = normalizedCwd.equals(normalizedProjectPath) ||
                                     normalizedCwd.startsWith(normalizedProjectPath + "/");
                    if (matches) {
                        LOG.debug("[CodexHistoryReader] Session " + session.sessionId + " matches (cwd: " + session.cwd + ")");
                    }
                    return matches;
                })
                .collect(Collectors.toList());

            LOG.info("[CodexHistoryReader] Sessions after filtering: " + filteredSessions.size());

            int totalMessages = filteredSessions.stream()
                .mapToInt(s -> s.messageCount)
                .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", filteredSessions);
            result.put("total", totalMessages);
            result.put("sessionCount", filteredSessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read sessions for project: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Codex sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    /**
     * Normalize path for comparison.
     * Converts backslashes to forward slashes and removes trailing slashes.
     */
    private String normalizePath(String path) {
        if (path == null) {
            return "";
        }
        // Convert backslashes to forward slashes
        String normalized = path.replace("\\", "/");
        // Remove trailing slash
        while (normalized.endsWith("/") && normalized.length() > 1) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    /**
     * Check if command is a file/directory viewing operation.
     */
    private boolean isFileViewingCommand(String command) {
        if (command == null || command.isEmpty()) {
            return false;
        }
        String trimmed = command.trim();
        return trimmed.matches("^(pwd|ls|cat|head|tail|tree|file|stat)\\b.*") ||
               trimmed.matches("^sed\\s+-n\\s+.*");
    }

    /**
     * Transform Codex function_call to Claude compatible format.
     * Converts file viewing shell_command to read tool.
     */
    private CodexMessage transformFunctionCall(CodexMessage msg) {
        if (msg == null || !"response_item".equals(msg.type) || msg.payload == null) {
            return msg;
        }

        JsonObject payload = msg.payload;

        if (!payload.has("type") || !"function_call".equals(payload.get("type").getAsString())) {
            return msg;
        }

        if (!payload.has("name") || !"shell_command".equals(payload.get("name").getAsString())) {
            return msg;
        }

        if (!payload.has("arguments")) {
            return msg;
        }

        try {
            String argumentsStr = payload.get("arguments").getAsString();
            JsonObject arguments = gson.fromJson(argumentsStr, JsonObject.class);

            if (arguments != null && arguments.has("command")) {
                String command = arguments.get("command").getAsString();

                if (isFileViewingCommand(command)) {
                    payload.addProperty("name", "read");
                    LOG.debug("[CodexHistoryReader] Transformed shell_command to read for: " + command);
                }
            }
        } catch (Exception e) {
            LOG.debug("[CodexHistoryReader] Failed to parse arguments: " + e.getMessage());
        }

        return msg;
    }

    /**
     * Read a single session's messages.
     */
    public String getSessionMessagesAsJson(String sessionId) {
        try {
            Path sessionFile = findSessionFile(sessionId);
            if (sessionFile == null) {
                LOG.warn("[CodexHistoryReader] Session file not found for: " + sessionId);
                return gson.toJson(new ArrayList<>());
            }

            List<CodexMessage> messages = new ArrayList<>();

            try (BufferedReader reader = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;

                    try {
                        CodexMessage msg = gson.fromJson(line, CodexMessage.class);
                        if (msg != null) {
                            msg = transformFunctionCall(msg);
                            messages.add(msg);
                        }
                    } catch (Exception e) {
                        LOG.debug("[CodexHistoryReader] Failed to parse message: " + e.getMessage());
                    }
                }
            }

            return gson.toJson(messages);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read session messages: " + e.getMessage(), e);
            return gson.toJson(new ArrayList<>());
        }
    }

    /**
     * Find session file.
     */
    private Path findSessionFile(String sessionId) throws IOException {
        if (!Files.exists(CODEX_SESSIONS_DIR)) {
            return null;
        }

        try (Stream<Path> paths = Files.walk(CODEX_SESSIONS_DIR)) {
            return paths
                .filter(Files::isRegularFile)
                .filter(path -> path.getFileName().toString().startsWith(sessionId))
                .filter(path -> path.toString().endsWith(".jsonl"))
                .findFirst()
                .orElse(null);
        }
    }

    /**
     * Get project statistics for usage tracking.
     * Note: Codex sessions don't store project path, so we return all sessions.
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
        stats.weeklyComparison.currentWeek = new WeeklyComparison.WeekData();
        stats.weeklyComparison.lastWeek = new WeeklyComparison.WeekData();
        stats.weeklyComparison.trends = new WeeklyComparison.Trends();
        stats.lastUpdated = System.currentTimeMillis();

        try {
            List<SessionSummary> allSessions = readAllSessionSummaries();
            LOG.info("[CodexHistoryReader] Total sessions before filtering: " + allSessions.size());

            // Filter sessions by project if needed
            // Note: Codex sessions don't store project path, so we skip filtering for Codex
            // and always return all sessions
            if (!projectPath.equals("all")) {
                LOG.info("[CodexHistoryReader] Project-based filtering requested for: " + projectPath);
                LOG.info("[CodexHistoryReader] Codex sessions don't track project paths, showing all sessions instead");
                // Don't filter Codex sessions by project - show all
            }

            stats.totalSessions = allSessions.size();
            LOG.info("[CodexHistoryReader] Final sessions count: " + stats.totalSessions);
            processSessions(allSessions, stats);

            return stats;
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to get project statistics: " + e.getMessage(), e);
            return stats;
        }
    }

    /**
     * Read all session summaries with usage data.
     */
    private List<SessionSummary> readAllSessionSummaries() throws IOException {
        List<SessionSummary> sessions = new ArrayList<>();

        if (!Files.exists(CODEX_SESSIONS_DIR) || !Files.isDirectory(CODEX_SESSIONS_DIR)) {
            return sessions;
        }

        // Codex organizes sessions by date: ~/.codex/sessions/YYYY/MM/DD/*.jsonl
        // We need to recursively walk the directory tree
        try (Stream<Path> paths = Files.walk(CODEX_SESSIONS_DIR, 10)) {
            List<Path> jsonlFiles = paths
                .filter(Files::isRegularFile)
                .filter(path -> path.toString().endsWith(".jsonl"))
                .filter(path -> {
                    try {
                        return Files.size(path) > 0;
                    } catch (IOException e) {
                        return false;
                    }
                })
                .collect(Collectors.toList());

            LOG.info("[CodexHistoryReader] Found " + jsonlFiles.size() + " Codex session files");

            for (Path sessionFile : jsonlFiles) {
                try {
                    SessionSummary summary = parseSessionSummary(sessionFile);
                    if (summary != null) {
                        sessions.add(summary);
                    }
                } catch (Exception e) {
                    LOG.warn("[CodexHistoryReader] Failed to parse session summary: " + sessionFile + " - " + e.getMessage());
                }
            }
        }

        sessions.sort((a, b) -> Long.compare(b.timestamp, a.timestamp));
        LOG.info("[CodexHistoryReader] Successfully loaded " + sessions.size() + " valid Codex sessions");
        return sessions;
    }

    /**
     * Parse session summary with usage data from Codex session file.
     */
    private SessionSummary parseSessionSummary(Path sessionFile) throws IOException {
        SessionSummary summary = new SessionSummary();

        String fileName = sessionFile.getFileName().toString();
        summary.sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));
        summary.usage = new UsageData();
        summary.model = "gpt-5.1"; // Default fallback model

        long firstTimestamp = 0;
        String sessionTitle = null;
        String actualModel = null; // Will extract from turn_context

        try (BufferedReader reader = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;

                try {
                    CodexMessage msg = gson.fromJson(line, CodexMessage.class);
                    if (msg == null || msg.payload == null) continue;

                    // Extract timestamp
                    if (firstTimestamp == 0 && msg.timestamp != null) {
                        firstTimestamp = parseTimestamp(msg.timestamp);
                    }

                    // Extract model from turn_context
                    if (actualModel == null && "turn_context".equals(msg.type)) {
                        JsonObject payload = msg.payload;
                        if (payload.has("model") && !payload.get("model").isJsonNull()) {
                            actualModel = payload.get("model").getAsString();
                            LOG.debug("[CodexHistoryReader] Found model for session " + summary.sessionId + ": " + actualModel);
                        }
                    }

                    // Extract session title from first user message
                    if (sessionTitle == null && "event_msg".equals(msg.type)) {
                        JsonObject payload = msg.payload;
                        if (payload.has("type") && "user_message".equals(payload.get("type").getAsString())) {
                            if (payload.has("message")) {
                                String text = payload.get("message").getAsString();
                                if (text != null && !text.isEmpty()) {
                                    sessionTitle = text.replace("\n", " ").trim();
                                    if (sessionTitle.length() > 45) {
                                        sessionTitle = sessionTitle.substring(0, 45) + "...";
                                    }
                                }
                            }
                        }
                    }

                    // Extract usage data from event_msg/token_count (Codex native format)
                    if ("event_msg".equals(msg.type) && msg.payload.has("type") && "token_count".equals(msg.payload.get("type").getAsString())) {
                        // Check if info field exists and is not null
                        if (msg.payload.has("info") && !msg.payload.get("info").isJsonNull() && msg.payload.get("info").isJsonObject()) {
                            JsonObject info = msg.payload.getAsJsonObject("info");
                            if (info.has("total_token_usage") && info.get("total_token_usage").isJsonObject()) {
                                JsonObject totalUsage = info.getAsJsonObject("total_token_usage");

                                // Accumulate token usage from all token_count events
                                long inputTokens = totalUsage.has("input_tokens") ? totalUsage.get("input_tokens").getAsLong() : 0;
                                long outputTokens = totalUsage.has("output_tokens") ? totalUsage.get("output_tokens").getAsLong() : 0;
                                long cachedInputTokens = totalUsage.has("cached_input_tokens") ? totalUsage.get("cached_input_tokens").getAsLong() : 0;

                                // Use the latest usage data (Codex provides cumulative totals)
                                summary.usage.inputTokens = inputTokens;
                                summary.usage.outputTokens = outputTokens;
                                summary.usage.cacheReadTokens = cachedInputTokens;
                                summary.usage.cacheWriteTokens = 0; // Codex doesn't track cache writes separately

                                LOG.debug("[CodexHistoryReader] Found token_count for session " + summary.sessionId +
                                         " - input: " + inputTokens + ", output: " + outputTokens + ", cached: " + cachedInputTokens);
                            }
                        }
                    }
                } catch (Exception e) {
                    LOG.debug("[CodexHistoryReader] Failed to parse line: " + e.getMessage());
                }
            }
        }

        summary.timestamp = firstTimestamp > 0 ? firstTimestamp : System.currentTimeMillis();
        summary.summary = sessionTitle;
        summary.usage.totalTokens = summary.usage.inputTokens + summary.usage.outputTokens +
                                    summary.usage.cacheWriteTokens + summary.usage.cacheReadTokens;

        // Use the actual model if found, otherwise keep default
        if (actualModel != null && !actualModel.isEmpty()) {
            summary.model = actualModel;
        }

        // Calculate cost using model-specific pricing
        // Input: $3/1M tokens, Output: $15/1M tokens, Cache read: $0.30/1M
        summary.cost = calculateCost(summary.usage, summary.model);

        // Only return session if it has valid data (at least a title or some usage)
        if (sessionTitle == null && summary.usage.totalTokens == 0) {
            LOG.debug("[CodexHistoryReader] Skipping session with no valid data: " + summary.sessionId);
            return null;
        }

        return summary;
    }

    /**
     * Calculate cost based on usage and model.
     */
    private double calculateCost(UsageData usage, String model) {
        // GPT-5.1 pricing (estimated, based on typical OpenAI pricing)
        double inputCostPer1M = 3.0;
        double outputCostPer1M = 15.0;
        double cacheReadCostPer1M = 0.30;

        double inputCost = (usage.inputTokens / 1_000_000.0) * inputCostPer1M;
        double outputCost = (usage.outputTokens / 1_000_000.0) * outputCostPer1M;
        double cacheReadCost = (usage.cacheReadTokens / 1_000_000.0) * cacheReadCostPer1M;

        // Note: Codex doesn't track cache writes separately, so cacheWriteTokens is always 0
        return inputCost + outputCost + cacheReadCost;
    }

    /**
     * Process sessions and aggregate statistics.
     */
    private void processSessions(List<SessionSummary> sessions, ProjectStatistics stats) {
        // Calculate total usage and cost
        for (SessionSummary session : sessions) {
            stats.totalUsage.inputTokens += session.usage.inputTokens;
            stats.totalUsage.outputTokens += session.usage.outputTokens;
            stats.totalUsage.cacheWriteTokens += session.usage.cacheWriteTokens;
            stats.totalUsage.cacheReadTokens += session.usage.cacheReadTokens;
            stats.totalUsage.totalTokens += session.usage.totalTokens;
            stats.estimatedCost += session.cost;
        }

        stats.sessions = sessions;

        // Build daily usage map
        Map<String, DailyUsage> dailyMap = new HashMap<>();
        for (SessionSummary session : sessions) {
            String date = new java.text.SimpleDateFormat("yyyy-MM-dd").format(new Date(session.timestamp));

            DailyUsage daily = dailyMap.computeIfAbsent(date, k -> {
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
            daily.usage.cacheWriteTokens += session.usage.cacheWriteTokens;
            daily.usage.cacheReadTokens += session.usage.cacheReadTokens;
            daily.usage.totalTokens += session.usage.totalTokens;

            if (!daily.modelsUsed.contains(session.model)) {
                daily.modelsUsed.add(session.model);
            }
        }

        stats.dailyUsage = new ArrayList<>(dailyMap.values());
        stats.dailyUsage.sort((a, b) -> a.date.compareTo(b.date));

        // Build model usage map
        Map<String, ModelUsage> modelMap = new HashMap<>();
        for (SessionSummary session : sessions) {
            ModelUsage modelUsage = modelMap.computeIfAbsent(session.model, k -> {
                ModelUsage m = new ModelUsage();
                m.model = k;
                return m;
            });

            modelUsage.sessionCount++;
            modelUsage.totalCost += session.cost;
            modelUsage.totalTokens += session.usage.totalTokens;
            modelUsage.inputTokens += session.usage.inputTokens;
            modelUsage.outputTokens += session.usage.outputTokens;
            modelUsage.cacheCreationTokens += session.usage.cacheWriteTokens;
            modelUsage.cacheReadTokens += session.usage.cacheReadTokens;
        }

        stats.byModel = new ArrayList<>(modelMap.values());
        stats.byModel.sort((a, b) -> Double.compare(b.totalCost, a.totalCost));

        // Calculate weekly comparison
        long now = System.currentTimeMillis();
        long oneWeekAgo = now - 7L * 24 * 60 * 60 * 1000;
        long twoWeeksAgo = now - 14L * 24 * 60 * 60 * 1000;

        for (SessionSummary session : sessions) {
            if (session.timestamp >= oneWeekAgo) {
                stats.weeklyComparison.currentWeek.sessions++;
                stats.weeklyComparison.currentWeek.cost += session.cost;
                stats.weeklyComparison.currentWeek.tokens += session.usage.totalTokens;
            } else if (session.timestamp >= twoWeeksAgo) {
                stats.weeklyComparison.lastWeek.sessions++;
                stats.weeklyComparison.lastWeek.cost += session.cost;
                stats.weeklyComparison.lastWeek.tokens += session.usage.totalTokens;
            }
        }

        // Calculate trends
        if (stats.weeklyComparison.lastWeek.sessions > 0) {
            stats.weeklyComparison.trends.sessions =
                ((stats.weeklyComparison.currentWeek.sessions - stats.weeklyComparison.lastWeek.sessions) / (double) stats.weeklyComparison.lastWeek.sessions) * 100.0;
        }
        if (stats.weeklyComparison.lastWeek.cost > 0) {
            stats.weeklyComparison.trends.cost =
                ((stats.weeklyComparison.currentWeek.cost - stats.weeklyComparison.lastWeek.cost) / stats.weeklyComparison.lastWeek.cost) * 100.0;
        }
        if (stats.weeklyComparison.lastWeek.tokens > 0) {
            stats.weeklyComparison.trends.tokens =
                ((stats.weeklyComparison.currentWeek.tokens - stats.weeklyComparison.lastWeek.tokens) / (double) stats.weeklyComparison.lastWeek.tokens) * 100.0;
        }
    }
}
