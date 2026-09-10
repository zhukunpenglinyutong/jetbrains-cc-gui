import React from "react";
import { Terminal } from "lucide-react";
import { copy } from "../../../lib/copy";
import { useCurrency } from "../../../hooks/useCurrency.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { formatTokenCount } from "../../../lib/token-format.js";
import { formatUsdCurrency } from "../../../lib/format";
import { getTrendInsightKey } from "../../../lib/trend-stats";
import { ACCENT, prettifyPeakLabel } from "./trendZoomUtils";

function StatCell({ label, value, sub, title }) {
  return (
    <div className="flex flex-col gap-1.5 group">
      <span className="text-[9px] font-bold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <span title={title} className="text-xl font-black font-mono text-zinc-900 dark:text-zinc-50 tracking-tight leading-none tabular-nums transition-transform duration-200 group-hover:-translate-y-[1px]">
        {value}
      </span>
      {sub ? (
        <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 font-mono tabular-nums">{sub}</span>
      ) : null}
    </div>
  );
}

// Left: aggregate stats — shares ActivityHeatmap's terminal-native panel language
export function TrendMonitorZoomStatsPanel({ stats, timeZoneLabel }) {
  const { currency, rate } = useCurrency();
  const { formatTokensTooltip } = useTokenFormat();
  // The left summary panel always uses compact figures (9.7B / 686.1M) — full
  // numbers break the narrow panel layout. Exact values stay on hover titles.
  const formatStatTokens = (v) => formatTokenCount(v);

  const costValue = stats.totalCostUsd != null
    ? formatUsdCurrency(stats.totalCostUsd, { currency, rate })
    : null;

  return (
    <div className="w-full md:w-[320px] shrink-0 border-b md:border-b-0 md:border-r border-zinc-200/50 dark:border-zinc-800/40 p-5 md:p-6 flex flex-col gap-6 overflow-y-auto backdrop-blur-md bg-zinc-50/50 dark:bg-zinc-950/50">
      <div>
        <div className="flex items-center gap-1.5 select-none">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: ACCENT }} />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: ACCENT }} />
          </span>
          <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
            {copy("trend.zoom.badge")}
          </span>
        </div>
        <h4 className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight leading-none mt-2 select-none">
          {copy("trend.monitor.label")}
        </h4>
        {timeZoneLabel ? (
          <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-1.5 font-mono select-none">{timeZoneLabel}</p>
        ) : null}
        <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500 mt-2 font-normal select-none">
          {copy("trend.zoom.desc")}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-x-5 gap-y-5 border-y border-zinc-200/50 dark:border-zinc-800/50 py-5 select-none">
        <StatCell
          label={copy("trend.zoom.stats.tokens")}
          value={formatStatTokens(stats.totalTokens)}
          title={formatTokensTooltip(stats.totalTokens)}
        />
        {costValue ? (
          <StatCell label={copy("trend.zoom.stats.cost")} value={costValue} />
        ) : null}
        <StatCell
          label={copy("trend.zoom.stats.conversations")}
          value={stats.conversationCount.toLocaleString()}
        />
        {stats.peak ? (
          <StatCell
            label={copy("trend.zoom.stats.peak")}
            value={formatStatTokens(stats.peak.value)}
            title={formatTokensTooltip(stats.peak.value)}
            sub={prettifyPeakLabel(stats.peak.label)}
          />
        ) : null}
      </div>

      <div className="flex flex-col gap-2 select-none">
        <div className="flex items-center gap-1.5">
          <Terminal size={11} style={{ color: ACCENT }} />
          <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono" style={{ color: ACCENT }}>
            {copy("trend.zoom.insight_badge")}
          </span>
        </div>
        <div className="pl-3.5 border-l-2 relative" style={{ borderColor: ACCENT }}>
          <div className="absolute inset-y-0 left-0 w-[3px] blur-[2px] opacity-15 pointer-events-none rounded-full" style={{ backgroundColor: ACCENT }} />
          <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400 font-normal">
            {copy(getTrendInsightKey(stats), {
              active: stats.activeBuckets,
              peak: formatStatTokens(stats.peak?.value || 0),
            })}
          </p>
        </div>
      </div>
    </div>
  );
}
