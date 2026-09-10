import React from "react";
import { Maximize2 } from "lucide-react";
import { copy, getCopyLocale } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import {
  formatTrendRange,
  granularityFromPeriod,
} from "../../../lib/trend-stats";
import { TrendMonitorZoomModal } from "./TrendMonitorZoomModal";
import { TrendMonitorChart } from "./TrendMonitorChart";
import { TrendTooltip } from "./TrendTooltip";
import { useTrendTooltip } from "./useTrendTooltip";
import { getTrendMonitorScale, computeInterpolatedSeries, readRowValue } from "./trendSeries";

// Re-exported so existing importers of "./TrendMonitor.jsx" (unit tests,
// ProjectDetailModal) keep working unchanged after the extraction.
export { getTrendMonitorScale, computeInterpolatedSeries } from "./trendSeries";
export { getModelColor } from "./trendColors";

export function TrendMonitor({
  rows,
  from,
  to,
  period,
  timeZoneLabel,
  showTimeZoneLabel = true,
  className = "",
  // When `true`, the trend renders bare: no outer card chrome (rounded
  // border + bg + padding), no inner heading. Use this when the host
  // already provides a section wrapper (e.g. the leaderboard profile
  // modal). Default keeps the standalone dashboard appearance.
  embedded = false,
  // Tailwind height class for the bar row. The hardcoded h-40 is the small
  // dashboard card; the zoom modal passes a tall class (e.g. h-[60vh]) so the
  // bars actually grow thick and readable.
  chartHeightClass = "h-40",
  // When `true`, render zoom-only affordances: an X-axis time-tick row under
  // the bars and extra tooltip fields (precise time range, cost, conversations).
  // The small dashboard card leaves this false and is byte-for-byte unchanged.
  isZoom = false,
  // useTrendData config (baseUrl/accessToken/cacheKey/timeZone/...) passed
  // through so the zoom modal can hold its OWN data instance for granularity
  // drill-down without mutating the dashboard's state. Only used (and only
  // present) on the standalone card; null disables the maximize button.
  zoomConfig = null,
}) {
  const series = React.useMemo(
    () => (Array.isArray(rows) && rows.length ? rows : []),
    [rows],
  );
  const hasPredictions = React.useMemo(
    () => series.some((row) => row?.future),
    [series],
  );

  // rawValues: real observations (incl. 0) pass through; missing/future are null.
  // seriesValues: zero-padded view used for y-axis scaling so gaps don't skew the max.
  // interpolatedValues: per-index predicted height for missing/future gaps.
  const { rawValues, seriesValues, scale, interpolatedValues } = React.useMemo(() => {
    const raw = series.map(readRowValue);
    const padded = raw.map((v) => (v == null ? 0 : v));
    return {
      rawValues: raw,
      seriesValues: padded,
      scale: getTrendMonitorScale(padded),
      interpolatedValues: computeInterpolatedSeries(raw),
    };
  }, [series]);

  const granularity = granularityFromPeriod(period);
  const locale = getCopyLocale();
  const rangeLabels = React.useMemo(
    () => formatTrendRange(from, to, granularity, locale),
    [from, granularity, locale, to],
  );

  const [isZoomOpen, setIsZoomOpen] = React.useState(false);
  const { hoveredBar, tooltipPos, containerRef, handleBarMouseEnter, handleBarMouseLeave } =
    useTrendTooltip({ granularity, locale, isZoom });

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative",
        !embedded &&
          "rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5",
        isZoom && "flex h-full flex-col",
        className,
      )}
    >
      {!embedded && (
        <div className="mb-3 flex items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
              {copy("trend.monitor.label")}
            </h3>
            {showTimeZoneLabel && timeZoneLabel && (
              <p className="text-xs text-oai-gray-400 dark:text-oai-gray-400 mt-0.5">{timeZoneLabel}</p>
            )}
          </div>
          {zoomConfig && (
            <button
              type="button"
              onClick={() => setIsZoomOpen(true)}
              aria-label={copy("trend.zoom.open_aria")}
              title={copy("trend.zoom.open_aria")}
              className="shrink-0 p-1.5 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
            >
              <Maximize2 size={14} />
            </button>
          )}
        </div>
      )}
      <TrendMonitorChart
        series={series}
        seriesValues={seriesValues}
        scale={scale}
        interpolatedValues={interpolatedValues}
        chartHeightClass={chartHeightClass}
        isZoom={isZoom}
        granularity={granularity}
        locale={locale}
        rangeLabels={rangeLabels}
        hasPredictions={hasPredictions}
        onBarMouseEnter={handleBarMouseEnter}
        onBarMouseLeave={handleBarMouseLeave}
      />

      {/* 2D 精致 Hover Tooltip */}
      {hoveredBar && (
        <TrendTooltip hoveredBar={hoveredBar} tooltipPos={tooltipPos} isZoom={isZoom} />
      )}

      {isZoomOpen && zoomConfig && (
        <TrendMonitorZoomModal
          zoomConfig={zoomConfig}
          period={period}
          from={from}
          to={to}
          timeZoneLabel={timeZoneLabel}
          onClose={() => setIsZoomOpen(false)}
          renderChart={(chartProps) => (
            <TrendMonitor embedded isZoom chartHeightClass="h-full" {...chartProps} />
          )}
        />
      )}
    </div>
  );
}
