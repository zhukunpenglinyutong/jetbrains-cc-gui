import React from "react";
import { copy } from "../../../lib/copy";
import { getAITooltipMessage } from "./activityHeatmap3dUtils";

function LevelBadge({ level, colors, isDark }) {
  // 解决暗色模式下 Level 0 徽章使用极暗灰色导致文字完全不可见的问题
  const badgeColor = level === 0
    ? (isDark ? "#9ca3af" : "#6b7280")
    : colors[level];
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full font-medium"
      style={{
        backgroundColor: badgeColor + "22",
        color: badgeColor,
        border: `1px solid ${badgeColor}44`
      }}
    >
      {copy("heatmap.tooltip.level", { level })}
    </span>
  );
}

function ModelBreakdownRow({ name, val, total, accentColor, formatTokens, formatTokensTooltip }) {
  const pct = Math.round((val / total) * 100);
  return (
    <div className="flex flex-col gap-1">
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
      {/* Visual Progress Bar Accent */}
      <div className="w-full h-1 bg-oai-gray-100 dark:bg-oai-gray-800/85 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${pct}%`,
            backgroundColor: accentColor,
            boxShadow: `0 0 4px ${accentColor}55`
          }}
        />
      </div>
    </div>
  );
}

function ModelBreakdown({ models, total, accentColor, formatTokens, formatTokensTooltip }) {
  return (
    <div className="mt-1.5 border-t border-oai-gray-100 dark:border-oai-gray-800/60 pt-2 flex flex-col gap-1.5">
      <div className="text-[10px] font-semibold text-oai-gray-400 dark:text-oai-gray-500 uppercase tracking-wider">
        {copy("heatmap.tooltip.model_breakdown")}
      </div>
      <div className="flex flex-col gap-2 max-h-[150px] overflow-y-auto pr-1.5 scrollbar-thin">
        {Object.entries(models)
          .map(([name, val]) => ({ name, val: Number(val) }))
          .sort((a, b) => b.val - a.val)
          .map(({ name, val }) => (
            <ModelBreakdownRow
              key={name}
              name={name}
              val={val}
              total={total}
              accentColor={accentColor}
              formatTokens={formatTokens}
              formatTokensTooltip={formatTokensTooltip}
            />
          ))}
      </div>
    </div>
  );
}

// 交互模式下的 3D 浮动 Tooltip（解耦零尺寸锚点 + 零抖动边缘自适应避让）
export function Heatmap3dTooltip({
  hoveredCell,
  tooltipPos,
  colors,
  isDark,
  formatTokens,
  formatTokensTooltip,
  onMouseEnter,
  onMouseLeave,
}) {
  const hasModels = hoveredCell.models && Object.keys(hoveredCell.models).length > 0;

  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="absolute z-[9999] w-0 h-0 transition-all duration-100 ease-out"
      style={{
        left: `${tooltipPos.x}px`,
        top: `${tooltipPos.y}px`,
      }}
    >
      {/* Tooltip 玻璃外框（通过 absolute 定位挂载在锚点上方，内容向上自然生长，底边雷打不动） */}
      <div
        className="absolute left-0 bottom-[10px] backdrop-blur-md bg-white/90 dark:bg-oai-gray-900/90 border border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-xl rounded-xl p-3.5 max-w-[280px] min-w-[200px] flex flex-col gap-2 animate-in fade-in zoom-in-95 duration-100"
        style={{
          transform: `translateX(calc(-50% + ${tooltipPos.shiftX}px))`,
        }}
      >
        {/* 顶栏 */}
        <div className="flex items-center justify-between border-b border-oai-gray-100 dark:border-oai-gray-800/80 pb-1.5">
          <span className="text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">
            {hoveredCell.day}
          </span>
          <LevelBadge level={hoveredCell.level} colors={colors} isDark={isDark} />
        </div>

        {/* 内容 */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-1">
            <span
              title={formatTokensTooltip(hoveredCell.value)}
              className="text-lg font-bold text-oai-gray-900 dark:text-white leading-none"
            >
              {formatTokens(hoveredCell.value)}
            </span>
            <span className="text-[10px] text-oai-gray-400 uppercase tracking-wider font-semibold">
              {copy("heatmap.unit.tokens")}
            </span>
          </div>

          {hasModels ? (
            <ModelBreakdown
              models={hoveredCell.models}
              total={Number(hoveredCell.value) || 1}
              accentColor={colors[4]}
              formatTokens={formatTokens}
              formatTokensTooltip={formatTokensTooltip}
            />
          ) : (
            <p className="text-[11px] text-oai-gray-600 dark:text-oai-gray-300 leading-relaxed font-normal mt-1 border-t border-dashed border-oai-gray-100 dark:border-oai-gray-800/60 pt-1.5">
              {getAITooltipMessage(hoveredCell.level, hoveredCell.value, formatTokens)}
            </p>
          )}
        </div>
      </div>

      {/* 倒三角小尾巴（绝对定位且 z-index 偏下，上部分优雅重合遮挡，100% 精准指向 Voxel 中心） */}
      <div
        className="absolute bottom-[6px] left-0 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-white dark:bg-oai-gray-900 border-r border-b border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-sm"
        style={{ marginBottom: "1px" }}
      />
    </div>
  );
}
