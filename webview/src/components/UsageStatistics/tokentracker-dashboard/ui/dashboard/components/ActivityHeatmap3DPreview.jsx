import React from "react";
import { copy } from "../../../lib/copy";
import { ActivityHeatmap3D } from "./ActivityHeatmap3D";
import { Maximize2 } from "lucide-react";

// Clickable 3D preview shown on the dashboard; clicking opens the fullscreen
// interactive 3D modal.
export function ActivityHeatmap3DPreview({ weeks, isDark, palette, onOpen }) {
  return (
    <div
      onClick={onOpen}
      className="cursor-pointer group relative overflow-hidden rounded-lg hover:border-oai-gray-400 dark:hover:border-oai-gray-700 border border-transparent transition-all"
      title={copy("heatmap.3d.hover_tip")}
    >
      <ActivityHeatmap3D weeks={weeks} isDark={isDark} palette={palette} />
      {/* Hover 提示微光遮罩 */}
      <div className="absolute inset-0 bg-gradient-to-t from-oai-gray-900/5 to-transparent pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-2">
        <span className="text-[10px] bg-white/95 dark:bg-oai-gray-900/95 shadow border border-oai-gray-200/60 dark:border-oai-gray-800/80 px-2.5 py-1 rounded-full font-medium text-oai-gray-500 dark:text-oai-gray-400 flex items-center gap-1 transform translate-y-2 group-hover:translate-y-0 transition-transform duration-200">
          <Maximize2 size={9} />
          {copy("heatmap.3d.hover_tip")}
        </span>
      </div>
    </div>
  );
}
