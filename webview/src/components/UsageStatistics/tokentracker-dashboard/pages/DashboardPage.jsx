// Vendored from upstream src/pages/DashboardPage.jsx with account/cloud/auth,
// share, cost-analysis, install prompts, device filter, usage-limits and
// drag-order features removed (see vendor plan). What remains is the data
// assembly for the five kept cards (StatsPanel / ActivityHeatmap /
// TrendMonitor / UsageOverview / DataDetails) plus fixed-order rendering
// state (period, custom range, details sort + pagination).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { copy } from "../lib/copy";
import { useLocale } from "../hooks/useLocale.js";
import { useCurrency } from "../hooks/useCurrency.js";
import { useTokenFormat } from "../hooks/useTokenFormat.js";
import { buildDailyBreakdownRange } from "../lib/daily-breakdown";
import { buildFleetData, buildTopModels } from "../lib/model-breakdown";
import { getMockNow, isMockEnabled } from "../lib/mock-data";
import {
  formatTimeZoneLabel,
  formatTimeZoneShortLabel,
  getBrowserTimeZone,
  getBrowserTimeZoneOffsetMinutes,
  getLocalDayKey,
} from "../lib/timezone";
import { isTauriRuntime } from "../lib/tt-transport";
import { ActivityHeatmap } from "../ui/dashboard/components/ActivityHeatmap.jsx";
import { DashboardView } from "../ui/dashboard/views/DashboardView.jsx";
import { DETAILS_PAGED_PERIODS, PERIODS } from "./dashboardDataUtils.js";
import { useDashboardPeriod } from "./useDashboardPeriod.js";
import { useDashboardData } from "./useDashboardData.js";
import { useDashboardDetails } from "./useDashboardDetails.jsx";
import { useDashboardIdentity } from "./useDashboardIdentity.js";
import { useDashboardSync } from "./useDashboardSync.js";
import { useDashboardSummary } from "./useDashboardSummary.js";

