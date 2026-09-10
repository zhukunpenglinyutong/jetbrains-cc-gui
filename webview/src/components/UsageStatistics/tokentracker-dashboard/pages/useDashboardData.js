// Data sources for DashboardPage: usage summary/daily rows (selected range
// plus the daily-breakdown range), model breakdown, project usage, trend rows,
// and the activity heatmap, with their loading flags and refresh callbacks.
import { useMemo } from "react";
import { useActivityHeatmap } from "../hooks/use-activity-heatmap.js";
import { useProjectUsageSummary } from "../hooks/use-project-usage-summary";
import { useTrendData } from "../hooks/use-trend-data.js";
import { useUsageData } from "../hooks/use-usage-data.js";
import { useUsageModelBreakdown } from "../hooks/use-usage-model-breakdown.js";

export function useDashboardData({
  baseUrl,
  period,
  from,
  to,
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  mockNow,
  dailyBreakdownRange,
}) {
  const trendTimeZone = timeZone;
  const trendTzOffsetMinutes = tzOffsetMinutes;
  const {
    daily,
    summary,
    rolling,
    loading: usageLoading,
    refresh: refreshUsage,
  } = useUsageData({
    baseUrl,
    from,
    to,
    includeDaily: period !== "total",
    cacheKey,
    timeZone,
    tzOffsetMinutes,
    now: mockNow,
  });
  const {
    daily: dailyBreakdownDaily,
    loading: dailyBreakdownLoading,
    refresh: refreshDailyBreakdown,
  } = useUsageData({
    baseUrl,
    from: dailyBreakdownRange.from,
    to: dailyBreakdownRange.to,
    includeDaily: true,
    // This card only renders daily rows. Avoid a second account-summary scan
    // whose totals/rolling payload was fetched and then discarded.
    includeSummary: false,
    cacheKey: `${cacheKey}.daily-breakdown`,
    timeZone,
    tzOffsetMinutes,
    now: mockNow,
  });

  const {
    breakdown: modelBreakdown,
    loading: modelBreakdownLoading,
    refresh: refreshModelBreakdown,
  } = useUsageModelBreakdown({
    baseUrl,
    from,
    to,
    cacheKey,
    timeZone,
    tzOffsetMinutes,
  });

  const {
    entries: projectUsageEntries,
    loading: projectUsageLoading,
    refresh: refreshProjectUsage,
  } = useProjectUsageSummary({
    baseUrl,
    from,
    to,
    timeZone,
    tzOffsetMinutes,
  });

  const shareDailyToTrend = period === "week" || period === "month";
  const useDailyTrend = period === "week" || period === "month";
  const {
    rows: trendRows,
    from: trendFrom,
    to: trendTo,
    loading: trendLoading,
    refresh: refreshTrend,
  } = useTrendData({
    baseUrl,
    period,
    from,
    to,
    months: 24,
    cacheKey,
    timeZone: trendTimeZone,
    tzOffsetMinutes: trendTzOffsetMinutes,
    now: mockNow,
    sharedRows: shareDailyToTrend ? daily : null,
    sharedRange: shareDailyToTrend ? { from, to } : null,
  });

  // Stable useTrendData config handed to the zoom modal so it can hold its OWN
  // data instance for granularity drill-down (30min/Day/Month) without mutating
  // the dashboard's period/range state.
  const trendZoomConfig = useMemo(
    () => ({
      baseUrl,
      cacheKey,
      timeZone: trendTimeZone,
      tzOffsetMinutes: trendTzOffsetMinutes,
      now: mockNow,
    }),
    [
      baseUrl, cacheKey, trendTimeZone, trendTzOffsetMinutes, mockNow,
    ],
  );

  const {
    daily: heatmapDaily,
    heatmap,
    loading: heatmapLoading,
    refresh: refreshHeatmap,
  } = useActivityHeatmap({
    baseUrl,
    weeks: 52,
    cacheKey,
    timeZone,
    tzOffsetMinutes,
    now: mockNow,
  });

  return {
    daily,
    summary,
    rolling,
    usageLoading,
    refreshUsage,
    dailyBreakdownDaily,
    dailyBreakdownLoading,
    refreshDailyBreakdown,
    modelBreakdown,
    modelBreakdownLoading,
    refreshModelBreakdown,
    projectUsageEntries,
    projectUsageLoading,
    refreshProjectUsage,
    useDailyTrend,
    trendRows,
    trendFrom,
    trendTo,
    trendLoading,
    refreshTrend,
    trendZoomConfig,
    heatmapDaily,
    heatmap,
    heatmapLoading,
    refreshHeatmap,
  };
}
