import { useMemo } from "react";
import { useTheme } from "../../../hooks/useTheme.js";
import { useCurrency } from "../../../hooks/useCurrency.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { formatUsdCurrency } from "../../../lib/format";
import {
  HEATMAP_COLORS_LIGHT,
  HEATMAP_COLORS_DARK,
  normalizeHeatmap,
  computeHeatmapStats,
} from "./activityHeatmapScale";

// Derives everything the heatmap renders from the raw `heatmap` payload:
// theme palette, week alignment, normalized weeks, yearly token stats, and
// the currency-aware estimated cost label.
export function useActivityHeatmapData({ heatmap }) {
  const { resolvedTheme } = useTheme();
  const { currency, rate } = useCurrency();
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const isDark = resolvedTheme === "dark";
  const heatmapColors = isDark ? HEATMAP_COLORS_DARK : HEATMAP_COLORS_LIGHT;

  const weekStartsOn = heatmap?.week_starts_on === "mon" ? "mon" : "sun";

  const normalized = useMemo(
    () => normalizeHeatmap(heatmap, weekStartsOn),
    [heatmap?.to, heatmap?.weeks, weekStartsOn]
  );

  const weeks = normalized?.weeks || [];

  // 动态计算年度 Token 洞察统计数据
  const stats = useMemo(
    () => computeHeatmapStats(weeks, heatmap?.total_cost_usd),
    [weeks, heatmap?.total_cost_usd]
  );

  const estimatedCostLabel = useMemo(
    () => formatUsdCurrency(stats.totalCostUsd, { currency, rate }),
    [stats.totalCostUsd, currency, rate],
  );

  return {
    isDark,
    heatmapColors,
    weekStartsOn,
    normalized,
    weeks,
    stats,
    estimatedCostLabel,
    formatTokens,
    formatTokensTooltip,
  };
}
