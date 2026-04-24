package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.util.PathUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Aggregates Claude session summaries into usage statistics for the settings UI.
 */
class ClaudeUsageAggregator {

    private static final String ALL_PROJECTS = "all";
    private static final String JSONL_SUFFIX = ".jsonl";
    private static final String UNKNOWN_MODEL = "unknown";
    private static final String DEFAULT_MODEL = "claude-sonnet-4-6";
    private static final double ONE_MILLION = 1_000_000.0;
    private static final long TIER_THRESHOLD = 200_000;

    private static final Pricing DEFAULT_PRICING = new Pricing(3.0, 15.0, 3.75, 0.30);
    private static final Pricing TIERED_SONNET_PRICING = new Pricing(3.0, 15.0, 3.75, 0.30, 6.0, 22.5, 7.5, 0.60);
    private static final Pricing LEGACY_OPUS_PRICING = new Pricing(15.0, 75.0, 18.75, 1.50);
    private static final Pricing OPUS_4_5_PRICING = new Pricing(5.0, 25.0, 6.25, 0.50);
    private static final Pricing HAIKU_4_5_PRICING = new Pricing(1.0, 5.0, 1.25, 0.10);

    private static final Map<String, Pricing> MODEL_PRICING = Map.ofEntries(
            Map.entry("claude-opus-4", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-1", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-20250514", LEGACY_OPUS_PRICING),
            Map.entry("claude-opus-4-5", OPUS_4_5_PRICING),
            Map.entry("claude-opus-4-6", OPUS_4_5_PRICING),
            Map.entry("claude-sonnet-4", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-20250514", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-5", TIERED_SONNET_PRICING),
            Map.entry("claude-sonnet-4-6", DEFAULT_PRICING),
            Map.entry("claude-haiku-4", HAIKU_4_5_PRICING),
            Map.entry("claude-haiku-4-5", HAIKU_4_5_PRICING)
    );
    private static final List<String> MODEL_PREFIXES = List.of(
            "claude-opus-4-20250514",
            "claude-opus-4-6",
            "claude-opus-4-5",
            "claude-opus-4-1",
            "claude-opus-4",
            "claude-sonnet-4-20250514",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-sonnet-4",
            "claude-haiku-4-5",
            "claude-haiku-4"
    );

