package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Aggregates usage statistics from Claude session files.
 */
class ClaudeUsageAggregator {

    private static final Logger LOG = Logger.getInstance(ClaudeUsageAggregator.class);

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

    private final Path projectsDir;
    private final ClaudeHistoryParser parser;
    private final Gson gson = new Gson();

    ClaudeUsageAggregator(Path projectsDir, ClaudeHistoryParser parser) {
        this.projectsDir = projectsDir;
        this.parser = parser;
    }

    /**
     * Get project usage statistics.
     *
     * @param projectPath project path or "all" for all projects
     * @param cutoffTime  earliest timestamp (ms) to include; 0 means no cutoff (all time)
     */
    ClaudeHistoryReader.ProjectStatistics getProjectStatistics(String projectPath, long cutoffTime) {
        ClaudeHistoryReader.ProjectStatistics stats = new ClaudeHistoryReader.ProjectStatistics();
        stats.projectPath = projectPath;
        stats.projectName = projectPath.equals("all") ? "All Projects" : Paths.get(projectPath).getFileName().toString();
        stats.totalUsage = new ClaudeHistoryReader.UsageData();
        stats.sessions = new ArrayList<>();
        stats.dailyUsage = new ArrayList<>();
        stats.byModel = new ArrayList<>();
        stats.weeklyComparison = new ClaudeHistoryReader.WeeklyComparison();
        stats.lastUpdated = System.currentTimeMillis();

        try {
            List<ClaudeHistoryReader.SessionSummary> allSessions = new ArrayList<>();

            if ("all".equals(projectPath)) {
                if (Files.exists(projectsDir)) {
                    Files.list(projectsDir)
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
                Path dir1 = projectsDir.resolve(folderName1);

                String folderName2 = getProjectFolderName(projectPath);
                Path dir2 = projectsDir.resolve(folderName2);

                if (Files.exists(dir1)) {
                    allSessions.addAll(readSessionsFromDir(dir1));
                } else if (Files.exists(dir2)) {
                    allSessions.addAll(readSessionsFromDir(dir2));
                }
            }

            // Filter sessions by date range when cutoffTime is specified
            List<ClaudeHistoryReader.SessionSummary> filteredSessions = (cutoffTime > 0)
                    ? allSessions.stream()
                        .filter(s -> s.timestamp >= cutoffTime)
                        .collect(Collectors.toList())
                    : allSessions;

            stats.totalSessions = filteredSessions.size();
            processSessions(filteredSessions, stats);

            return stats;

        } catch (Exception e) {
            return stats;
        }
    }

    private String getProjectFolderName(String projectPath) {
        if (projectPath == null) { return ""; }
        return PathUtils.sanitizePath(projectPath);
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

    private List<ClaudeHistoryReader.SessionSummary> readSessionsFromDir(Path projectDir) {
        List<ClaudeHistoryReader.SessionSummary> sessions = new ArrayList<>();
        Set<String> processedHashes = new HashSet<>();

        try {
            Files.list(projectDir)
                    .filter(p -> p.toString().endsWith(".jsonl"))
                    .forEach(p -> {
                        ClaudeHistoryReader.SessionSummary session = parseSessionFile(p, processedHashes);
                        if (session != null) {
                            sessions.add(session);
                        }
                    });
        } catch (IOException e) {
            // Ignore read failures
        }
        return sessions;
    }

    @SuppressWarnings("unchecked")
    private ClaudeHistoryReader.SessionSummary parseSessionFile(Path filePath, Set<String> processedHashes) {
        try (BufferedReader reader = Files.newBufferedReader(filePath, java.nio.charset.StandardCharsets.UTF_8)) {
            ClaudeHistoryReader.UsageData usage = new ClaudeHistoryReader.UsageData();
            double totalCost = 0;
            String model = "unknown";
            long firstTimestamp = 0;
            String summary = null;

            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) { continue; }

                try {
                    ClaudeHistoryReader.ConversationMessage msg = gson.fromJson(line, ClaudeHistoryReader.ConversationMessage.class);

                    if (firstTimestamp == 0 && msg.timestamp != null) {
                        firstTimestamp = parser.parseTimestamp(msg.timestamp);
                    }

                    if ("summary".equals(msg.type) && msg.message != null && msg.message.content instanceof String) {
                        Map<String, Object> rawMap = gson.fromJson(line, Map.class);
                        if (rawMap.containsKey("summary")) {
                            Object s = rawMap.get("summary");
                            if (s instanceof String) { summary = (String) s; }
                        }
                    }

                    if ("assistant".equals(msg.type) && msg.message != null && msg.message.usage != null) {
                        ClaudeHistoryReader.ConversationMessage.Usage u = msg.message.usage;

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

            if (usage.totalTokens == 0) { return null; }

            ClaudeHistoryReader.SessionSummary session = new ClaudeHistoryReader.SessionSummary();
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

    private void processSessions(List<ClaudeHistoryReader.SessionSummary> sessions, ClaudeHistoryReader.ProjectStatistics stats) {
        Map<String, ClaudeHistoryReader.DailyUsage> dailyMap = new HashMap<>();
        Map<String, ClaudeHistoryReader.ModelUsage> modelMap = new HashMap<>();

        long now = System.currentTimeMillis();
        long oneWeekAgo = now - 7L * 24 * 3600 * 1000;
        long twoWeeksAgo = now - 14L * 24 * 3600 * 1000;

        ClaudeHistoryReader.WeeklyComparison.WeekData currentWeek = new ClaudeHistoryReader.WeeklyComparison.WeekData();
        ClaudeHistoryReader.WeeklyComparison.WeekData lastWeek = new ClaudeHistoryReader.WeeklyComparison.WeekData();

        for (ClaudeHistoryReader.SessionSummary session : sessions) {
            stats.totalUsage.inputTokens += session.usage.inputTokens;
            stats.totalUsage.outputTokens += session.usage.outputTokens;
            stats.totalUsage.cacheWriteTokens += session.usage.cacheWriteTokens;
            stats.totalUsage.cacheReadTokens += session.usage.cacheReadTokens;
            stats.totalUsage.totalTokens += session.usage.totalTokens;
            stats.estimatedCost += session.cost;

            String dateStr = String.format("%tF", new Date(session.timestamp));
            ClaudeHistoryReader.DailyUsage daily = dailyMap.computeIfAbsent(dateStr, k -> {
                ClaudeHistoryReader.DailyUsage d = new ClaudeHistoryReader.DailyUsage();
                d.date = k;
                d.usage = new ClaudeHistoryReader.UsageData();
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

            ClaudeHistoryReader.ModelUsage modelStat = modelMap.computeIfAbsent(session.model, k -> {
                ClaudeHistoryReader.ModelUsage m = new ClaudeHistoryReader.ModelUsage();
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
        stats.weeklyComparison.trends = new ClaudeHistoryReader.WeeklyComparison.Trends();
        stats.weeklyComparison.trends.sessions = calculateTrend(currentWeek.sessions, lastWeek.sessions);
        stats.weeklyComparison.trends.cost = calculateTrend(currentWeek.cost, lastWeek.cost);
        stats.weeklyComparison.trends.tokens = calculateTrend(currentWeek.tokens, lastWeek.tokens);
    }

    private double calculateTrend(double current, double last) {
        if (last == 0) { return 0; }
        return ((current - last) / last) * 100;
    }
}
