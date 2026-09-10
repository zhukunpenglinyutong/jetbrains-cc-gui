import React from "react";
import { copy } from "../../../lib/copy";

// Enlarged chart area: full-width loading placeholder until the first rows
// arrive, otherwise the chart rendered by the caller.
export function TrendMonitorZoomChart({
  loading,
  rows,
  from,
  to,
  period,
  timeZoneLabel,
  renderChart,
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {loading && (!rows || rows.length === 0) ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-oai-gray-400 dark:text-oai-gray-400">
            {copy("trend.zoom.loading")}
          </p>
        </div>
      ) : (
        renderChart({
          rows,
          from,
          to,
          period,
          timeZoneLabel,
        })
      )}
    </div>
  );
}