export function DashboardPage({ baseUrl, onMainContentVisible }) {
  const { resolvedLocale } = useLocale();
  const { currency, rate } = useCurrency();
  const { mode: tokenFormatMode, setMode: setTokenFormatMode, formatTokens, formatTokensTooltip } = useTokenFormat();
  const mainContentVisibleNotifiedRef = useRef(false);
  const mockEnabled = isMockEnabled();

  // Vendored change: the desktop app renders the dashboard inside a Tauri
  // webview which is always served by the local CLI (via the tt_proxy
  // transport), so it counts as local mode even when location.hostname is
  // not literally "localhost" (e.g. http://tauri.localhost on Windows).
  const isLocalMode = isTauriRuntime() || (typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"));

  const timeZone = useMemo(() => getBrowserTimeZone(), []);
  const tzOffsetMinutes = useMemo(() => getBrowserTimeZoneOffsetMinutes(), []);
  const mockNow = useMemo(() => getMockNow(), []);
  const cacheKey = "default";
  const {
    period,
    from,
    to,
    customFrom,
    customTo,
    customRangeOpen,
    handlePeriodChange,
    handleCustomRangeApply,
    handleCustomRangeOpenChange,
  } = useDashboardPeriod({ timeZone, tzOffsetMinutes, mockNow });

  const timeZoneLabel = useMemo(
    () => formatTimeZoneLabel({ timeZone, offsetMinutes: tzOffsetMinutes }),
    [timeZone, tzOffsetMinutes],
  );
  const timeZoneShortLabel = useMemo(
    () => formatTimeZoneShortLabel({ timeZone, offsetMinutes: tzOffsetMinutes }),
    [timeZone, tzOffsetMinutes],
  );
  const trendTimeZoneLabel = timeZoneLabel;
  const todayKey = useMemo(
    () =>
      getLocalDayKey({
        timeZone,
        offsetMinutes: tzOffsetMinutes,
        date: mockNow || new Date(),
      }),
    [mockNow, timeZone, tzOffsetMinutes],
  );
  const dailyBreakdownRange = useMemo(() => {
    return buildDailyBreakdownRange({
      period,
      selectedFrom: from,
      selectedTo: to,
      todayKey,
    });
  }, [from, period, to, todayKey]);

  const {
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
  } = useDashboardData({
    baseUrl,
    period,
    from,
    to,
    cacheKey,
    timeZone,
    tzOffsetMinutes,
    mockNow,
    dailyBreakdownRange,
  });

  const [projectUsageLimit, setProjectUsageLimit] = useState(3);

  const {
    detailsDateKey,
    detailsColumns,
    dailyBreakdownDateKey,
    dailyBreakdownColumns,
    hasDetailsActual,
    pagedDetails,
    detailsPageCount,
    detailsPage,
    setDetailsPage,
    sortedDailyBreakdownRows,
    toggleSort,
    ariaSortFor,
    sortIconFor,
    dailyAriaSortFor,
    dailySortIconFor,
    renderDetailCell,
    renderDetailDate,
    renderDailyBreakdownDate,
  } = useDashboardDetails({
    period,
    trendRows,
    daily,
    dailyBreakdownDaily,
    todayKey,
    formatTokens,
    formatTokensTooltip,
  });

  const { activeDays, identityStartDate, identitySubscriptions } = useDashboardIdentity({
    baseUrl,
    isLocalMode,
    mockEnabled,
    heatmap,
    heatmapDaily,
  });

  const { usageLoadingState, manualSyncLoading, handleUsageRefresh } = useDashboardSync({
    isLocalMode,
    mockEnabled,
    refreshUsage,
    refreshHeatmap,
    refreshTrend,
    refreshModelBreakdown,
    refreshProjectUsage,
    refreshDailyBreakdown,
    usageLoading,
    dailyBreakdownLoading,
    heatmapLoading,
    trendLoading,
    modelBreakdownLoading,
    projectUsageLoading,
  });

  const {
    summaryLabel,
    hasSummary,
    summaryValue,
    displayTotalTokens,
    summaryCostValue,
    summaryConversationsValue,
    toggleSummaryFormat,
  } = useDashboardSummary({
    summary,
    formatTokens,
    tokenFormatMode,
    setTokenFormatMode,
    currency,
    rate,
  });

  const trendRowsForDisplay = useMemo(() => {
    if (useDailyTrend) return daily;
    if (period === "day") {
      return Array.isArray(trendRows) ? trendRows.filter((row) => row?.hour) : [];
    }
    return trendRows;
  }, [daily, period, trendRows, useDailyTrend]);
  const trendFromForDisplay = useDailyTrend ? from : trendFrom;
  const trendToForDisplay = useDailyTrend ? to : trendTo;

  const activityHeatmapBlock = (
    <ActivityHeatmap
      heatmap={heatmap}
      timeZoneLabel={timeZoneLabel}
      timeZoneShortLabel={timeZoneShortLabel}
    />
  );

  const periodsForDisplay = PERIODS;

  const fleetData = useMemo(
    () => buildFleetData(modelBreakdown, { copyFn: copy }),
    [modelBreakdown],
  );
  const topModels = useMemo(
    () => buildTopModels(modelBreakdown, { limit: 3, copyFn: copy }),
    [modelBreakdown],
  );

  const installSyncCmd = copy("dashboard.install.cmd.sync");

  const dailyEmptyTemplate = useMemo(
    () => copy("dashboard.daily.empty", { cmd: "{{cmd}}" }),
    [resolvedLocale],
  );
  const [dailyEmptyPrefix, dailyEmptySuffix] = useMemo(() => {
    const parts = dailyEmptyTemplate.split("{{cmd}}");
    if (parts.length === 1) return [dailyEmptyTemplate, ""];
    return [parts[0], parts.slice(1).join("{{cmd}}")];
  }, [dailyEmptyTemplate]);

  useEffect(() => {
    if (mainContentVisibleNotifiedRef.current) return;
    if (usageLoadingState) return;
    mainContentVisibleNotifiedRef.current = true;
    onMainContentVisible?.();
  }, [onMainContentVisible, usageLoadingState]);

  return (
    <DashboardView
      copy={copy}
      identityStartDate={identityStartDate}
      activeDays={activeDays}
      identitySubscriptions={identitySubscriptions}
      projectUsageEntries={projectUsageEntries}
      projectUsageLimit={projectUsageLimit}
      setProjectUsageLimit={setProjectUsageLimit}
      projectDetailQuery={{ from, to, timeZone, tzOffsetMinutes }}
      topModels={topModels}
      trendRowsForDisplay={trendRowsForDisplay}
      trendFromForDisplay={trendFromForDisplay}
      trendToForDisplay={trendToForDisplay}
      trendZoomConfig={trendZoomConfig}
      usageFrom={from}
      usageTo={to}
      period={period}
      trendTimeZoneLabel={trendTimeZoneLabel}
      activityHeatmapBlock={activityHeatmapBlock}
      periodsForDisplay={periodsForDisplay}
      setSelectedPeriod={handlePeriodChange}
      customFrom={customFrom}
      customTo={customTo}
      onCustomRangeApply={handleCustomRangeApply}
      customRangeOpen={customRangeOpen}
      onCustomRangeOpenChange={handleCustomRangeOpenChange}
      summaryLabel={summaryLabel}
      summaryValue={summaryValue}
      hasSummary={hasSummary}
      summaryLoading={usageLoading}
      providersLoading={modelBreakdownLoading}
      summaryFullValue={displayTotalTokens}
      onToggleSummaryFormat={toggleSummaryFormat}
      summaryCostValue={summaryCostValue}
      summaryConversationsValue={summaryConversationsValue}
      rollingUsage={rolling}
      refreshAll={handleUsageRefresh}
      usageLoadingState={usageLoadingState}
      announceUsageLoading={manualSyncLoading}
      fleetData={fleetData}
      hasDetailsActual={hasDetailsActual}
      dailyEmptyPrefix={dailyEmptyPrefix}
      installSyncCmd={installSyncCmd}
      dailyEmptySuffix={dailyEmptySuffix}
      detailsColumns={detailsColumns}
      ariaSortFor={ariaSortFor}
      toggleSort={toggleSort}
      sortIconFor={sortIconFor}
      pagedDetails={pagedDetails}
      dailyBreakdownRows={sortedDailyBreakdownRows}
      dailyBreakdownColumns={dailyBreakdownColumns}
      dailyBreakdownAriaSortFor={dailyAriaSortFor}
      dailyBreakdownSortIconFor={dailySortIconFor}
      dailyBreakdownDateKey={dailyBreakdownDateKey}
      detailsDateKey={detailsDateKey}
      renderDetailDate={renderDetailDate}
      renderDailyBreakdownDate={renderDailyBreakdownDate}
      renderDetailCell={renderDetailCell}
      DETAILS_PAGED_PERIODS={DETAILS_PAGED_PERIODS}
      detailsPageCount={detailsPageCount}
      detailsPage={detailsPage}
      setDetailsPage={setDetailsPage}
    />
  );
}
