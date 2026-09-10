import React from "react";
import { createPortal } from "react-dom";
import { copy } from "../../../lib/copy";
import { getAITooltipMessage } from "./ActivityHeatmap3D";

// 2D 精致 Hover Tooltip — portaled to body so the modal's
// `overflow-hidden` + `transform` ancestors can't clip it.
export function ActivityHeatmapTooltip({
  cell,
  tooltipPos,
  isDark,
  heatmapColors,
  formatTokens,
  formatTokensTooltip,
}) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed z-[9999] w-0 h-0 transition-all duration-100 ease-out pointer-events-none"
      style={{
        // Inline position: the Windows WebView2 shell injects
        // `body.tt-native-glass-shell>*{position:relative}` which outranks
        // the `fixed` class on body-portaled children (issue 252).
        position: "fixed",
        left: `${tooltipPos.x}px`,
        top: `${tooltipPos.y}px`,
      }}
    >
      {/* Tooltip 玻璃外框（悬浮定位，默认底边固定在单元格上方；顶部空间不足时翻转到下方） */}
      <div
        className={`absolute left-0 ${tooltipPos.flipY ? "top-[10px]" : "bottom-[10px]"} backdrop-blur-md bg-white/95 dark:bg-oai-gray-900/95 border border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-xl rounded-xl p-3.5 max-w-[280px] min-w-[200px] flex flex-col gap-2 animate-in fade-in zoom-in-95 duration-100`}
        style={{
          transform: `translateX(calc(-50% + ${tooltipPos.shiftX}px))`,
        }}
      >
        {/* 顶栏 */}
        <div className="flex items-center justify-between border-b border-oai-gray-100 dark:border-oai-gray-800/80 pb-1.5">
          <span className="text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">
            {cell.day}
          </span>
          {(() => {
            const badgeColor = cell.level === 0
              ? (isDark ? "#9ca3af" : "#6b7280")
              : heatmapColors[cell.level];
            return (
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                style={{
                  backgroundColor: badgeColor + "22",
                  color: badgeColor,
                  border: `1px solid ${badgeColor}44`
                }}
              >
                {copy("heatmap.tooltip.level", { level: cell.level })}
              </span>
            );
          })()}
        </div>

        {/* 内容 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-1">
            <span
              title={formatTokensTooltip(cell.total_tokens ?? cell.value)}
              className="text-lg font-bold text-oai-gray-900 dark:text-white leading-none"
            >
              {formatTokens(cell.total_tokens ?? cell.value)}
            </span>
            <span className="text-[10px] text-oai-gray-400 uppercase tracking-wider font-semibold">
              {copy("heatmap.unit.tokens")}
            </span>
          </div>

          {cell.models && Object.keys(cell.models).length > 0 ? (
            <div className="mt-1.5 border-t border-oai-gray-100 dark:border-oai-gray-800/60 pt-2 flex flex-col gap-1.5">
              <div className="text-[10px] font-semibold text-oai-gray-400 dark:text-oai-gray-500 uppercase tracking-wider">
                {copy("heatmap.tooltip.model_breakdown")}
              </div>
              <div className="flex flex-col gap-2 max-h-[150px] overflow-y-auto pr-1.5 oai-scrollbar">
                {Object.entries(cell.models)
                  .map(([name, val]) => ({ name, val: Number(val) }))
                  .sort((a, b) => b.val - a.val)
                  .map(({ name, val }) => {
                    const total = Number(cell.total_tokens ?? cell.value) || 1;
                    const pct = Math.round((val / total) * 100);
                    return (
                      <div key={name} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between text-[11px] gap-3">
                          <span className="font-medium text-oai-gray-700 dark:text-oai-gray-200 truncate max-w-[120px]" title={name}>
                            {name}
                          </span>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span
                              title={formatTokensTooltip(val)}
                              className="font-mono text-oai-gray-900 dark:text-oai-gray-100 font-semibold"
                            >
                              {formatTokens(val)}
                            </span>
                            <span className="text-[9px] text-oai-gray-500 dark:text-oai-gray-500 min-w-[28px] text-right font-medium">
                              {pct}%
                            </span>
                          </div>
                        </div>
                        <div className="w-full h-1 bg-oai-gray-100 dark:bg-oai-gray-800/85 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-300"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: heatmapColors[4],
                              boxShadow: `0 0 4px ${heatmapColors[4]}55`
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-oai-gray-600 dark:text-oai-gray-300 leading-relaxed font-normal mt-1 border-t border-dashed border-oai-gray-100 dark:border-oai-gray-800/60 pt-1.5">
              {getAITooltipMessage(cell.level, cell.total_tokens ?? cell.value, formatTokens)}
            </p>
          )}
        </div>
      </div>

      {/* 小尾巴（默认朝下指向单元格；翻转时朝上） */}
      <div
        className={`absolute left-0 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-white dark:bg-oai-gray-900 shadow-sm ${tooltipPos.flipY ? "top-[6px] border-l border-t" : "bottom-[6px] border-r border-b"} border-oai-gray-200/50 dark:border-oai-gray-800/50`}
        style={tooltipPos.flipY ? { marginTop: "1px" } : { marginBottom: "1px" }}
      />
    </div>,
    document.body,
  );
}
