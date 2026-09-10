import React from "react";
import { copy } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import { formatTickLabel } from "../../../lib/trend-stats";
import { TrendBar } from "./TrendBar";

function getBarDisplayValue(row, index, interpolatedValues, scale) {
  const isGap = row?.missing || row?.future;
  // Real observations (incl. 0) use the y-clipped value so they
  // stay proportional to neighbours. Only true gaps fall back to
  // the predicted curve, clipped to the visible max.
  return isGap
    ? Math.min(interpolatedValues[index] ?? 0, scale.effectiveMax)
    : scale.clippedValues[index] ?? 0;
}

// Zoom-only X-axis time-tick row under the bars (~8 evenly spaced labels,
// first/last always shown, aligned to their bar positions).
function TrendTickRow({ series, seriesValues, granularity, locale }) {
  return (
    <div className="flex gap-0.5 select-none">
      {series.map((row, index) => {
        const last = seriesValues.length - 1;
        const step = Math.max(1, Math.ceil(seriesValues.length / 8));
        const isTick = index % step === 0 || index === last;
        const justify =
          index === 0 ? "justify-start" : index === last ? "justify-end" : "justify-center";
        return (
          <div key={index} className={cn("flex-1 min-w-0 flex", justify)}>
            {isTick && (
              <span className="text-[9px] text-oai-gray-400 dark:text-oai-gray-500 whitespace-nowrap font-mono">
                {formatTickLabel(row, granularity, locale)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function TrendMonitorChart({
  series,
  seriesValues,
  scale,
  interpolatedValues,
  chartHeightClass,
  isZoom,
  granularity,
  locale,
  rangeLabels,
  hasPredictions,
  onBarMouseEnter,
  onBarMouseLeave,
}) {
  return (
    <div className={cn("space-y-3", isZoom && "flex flex-1 flex-col min-h-0 !space-y-0 gap-3")}>
      <div className={cn("relative", isZoom && "flex-1 min-h-0")}>
        <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
          {[0, 25, 50, 75, 100].map((pct) => (
            <div
              key={pct}
              className="w-full border-t border-oai-gray-100 dark:border-oai-gray-800"
              style={{ top: `${100 - pct}%` }}
            />
          ))}
        </div>
        <div className={cn("flex items-end gap-0.5 relative z-0", chartHeightClass)}>
          {seriesValues.length > 0 ? (
            seriesValues.map((value, index) => {
              const row = series[index];
              const displayValue = getBarDisplayValue(row, index, interpolatedValues, scale);
              return (
                <TrendBar
                  key={index}
                  value={value}
                  displayValue={displayValue}
                  scale={scale}
                  index={index}
                  row={row}
                  totalBars={seriesValues.length}
                  onMouseEnter={onBarMouseEnter}
                  onMouseLeave={onBarMouseLeave}
                />
              );
            })
          ) : (
            <div className="flex-1 h-full flex items-center justify-center">
              <p className="text-sm text-oai-gray-400 dark:text-oai-gray-400">
                {copy("trend.monitor.empty")}
              </p>
            </div>
          )}
        </div>
      </div>

      {isZoom && seriesValues.length > 0 && (
        <TrendTickRow
          series={series}
          seriesValues={seriesValues}
          granularity={granularity}
          locale={locale}
        />
      )}

      {hasPredictions && (
        <div
          className="flex items-center justify-end gap-1.5 text-[10px] font-medium text-oai-gray-400 dark:text-oai-gray-500"
          data-trend-prediction-legend="true"
        >
          <span
            aria-hidden="true"
            className="h-2.5 w-3 rounded-[2px] bg-oai-gray-100 dark:bg-oai-gray-800 opacity-50"
          />
          <span>~ {copy("trend.monitor.predicted")}</span>
        </div>
      )}

      {rangeLabels && (
        <div className="flex justify-between text-xs text-oai-gray-500 dark:text-oai-gray-300 font-medium pt-2 border-t border-oai-gray-100 dark:border-oai-gray-800">
          <span>{rangeLabels.start}</span>
          <span>{rangeLabels.end}</span>
        </div>
      )}
    </div>
  );
}
