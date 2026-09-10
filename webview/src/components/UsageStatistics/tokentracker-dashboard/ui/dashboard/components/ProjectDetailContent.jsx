import React from "react";
import { copy } from "../../../lib/copy";
import { toFiniteNumber } from "../../../lib/format";
import { formatProviderDisplayName } from "../../../lib/provider-display";
import { ProviderIcon } from "./ProviderIcon";
import { TrendMonitor, getModelColor } from "./TrendMonitor.jsx";
import { formatPercent } from "./projectDetailModalUtils.jsx";

// Same values as TrendMonitor's TOKEN_COLORS so token categories read as one
// system across the dashboard; cache write gets amber (not used there).
const COMPOSITION_SEGMENTS = [
  { key: "input_tokens", labelKey: "dashboard.projects.detail.comp_input", color: "#38bdf8" },
  { key: "cached_input_tokens", labelKey: "dashboard.projects.detail.comp_cached", color: "#14b8a6" },
  { key: "cache_creation_input_tokens", labelKey: "dashboard.projects.detail.comp_cache_write", color: "#f59e0b" },
  { key: "output_tokens", labelKey: "dashboard.projects.detail.comp_output", color: "#a78bfa" },
  { key: "reasoning_output_tokens", labelKey: "dashboard.projects.detail.comp_reasoning", color: "#fb7185" },
];

function SectionLabel({ children }) {
  return (
    <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500 select-none">
      {children}
    </span>
  );
}

function LoadingState() {
  return (
    <div className="space-y-4 p-5 md:p-6">
      <div className="h-32 rounded-lg bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse" />
      <div className="h-16 rounded-lg bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse" />
      <div className="h-24 rounded-lg bg-oai-gray-100 dark:bg-oai-gray-800 animate-pulse" />
    </div>
  );
}

// Daily trend — the real TrendMonitor chart (embedded), so the stacked
// per-source bars and hover breakdown tooltip behave exactly like the
// dashboard's Usage Trend card.
function DailyTrendSection({ daily }) {
  if (daily.length <= 1) return null;
  return (
    <section className="px-5 py-5 md:px-6 first:md:pt-6">
      <SectionLabel>{copy("dashboard.projects.detail.section_trend")}</SectionLabel>
      <div className="mt-3">
        <TrendMonitor
          embedded
          rows={daily}
          from={daily[0]?.day}
          to={daily[daily.length - 1]?.day}
          period="month"
          showTimeZoneLabel={false}
          chartHeightClass="h-36"
        />
      </div>
    </section>
  );
}

