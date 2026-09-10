import React from "react";
import { copy } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import { useCurrency } from "../../../hooks/useCurrency.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { formatUsdCurrency } from "../../../lib/format";
import { TOKEN_COLORS, getModelColor } from "./trendColors";

// Zoom-only extra fields: precise cost and conversation count for the bucket.
function TrendTooltipZoomStats({ row, currency, rate }) {
  if (row?.total_cost_usd == null && !(Number(row?.conversation_count) > 0)) return null;
  return (
    <div className="flex items-center gap-3 text-[11px] text-oai-gray-500 dark:text-oai-gray-400">
      {row?.total_cost_usd != null && (
        <span>
          <span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">
            {formatUsdCurrency(row.total_cost_usd, { currency, rate })}
          </span>{" "}
          {copy("trend.zoom.tooltip.cost")}
        </span>
      )}
      {Number(row?.conversation_count) > 0 && (
        <span>
          <span className="font-semibold text-oai-gray-700 dark:text-oai-gray-200">
            {Number(row.conversation_count).toLocaleString()}
          </span>{" "}
          {copy("trend.zoom.tooltip.conversations")}
        </span>
      )}
    </div>
  );
}

// Per-model / per-token-type breakdown list with percentage bars.
function TrendTooltipBreakdown({ bar, formatTokens, formatTokensTooltip }) {
  return (
    <div className="mt-1.5 border-t border-oai-gray-100 dark:border-oai-gray-800/60 pt-2 flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold text-oai-gray-400 dark:text-oai-gray-500 uppercase tracking-wider">
        {bar.segments[0].type === "model"
          ? copy("heatmap.tooltip.model_breakdown")
          : copy("heatmap.tooltip.token_breakdown")}
      </div>
      <div className="flex flex-col gap-2 max-h-[150px] overflow-y-auto pr-1.5 oai-scrollbar">
        {bar.segments.map(({ name, value: val, type }) => {
          const total = bar.value || 1;
          const pct = Math.round((val / total) * 100);
          const color =
            type === "token_type" ? TOKEN_COLORS[name] : getModelColor(name);
          return (
            <div key={name} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] gap-3">
                <span
                  className="font-medium text-oai-gray-700 dark:text-oai-gray-200 truncate max-w-[130px]"
                  title={name}
                >
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
                    backgroundColor: color,
                    boxShadow: `0 0 4px ${color}55`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 2D 精致 Hover Tooltip — rendered only while a bar is hovered.
export function TrendTooltip({ hoveredBar, tooltipPos, isZoom }) {
  const { currency, rate } = useCurrency();
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const isGapKind = hoveredBar.kind === "predicted" || hoveredBar.kind === "unsynced";

  return (
    <div
      className="absolute z-[9999] w-0 h-0 transition-all duration-100 ease-out pointer-events-none"
      style={{
        left: `${tooltipPos.x}px`,
        top: `${tooltipPos.y}px`,
      }}
    >
      {/* Tooltip 玻璃外框（底边固定在柱子上方） */}
      <div
        className={cn(
          "absolute left-0 backdrop-blur-md bg-white/95 dark:bg-oai-gray-900/95 border border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-xl rounded-xl p-3.5 max-w-[280px] min-w-[220px] flex flex-col gap-2 animate-in fade-in zoom-in-95 duration-100",
          tooltipPos.flipDown ? "top-[10px]" : "bottom-[10px]",
        )}
        style={{
          transform: `translateX(calc(-50% + ${tooltipPos.shiftX}px))`,
        }}
      >
        {/* 顶栏 */}
        <div className="flex items-center justify-between border-b border-oai-gray-100 dark:border-oai-gray-800/80 pb-1.5">
          <span className="text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">
            {hoveredBar.timeLabel}
          </span>
          {hoveredBar.kind === "predicted" && (
            <span className="text-[9px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500">
              {copy("trend.monitor.predicted")}
            </span>
          )}
          {hoveredBar.kind === "unsynced" && (
            <span className="text-[9px] font-semibold uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500">
              {copy("trend.monitor.unsynced")}
            </span>
          )}
        </div>

        {/* 内容 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-1">
            <span
              title={formatTokensTooltip(isGapKind ? hoveredBar.displayValue : hoveredBar.value)}
              className="text-lg font-bold text-oai-gray-900 dark:text-white leading-none"
            >
              {isGapKind
                ? `~${formatTokens(Math.round(hoveredBar.displayValue ?? 0))}`
                : formatTokens(hoveredBar.value)}
            </span>
            <span className="text-[10px] text-oai-gray-400 uppercase tracking-wider font-semibold">
              {copy("heatmap.unit.tokens")}
            </span>
          </div>

          {isZoom && (
            <TrendTooltipZoomStats row={hoveredBar.row} currency={currency} rate={rate} />
          )}

          {hoveredBar.segments && hoveredBar.segments.length > 0 ? (
            <TrendTooltipBreakdown
              bar={hoveredBar}
              formatTokens={formatTokens}
              formatTokensTooltip={formatTokensTooltip}
            />
          ) : null}
        </div>
      </div>

      {/* 倒三角小尾巴 */}
      <div
        className={cn(
          "absolute left-0 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-white dark:bg-oai-gray-900 border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-sm",
          tooltipPos.flipDown ? "top-[6px] border-l border-t" : "bottom-[6px] border-r border-b",
        )}
        style={tooltipPos.flipDown ? { marginTop: "1px" } : { marginBottom: "1px" }}
      />
    </div>
  );
}
