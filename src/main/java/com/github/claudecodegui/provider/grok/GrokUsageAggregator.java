package com.github.claudecodegui.provider.grok;

import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Paths;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Builds Claude/Codex-shaped Usage Statistics from Grok CLI session history
 * ({@code ~/.grok/sessions}) plus optional plugin ACP usage ledger.
 */
public final class GrokUsageAggregator {

    private static final Logger LOG = Logger.getInstance(GrokUsageAggregator.class);
    private static final String ALL_PROJECTS = "all";
    private static final DateTimeFormatter DATE_FORMATTER =
            DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneId.systemDefault());

    private final GrokHistoryReader historyReader;
    private final GrokUsageLedger ledger;

    public GrokUsageAggregator() {
        this(new GrokHistoryReader(), new GrokUsageLedger());
    }

    public GrokUsageAggregator(GrokHistoryReader historyReader, GrokUsageLedger ledger) {
        this.historyReader = historyReader;
        this.ledger = ledger != null ? ledger : new GrokUsageLedger();
    }

    public static final class UsageData {
        public long inputTokens;
        public long outputTokens;
        public long cacheWriteTokens;
        public long cacheReadTokens;
        public long totalTokens;
    }

    public static final class SessionSummary {
        public String sessionId;
        public long timestamp;
        public String model;
        public UsageData usage;
        public double cost;
        public String summary;
    }

    public static final class DailyUsage {
        public String date;
        public int sessions;
        public UsageData usage;
        public double cost;
        public List<String> modelsUsed;
    }

    public static final class ModelUsage {
        public String model;
        public double totalCost;
        public long totalTokens;
        public long inputTokens;
        public long outputTokens;
        public long cacheCreationTokens;
        public long cacheReadTokens;
        public int sessionCount;
    }

    public static final class WeeklyComparison {
        public WeekData currentWeek = new WeekData();
        public WeekData lastWeek = new WeekData();
        public Trends trends = new Trends();

        public static final class WeekData {
            public int sessions;
            public double cost;
            public long tokens;
        }

        public static final class Trends {
            public double sessions;
            public double cost;
            public double tokens;
        }
    }

    public static final class ProjectStatistics {
        public String projectPath;
        public String projectName;
        public int totalSessions;
        public UsageData totalUsage = new UsageData();
        public double estimatedCost;
        public List<SessionSummary> sessions = new ArrayList<>();
        public List<DailyUsage> dailyUsage = new ArrayList<>();
        public WeeklyComparison weeklyComparison = new WeeklyComparison();
        public List<ModelUsage> byModel = new ArrayList<>();
        public long lastUpdated;
        /** Always {@code grok} for this aggregator. */
        public String provider = "grok";
        /** {@code local-activity} — not a billing statement. */
        public String source = "local-activity";
        /** Honest user-facing note for empty / partial data. */
        public String activityNote;
        /** True when any session has non-zero tokens from the plugin ledger. */
        public boolean tokensFromLedger;
    }

    public ProjectStatistics getProjectStatistics(String projectPath, long cutoffTime) {
        ProjectStatistics stats = emptyStats(projectPath);
        try {
            List<GrokHistoryReader.SessionInfo> history =
                    ALL_PROJECTS.equals(projectPath) || projectPath == null || projectPath.isBlank()
                            ? historyReader.listAllSessions()
                            : historyReader.listSessionsForProject(projectPath);

            Map<String, GrokUsageLedger.SessionTotals> ledgerBySession = ledger.aggregateBySession();

            List<SessionSummary> summaries = new ArrayList<>();
            for (GrokHistoryReader.SessionInfo info : history) {
                if (info == null || info.sessionId == null) {
                    continue;
                }
                long ts = info.lastTimestamp > 0 ? info.lastTimestamp : info.firstTimestamp;
                if (cutoffTime > 0 && ts > 0 && ts < cutoffTime) {
                    continue;
                }
                SessionSummary s = new SessionSummary();
                s.sessionId = info.sessionId;
                s.timestamp = ts;
                s.model = "grok";
                s.summary = info.title;
                s.cost = 0;
                s.usage = new UsageData();

                GrokUsageLedger.SessionTotals lt = ledgerBySession.get(info.sessionId);
                if (lt != null) {
                    s.usage.inputTokens = lt.inputTokens;
                    s.usage.outputTokens = lt.outputTokens;
                    s.usage.totalTokens = lt.totalTokens > 0
                            ? lt.totalTokens
                            : (lt.inputTokens + lt.outputTokens);
                    if (s.usage.totalTokens > 0) {
                        stats.tokensFromLedger = true;
                    }
                    if ((s.model == null || "grok".equals(s.model)) && lt.model != null && !lt.model.isBlank()) {
                        s.model = lt.model;
                    }
                }
                summaries.add(s);
            }

            // Ledger-only sessions (plugin saw usage but history missing / different root)
            Set<String> seen = summaries.stream().map(s -> s.sessionId).collect(Collectors.toSet());
            for (Map.Entry<String, GrokUsageLedger.SessionTotals> e : ledgerBySession.entrySet()) {
                if (seen.contains(e.getKey())) {
                    continue;
                }
                GrokUsageLedger.SessionTotals lt = e.getValue();
                if (cutoffTime > 0 && lt.lastTimestamp > 0 && lt.lastTimestamp < cutoffTime) {
                    continue;
                }
                if (!ALL_PROJECTS.equals(projectPath) && projectPath != null && !projectPath.isBlank()) {
                    String cwd = lt.cwd != null ? GrokHistoryReader.normalizePath(lt.cwd) : "";
                    String project = GrokHistoryReader.normalizePath(projectPath);
                    if (!cwd.isEmpty() && !cwd.equals(project) && !cwd.startsWith(project + "/")) {
                        continue;
                    }
                }
                SessionSummary s = new SessionSummary();
                s.sessionId = e.getKey();
                s.timestamp = lt.lastTimestamp;
                s.model = lt.model != null && !lt.model.isBlank() ? lt.model : "grok";
                s.summary = s.sessionId;
                s.cost = 0;
                s.usage = new UsageData();
                s.usage.inputTokens = lt.inputTokens;
                s.usage.outputTokens = lt.outputTokens;
                s.usage.totalTokens = lt.totalTokens > 0 ? lt.totalTokens : (lt.inputTokens + lt.outputTokens);
                if (s.usage.totalTokens > 0) {
                    stats.tokensFromLedger = true;
                }
                summaries.add(s);
            }

            summaries.sort(Comparator.comparingLong((SessionSummary s) -> s.timestamp).reversed());
            stats.sessions = summaries;
            stats.totalSessions = summaries.size();
            processSessions(summaries, stats);
            stats.activityNote = buildActivityNote(stats);
            stats.lastUpdated = System.currentTimeMillis();
        } catch (Exception e) {
            LOG.error("[GrokUsageAggregator] failed: " + e.getMessage(), e);
            stats.activityNote = "Failed to read Grok session activity: " + e.getMessage();
        }
        return stats;
    }

    private static ProjectStatistics emptyStats(String projectPath) {
        ProjectStatistics stats = new ProjectStatistics();
        boolean all = ALL_PROJECTS.equals(projectPath) || projectPath == null || projectPath.isBlank();
        stats.projectPath = all ? "all" : projectPath;
        stats.projectName = all
                ? "All Projects"
                : Paths.get(projectPath).getFileName().toString();
        stats.activityNote = buildActivityNote(stats);
        stats.lastUpdated = System.currentTimeMillis();
        return stats;
    }

    private static String buildActivityNote(ProjectStatistics stats) {
        if (stats.totalSessions == 0) {
            return "No Grok sessions found under ~/.grok/sessions for this scope. "
                    + "Open a Grok chat in the plugin or CLI first. "
                    + "Token totals appear only for turns run through this plugin (ACP ledger).";
        }
        if (!stats.tokensFromLedger) {
            return "Showing local Grok session activity (counts and models). "
                    + "Token totals are empty until the plugin records ACP usage for new turns. "
                    + "This is not an xAI billing statement — use /usage or account console for credits.";
        }
        return "Token totals come from the plugin ACP usage ledger (turns through this IDE). "
                + "Estimated cost is not computed for Grok. "
                + "For account credits/limits use live billing when available.";
    }

    private void processSessions(List<SessionSummary> sessions, ProjectStatistics stats) {
        Map<String, DailyUsage> dailyMap = new HashMap<>();
        Map<String, ModelUsage> modelMap = new HashMap<>();
        long now = System.currentTimeMillis();
        long weekMs = 7L * 24 * 60 * 60 * 1000;
        long currentWeekStart = now - weekMs;
        long lastWeekStart = now - 2 * weekMs;

        for (SessionSummary s : sessions) {
            UsageData u = s.usage != null ? s.usage : new UsageData();
            stats.totalUsage.inputTokens += u.inputTokens;
            stats.totalUsage.outputTokens += u.outputTokens;
            stats.totalUsage.cacheWriteTokens += u.cacheWriteTokens;
            stats.totalUsage.cacheReadTokens += u.cacheReadTokens;
            stats.totalUsage.totalTokens += u.totalTokens > 0
                    ? u.totalTokens
                    : (u.inputTokens + u.outputTokens);

            String date = s.timestamp > 0
                    ? DATE_FORMATTER.format(Instant.ofEpochMilli(s.timestamp))
                    : DATE_FORMATTER.format(Instant.now());
            DailyUsage day = dailyMap.computeIfAbsent(date, d -> {
                DailyUsage du = new DailyUsage();
                du.date = d;
                du.usage = new UsageData();
                du.modelsUsed = new ArrayList<>();
                return du;
            });
            day.sessions++;
            day.usage.inputTokens += u.inputTokens;
            day.usage.outputTokens += u.outputTokens;
            day.usage.totalTokens += u.totalTokens > 0 ? u.totalTokens : (u.inputTokens + u.outputTokens);
            if (s.model != null && !day.modelsUsed.contains(s.model)) {
                day.modelsUsed.add(s.model);
            }

            String modelKey = s.model != null && !s.model.isBlank() ? s.model : "grok";
            ModelUsage mu = modelMap.computeIfAbsent(modelKey, m -> {
                ModelUsage x = new ModelUsage();
                x.model = m;
                return x;
            });
            mu.sessionCount++;
            mu.inputTokens += u.inputTokens;
            mu.outputTokens += u.outputTokens;
            mu.totalTokens += u.totalTokens > 0 ? u.totalTokens : (u.inputTokens + u.outputTokens);

            if (s.timestamp >= currentWeekStart) {
                stats.weeklyComparison.currentWeek.sessions++;
                stats.weeklyComparison.currentWeek.tokens +=
                        u.totalTokens > 0 ? u.totalTokens : (u.inputTokens + u.outputTokens);
            } else if (s.timestamp >= lastWeekStart) {
                stats.weeklyComparison.lastWeek.sessions++;
                stats.weeklyComparison.lastWeek.tokens +=
                        u.totalTokens > 0 ? u.totalTokens : (u.inputTokens + u.outputTokens);
            }
        }

        stats.dailyUsage = dailyMap.values().stream()
                .sorted(Comparator.comparing((DailyUsage d) -> d.date).reversed())
                .collect(Collectors.toList());
        stats.byModel = modelMap.values().stream()
                .sorted(Comparator.comparingLong((ModelUsage m) -> m.totalTokens).reversed()
                        .thenComparing(m -> m.sessionCount, Comparator.reverseOrder()))
                .collect(Collectors.toList());

        stats.weeklyComparison.trends.sessions = trendPct(
                stats.weeklyComparison.currentWeek.sessions,
                stats.weeklyComparison.lastWeek.sessions);
        stats.weeklyComparison.trends.tokens = trendPct(
                stats.weeklyComparison.currentWeek.tokens,
                stats.weeklyComparison.lastWeek.tokens);
        stats.weeklyComparison.trends.cost = 0;
        stats.estimatedCost = 0;
    }

    private static double trendPct(long current, long previous) {
        if (previous <= 0) {
            return current > 0 ? 100.0 : 0.0;
        }
        return Math.round(1000.0 * (current - previous) / (double) previous) / 10.0;
    }
}
