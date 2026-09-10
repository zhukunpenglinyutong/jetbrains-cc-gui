import React from "react";
import { copy } from "../../../lib/copy";

// "Less → More" color-scale legend under the grid.
export function ActivityHeatmapLegend({ heatmapColors }) {
  return (
    <div className="flex items-center justify-center gap-2 mt-3">
      <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-400">{copy("heatmap.legend.less")}</span>
      <div className="flex gap-0.5">
        {heatmapColors.map((c, i) => (
          <span key={i} className="rounded-[1px]" style={{ width: 10, height: 10, background: c }} />
        ))}
      </div>
      <span className="text-[10px] text-oai-gray-400 dark:text-oai-gray-400">{copy("heatmap.legend.more")}</span>
    </div>
  );
}
