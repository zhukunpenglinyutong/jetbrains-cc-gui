// Refresh/sync orchestration for DashboardPage: initial local sync,
// auto-refresh subscription, manual refresh handler, and the aggregate
// loading flag.
import { useCallback, useEffect, useRef, useState } from "react";
import { triggerLocalSync } from "../lib/api";
import { startLocalUsageAutoRefresh } from "../lib/local-usage-auto-refresh";

export function useDashboardSync({
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
}) {
  const [manualSyncLoading, setManualSyncLoading] = useState(false);

  const refreshUsageStats = useCallback(async () => {
    await Promise.all([
      refreshUsage(),
      refreshHeatmap(),
      refreshTrend(),
      refreshModelBreakdown(),
      refreshProjectUsage(),
      refreshDailyBreakdown(),
    ]);
  }, [
    refreshDailyBreakdown,
    refreshHeatmap,
    refreshModelBreakdown,
    refreshProjectUsage,
    refreshTrend,
    refreshUsage,
  ]);

  const refreshAll = useCallback(async () => {
    await refreshUsageStats();
  }, [
    refreshUsageStats,
  ]);

  // The DMG starts its embedded server with --no-sync, so a page reload used
  // to fetch the same stale queue again. Refresh all local log/database sources
  // (Claude, Gemini, OpenCode, Codex, etc.) without doing cloud upload, Cursor
  // network access, or deep Codex archive work, then re-read local aggregates.
  // Keep the promise in a ref so React Strict Mode can reattach to the first
  // request instead of starting a duplicate sync. `didInitialSyncRef` gates the
  // attach logic to a single run — `refreshUsageStats` changes identity on
  // every range switch, and without the gate each change would re-subscribe to
  // the long-settled promise and fire one redundant refresh.
  const localReloadSyncPromiseRef = useRef(null);
  const didInitialSyncRef = useRef(false);
  useEffect(() => {
    if (!isLocalMode || mockEnabled) return undefined;
    if (didInitialSyncRef.current) return undefined;
    if (!localReloadSyncPromiseRef.current) {
      localReloadSyncPromiseRef.current = triggerLocalSync({
        auto: true,
        background: true,
        allLocalSources: true,
      });
    }
    let active = true;
    localReloadSyncPromiseRef.current
      .then(() => {
        didInitialSyncRef.current = true;
        if (active) return refreshUsageStats();
        return undefined;
      })
      .catch((error) => {
        didInitialSyncRef.current = true;
        if (active) console.warn("[DashboardPage] Reload sync failed:", error);
      });
    return () => {
      active = false;
    };
  }, [isLocalMode, mockEnabled, refreshUsageStats]);

  // Provider hooks update the queue quickly, while the native server also
  // performs a once-per-minute all-source fallback scan. Re-read the local
  // aggregates while this dashboard remains visible so those queue updates
  // appear without requiring a click or a page reload.
  useEffect(() => {
    if (!isLocalMode || mockEnabled) return undefined;
    const autoRefresh = startLocalUsageAutoRefresh({
      refresh: refreshUsageStats,
      onError: (error) =>
        console.warn("[DashboardPage] Automatic usage refresh failed:", error),
    });
    return () => autoRefresh.stop();
  }, [isLocalMode, mockEnabled, refreshUsageStats]);

  const handleUsageRefresh = useCallback(async () => {
    setManualSyncLoading(true);
    try {
      if (isLocalMode) {
        await triggerLocalSync();
      }
      await refreshAll();
    } catch (error) {
      console.error("[DashboardPage] Refresh failed:", error);
    } finally {
      setManualSyncLoading(false);
    }
  }, [isLocalMode, refreshAll]);

  const usageLoadingState =
    manualSyncLoading ||
    usageLoading ||
    dailyBreakdownLoading ||
    heatmapLoading ||
    trendLoading ||
    modelBreakdownLoading ||
    projectUsageLoading;

  return { usageLoadingState, manualSyncLoading, handleUsageRefresh };
}