// Token composition.
function CompositionSection({ totals, formatTokens, formatTokensTooltip }) {
  const compositionTotal = COMPOSITION_SEGMENTS.reduce(
    (sum, seg) => sum + (toFiniteNumber(totals?.[seg.key]) ?? 0),
    0,
  );
  if (compositionTotal <= 0) return null;
  return (
    <section className="px-5 py-5 md:px-6 first:md:pt-6">
      <SectionLabel>
        {copy("dashboard.projects.detail.section_composition")}
      </SectionLabel>
      <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full">
        {COMPOSITION_SEGMENTS.map((seg) => {
          const value = toFiniteNumber(totals[seg.key]) ?? 0;
          if (value <= 0) return null;
          return (
            <div
              key={seg.key}
              style={{
                width: `${(value / compositionTotal) * 100}%`,
                backgroundColor: seg.color,
                minWidth: "2px",
              }}
            />
          );
        })}
      </div>
      {/* Single compact legend row — visually distinct from the
          taller BY SOURCE rows below so the two lists don't blur
          into one another. */}
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {COMPOSITION_SEGMENTS.map((seg) => {
          const value = toFiniteNumber(totals[seg.key]) ?? 0;
          return (
            <div key={seg.key} className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                style={{ backgroundColor: seg.color }}
              />
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {copy(seg.labelKey)}
              </span>
              <span
                className="text-[11px] font-bold font-mono text-zinc-900 dark:text-zinc-50 tabular-nums"
                title={formatTokensTooltip(value)}
              >
                {formatTokens(value)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SourceRow({ src, totalTokens, formatTokens, formatTokensTooltip }) {
  const value = Number(src.total_tokens || 0);
  const srcShare = totalTokens > 0 ? value / totalTokens : 0;
  const sharePct = srcShare * 100;
  const convCount = Number(src.conversation_count || 0);
  const color = getModelColor(src.source || "unknown");
  return (
    <div>
      <div className="flex items-center gap-1.5 min-w-0">
        <ProviderIcon
          provider={src.source}
          size={13}
          className="flex-shrink-0"
        />
        <span className="text-[11px] font-bold uppercase tracking-wide text-zinc-900 dark:text-zinc-50 truncate">
          {formatProviderDisplayName(src.source)}
        </span>
        <span className="hidden text-[10px] font-mono text-zinc-400 dark:text-zinc-500 tabular-nums whitespace-nowrap sm:inline">
          {copy("dashboard.projects.detail.source_days", {
            n: Number(src.days_active || 0),
          })}
          {/* Some providers attribute tokens per project but not
              conversations; 0 there means "unknown", not zero. */}
          {convCount > 0 ? (
            <>
              {" · "}
              {copy("dashboard.projects.detail.source_conv", { n: convCount })}
            </>
          ) : null}
        </span>
        <span
          className="ml-auto text-[12px] font-bold font-mono text-zinc-900 dark:text-zinc-50 tabular-nums"
          title={formatTokensTooltip(value)}
        >
          {formatTokens(value)}
        </span>
        <span className="w-9 text-right text-[10px] font-mono text-zinc-400 dark:text-zinc-500 tabular-nums">
          {formatPercent(srcShare)}
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800/60">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(100, Math.max(sharePct, value > 0 ? 1 : 0))}%`,
            minWidth: value > 0 ? "3px" : 0,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

// Source breakdown — BY DEVICE-style rows: name line + a full-width bar
// tinted with the provider's chart color, so each row ties back to its
// segments in the daily chart.
function SourcesSection({ sources, totalTokens, formatTokens, formatTokensTooltip }) {
  if (sources.length === 0) return null;
  return (
    <section className="px-5 py-5 md:px-6 first:md:pt-6">
      <SectionLabel>{copy("dashboard.projects.detail.section_sources")}</SectionLabel>
      <div className="mt-3 space-y-3.5">
        {sources.map((src) => (
          <SourceRow
            key={src.source}
            src={src}
            totalTokens={totalTokens}
            formatTokens={formatTokens}
            formatTokensTooltip={formatTokensTooltip}
          />
        ))}
      </div>
    </section>
  );
}

// Right: charts. Hairline-divided sections (same tone as the left/right
// panel seam) give the column real structure — the micro section labels
// alone were too weak to separate blocks.
export function ProjectDetailContent({
  loading,
  error,
  hasData,
  daily,
  totals,
  sources,
  totalTokens,
  formatTokens,
  formatTokensTooltip,
}) {
  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      {loading && <LoadingState />}

      {!loading && error && (
        <p className="oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300 p-5 md:p-6">
          {copy("dashboard.projects.detail.error")}
        </p>
      )}

      {!loading && !error && !hasData && (
        <p className="oai-text-body-sm text-oai-gray-500 dark:text-oai-gray-300 p-5 md:p-6">
          {copy("dashboard.projects.detail.empty_range")}
        </p>
      )}

      {hasData && (
        <div className="divide-y divide-zinc-200/50 dark:divide-zinc-800/40">
          <DailyTrendSection daily={daily} />
          <CompositionSection
            totals={totals}
            formatTokens={formatTokens}
            formatTokensTooltip={formatTokensTooltip}
          />
          <SourcesSection
            sources={sources}
            totalTokens={totalTokens}
            formatTokens={formatTokens}
            formatTokensTooltip={formatTokensTooltip}
          />
        </div>
      )}
    </div>
  );
}
