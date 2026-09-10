import React from "react";
import { copy } from "../../../lib/copy";

// Header row: title + 2D/3D view tablist + timezone label.
export function ActivityHeatmapHeader({ view, onViewChange, timeZoneShortLabel }) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <h3 className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
        {copy("heatmap.title")}
      </h3>
      <div className="flex items-center gap-2">
        {/* View Tablist */}
        <div
          role="tablist"
          aria-label="Heatmap view"
          className="flex rounded-md border border-oai-gray-200 dark:border-oai-gray-800 p-0.5 text-[10px]"
        >
          <button
            type="button"
            role="tab"
            aria-selected={view === "2d"}
            onClick={() => onViewChange("2d")}
            className={
              view === "2d"
                ? "px-2 py-0.5 rounded bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-oai-white font-medium"
                : "px-2 py-0.5 rounded text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200"
            }
          >
            {copy("heatmap.view.2d")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "3d"}
            onClick={() => onViewChange("3d")}
            className={
              view === "3d"
                ? "px-2 py-0.5 rounded bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-oai-white font-medium"
                : "px-2 py-0.5 rounded text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200"
            }
          >
            {copy("heatmap.view.3d")}
          </button>
        </div>



        <span className="text-xs text-oai-gray-400 dark:text-oai-gray-500">{timeZoneShortLabel || copy("heatmap.legend.utc")}</span>
      </div>
    </div>
  );
}