    private static final DateTimeFormatter DATE_FORMATTER =
            DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneId.systemDefault());

    private final Path projectsDir;
    private final ClaudeHistoryParser parser;

    ClaudeUsageAggregator(Path projectsDir, ClaudeHistoryParser parser) {
        this.projectsDir = projectsDir;
        this.parser = parser;
    }

    ClaudeHistoryReader.ProjectStatistics getProjectStatistics(String projectPath, long cutoffTime) {
        ClaudeHistoryReader.ProjectStatistics stats = initEmptyStatistics(projectPath);

        try {
            List<ClaudeHistoryReader.SessionSummary> allSessions = readSessions(projectPath);
            List<ClaudeHistoryReader.SessionSummary> filteredSessions = cutoffTime > 0
                    ? allSessions.stream().filter(session -> session.timestamp >= cutoffTime).collect(Collectors.toList())
                    : allSessions;

            stats.totalSessions = filteredSessions.size();
            processSessions(filteredSessions, stats);
        } catch (Exception ignored) {
        }

        return stats;
    }

    private ClaudeHistoryReader.ProjectStatistics initEmptyStatistics(String projectPath) {
        ClaudeHistoryReader.ProjectStatistics stats = new ClaudeHistoryReader.ProjectStatistics();
        boolean allProjects = ALL_PROJECTS.equals(projectPath);
        stats.projectPath = projectPath;
        stats.projectName = allProjects ? "All Projects" : Paths.get(projectPath).getFileName().toString();
        stats.totalUsage = new ClaudeHistoryReader.UsageData();
        stats.sessions = new ArrayList<>();
        stats.dailyUsage = new ArrayList<>();
        stats.byModel = new ArrayList<>();
        stats.weeklyComparison = new ClaudeHistoryReader.WeeklyComparison();
        stats.weeklyComparison.currentWeek = new ClaudeHistoryReader.WeeklyComparison.WeekData();
        stats.weeklyComparison.lastWeek = new ClaudeHistoryReader.WeeklyComparison.WeekData();
        stats.weeklyComparison.trends = new ClaudeHistoryReader.WeeklyComparison.Trends();
        stats.lastUpdated = System.currentTimeMillis();
        return stats;
    }

    private List<ClaudeHistoryReader.SessionSummary> readSessions(String projectPath) throws IOException {
        if (ALL_PROJECTS.equals(projectPath)) {
            return readAllSessions();
        }

        Path projectDir = resolveProjectDir(projectPath);
        return projectDir == null ? List.of() : readSessionsFromDir(projectDir);
    }

    private List<ClaudeHistoryReader.SessionSummary> readAllSessions() throws IOException {
        if (!Files.exists(projectsDir)) {
            return List.of();
        }

        List<ClaudeHistoryReader.SessionSummary> sessions = new ArrayList<>();
        try (Stream<Path> paths = Files.list(projectsDir)) {
            for (Path dir : paths.filter(Files::isDirectory).collect(Collectors.toList())) {
                sessions.addAll(readSessionsFromDir(dir));
            }
        }
        return sessions;
    }

    private Path resolveProjectDir(String projectPath) {
        if (projectPath == null || projectPath.isBlank()) {
            return null;
        }

        List<Path> candidates = List.of(
                projectsDir.resolve(projectPath.replaceAll("[^a-zA-Z0-9]", "-")),
                projectsDir.resolve(PathUtils.sanitizePath(projectPath))
        );

        return candidates.stream().filter(Files::exists).findFirst().orElse(null);
    }

    private List<ClaudeHistoryReader.SessionSummary> readSessionsFromDir(Path projectDir) {
        List<ClaudeHistoryReader.SessionSummary> sessions = new ArrayList<>();

        try (Stream<Path> paths = Files.list(projectDir)) {
            for (Path file : paths
                    .filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(JSONL_SUFFIX))
                    .collect(Collectors.toList())) {
                ClaudeHistoryReader.SessionSummary session = parseSessionFile(file);
                if (session != null) {
                    sessions.add(session);
                }
            }
        } catch (IOException ignored) {
        }

        return sessions;
    }

    private ClaudeHistoryReader.SessionSummary parseSessionFile(Path filePath) {
        ClaudeHistoryReader.UsageData usage = new ClaudeHistoryReader.UsageData();
        double totalCost = 0;
        String model = UNKNOWN_MODEL;
        long firstTimestamp = 0;
        String summary = null;

        try (BufferedReader reader = Files.newBufferedReader(filePath, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }

                try {
                    JsonObject json = JsonParser.parseString(line).getAsJsonObject();

                    if (firstTimestamp == 0) {
                        firstTimestamp = parser.parseTimestamp(readString(json, "timestamp"));
                    }

                    if (summary == null && "summary".equals(readString(json, "type"))) {
                        summary = readString(json, "summary");
                    }

                    if (!"assistant".equals(readString(json, "type"))) {
                        continue;
                    }

                    JsonObject message = readObject(json, "message");
                    JsonObject usageJson = readObject(message, "usage");
                    ClaudeHistoryReader.UsageData delta = readUsage(usageJson);
                    if (delta.totalTokens == 0) {
                        continue;
                    }

                    if (UNKNOWN_MODEL.equals(model)) {
                        model = readString(message, "model", UNKNOWN_MODEL);
                    }

                    mergeUsage(usage, delta);
                    totalCost += calculateCost(delta, model);
                } catch (Exception ignored) {
                }
            }
        } catch (IOException e) {
            return null;
        }

        if (usage.totalTokens == 0) {
            return null;
        }

        ClaudeHistoryReader.SessionSummary session = new ClaudeHistoryReader.SessionSummary();
        session.sessionId = filePath.getFileName().toString().replace(JSONL_SUFFIX, "");
        session.timestamp = firstTimestamp > 0 ? firstTimestamp : System.currentTimeMillis();
        session.model = UNKNOWN_MODEL.equals(model) ? DEFAULT_MODEL : model;
        session.usage = usage;
        session.cost = totalCost;
        session.summary = summary;
        return session;
    }

    private ClaudeHistoryReader.UsageData readUsage(JsonObject usageJson) {
        ClaudeHistoryReader.UsageData usage = new ClaudeHistoryReader.UsageData();
        if (usageJson == null) {
            return usage;
        }

        usage.inputTokens = readLong(usageJson, "input_tokens");
        usage.outputTokens = readLong(usageJson, "output_tokens");
        usage.cacheWriteTokens = readLong(usageJson, "cache_creation_input_tokens");
        usage.cacheReadTokens = readLong(usageJson, "cache_read_input_tokens");
        usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
        return usage;
    }

    private double calculateCost(ClaudeHistoryReader.UsageData usage, String model) {
        Pricing pricing = resolvePricing(model);
        long requestTokens = usage.totalTokens;
        return bill(usage.inputTokens, pricing.inputRate(requestTokens))
                + bill(usage.outputTokens, pricing.outputRate(requestTokens))
                + bill(usage.cacheWriteTokens, pricing.cacheWriteRate(requestTokens))
                + bill(usage.cacheReadTokens, pricing.cacheReadRate(requestTokens));
    }

    private Pricing resolvePricing(String model) {
        return MODEL_PRICING.getOrDefault(normalizeModel(model), DEFAULT_PRICING);
    }

    private String normalizeModel(String model) {
        if (model == null || model.isBlank()) {
            return DEFAULT_MODEL;
        }

        String normalized = model.toLowerCase();
        int claudeIndex = normalized.indexOf("claude-");
        if (claudeIndex >= 0) {
            normalized = normalized.substring(claudeIndex);
        }

        return MODEL_PREFIXES.stream()
                .filter(normalized::startsWith)
                .findFirst()
                .orElse(normalized);
    }

    private double bill(long tokens, double ratePer1M) {
        return (tokens / ONE_MILLION) * ratePer1M;
    }

    private void processSessions(
            List<ClaudeHistoryReader.SessionSummary> sessions,
            ClaudeHistoryReader.ProjectStatistics stats
    ) {
        Map<String, ClaudeHistoryReader.DailyUsage> dailyMap = new HashMap<>();
        Map<String, ClaudeHistoryReader.ModelUsage> modelMap = new HashMap<>();

        long now = System.currentTimeMillis();
        long oneWeekAgo = now - 7L * 24 * 3600 * 1000;
        long twoWeeksAgo = now - 14L * 24 * 3600 * 1000;

        for (ClaudeHistoryReader.SessionSummary session : sessions) {
            mergeUsage(stats.totalUsage, session.usage);
            stats.estimatedCost += session.cost;

            ClaudeHistoryReader.DailyUsage daily = dailyMap.computeIfAbsent(
                    DATE_FORMATTER.format(Instant.ofEpochMilli(session.timestamp)),
                    this::createDailyUsage
            );
            daily.sessions++;
            daily.cost += session.cost;
            mergeUsage(daily.usage, session.usage);
            if (!daily.modelsUsed.contains(session.model)) {
                daily.modelsUsed.add(session.model);
            }

            ClaudeHistoryReader.ModelUsage modelUsage = modelMap.computeIfAbsent(session.model, this::createModelUsage);
            modelUsage.sessionCount++;
            modelUsage.totalCost += session.cost;
            modelUsage.totalTokens += session.usage.totalTokens;
            modelUsage.inputTokens += session.usage.inputTokens;
            modelUsage.outputTokens += session.usage.outputTokens;
            modelUsage.cacheCreationTokens += session.usage.cacheWriteTokens;
            modelUsage.cacheReadTokens += session.usage.cacheReadTokens;

            ClaudeHistoryReader.WeeklyComparison.WeekData week = session.timestamp > oneWeekAgo
                    ? stats.weeklyComparison.currentWeek
                    : session.timestamp > twoWeeksAgo ? stats.weeklyComparison.lastWeek : null;
            if (week != null) {
                week.sessions++;
                week.cost += session.cost;
                week.tokens += session.usage.totalTokens;
            }
        }

        stats.dailyUsage = dailyMap.values().stream()
                .sorted((a, b) -> a.date.compareTo(b.date))
                .collect(Collectors.toList());
        stats.byModel = modelMap.values().stream()
                .sorted((a, b) -> Double.compare(b.totalCost, a.totalCost))
                .collect(Collectors.toList());
        stats.sessions = sessions.stream()
                .sorted((a, b) -> Long.compare(b.timestamp, a.timestamp))
                .limit(200)
                .collect(Collectors.toList());

        stats.weeklyComparison.trends.sessions = calculateTrend(
                stats.weeklyComparison.currentWeek.sessions,
                stats.weeklyComparison.lastWeek.sessions
        );
        stats.weeklyComparison.trends.cost = calculateTrend(
                stats.weeklyComparison.currentWeek.cost,
                stats.weeklyComparison.lastWeek.cost
        );
        stats.weeklyComparison.trends.tokens = calculateTrend(
                stats.weeklyComparison.currentWeek.tokens,
                stats.weeklyComparison.lastWeek.tokens
        );
    }

    private ClaudeHistoryReader.DailyUsage createDailyUsage(String date) {
        ClaudeHistoryReader.DailyUsage usage = new ClaudeHistoryReader.DailyUsage();
        usage.date = date;
        usage.usage = new ClaudeHistoryReader.UsageData();
        usage.modelsUsed = new ArrayList<>();
        return usage;
    }

    private ClaudeHistoryReader.ModelUsage createModelUsage(String model) {
        ClaudeHistoryReader.ModelUsage usage = new ClaudeHistoryReader.ModelUsage();
        usage.model = model;
        return usage;
    }

    private void mergeUsage(ClaudeHistoryReader.UsageData target, ClaudeHistoryReader.UsageData source) {
        target.inputTokens += source.inputTokens;
        target.outputTokens += source.outputTokens;
        target.cacheWriteTokens += source.cacheWriteTokens;
        target.cacheReadTokens += source.cacheReadTokens;
        target.totalTokens += source.totalTokens;
    }

    private double calculateTrend(double current, double last) {
        return last == 0 ? 0 : ((current - last) / last) * 100;
    }

    private JsonObject readObject(JsonObject json, String key) {
        return json != null && json.has(key) && json.get(key).isJsonObject() ? json.getAsJsonObject(key) : null;
    }

    private String readString(JsonObject json, String key) {
        return readString(json, key, null);
    }

    private String readString(JsonObject json, String key, String fallback) {
        return json != null && json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsString() : fallback;
    }

    private long readLong(JsonObject json, String key) {
        return json != null && json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsLong() : 0;
    }

    private record Pricing(
            double inputCostPer1M,
            double outputCostPer1M,
            double cacheWriteCostPer1M,
            double cacheReadCostPer1M,
            Double inputCostPer1MAbove200K,
            Double outputCostPer1MAbove200K,
            Double cacheWriteCostPer1MAbove200K,
            Double cacheReadCostPer1MAbove200K
    ) {
        private Pricing(double input, double output, double cacheWrite, double cacheRead) {
            this(
                    input,
                    output,
                    cacheWrite,
                    cacheRead,
                    null,
                    null,
                    null,
                    null
            );
        }

        private double inputRate(long requestTokens) {
            return rate(requestTokens, inputCostPer1M, inputCostPer1MAbove200K);
        }

        private double outputRate(long requestTokens) {
            return rate(requestTokens, outputCostPer1M, outputCostPer1MAbove200K);
        }

        private double cacheWriteRate(long requestTokens) {
            return rate(requestTokens, cacheWriteCostPer1M, cacheWriteCostPer1MAbove200K);
        }

        private double cacheReadRate(long requestTokens) {
            return rate(requestTokens, cacheReadCostPer1M, cacheReadCostPer1MAbove200K);
        }

        private double rate(long requestTokens, double baseRate, Double tierRate) {
            return requestTokens > TIER_THRESHOLD && tierRate != null ? tierRate : baseRate;
        }
    }
}
