import React, { useMemo } from "react";
import { buildMonthMarkers, getDayLabels, getMonthLabels } from "./activityHeatmapScale";

// 2D heatmap grid: month markers row, sticky day-labels column, and the
// week-by-week cells. Scrolls horizontally; starts scrolled to the latest
// (rightmost) week via the parent-owned scrollRef.
export function ActivityHeatmapGrid({
  weeks,
  to,
  weekStartsOn,
  heatmapColors,
  cellSize,
  colGap,
  labelWidth,
  embedded,
  scrollRef,
  onCellMouseEnter,
  onCellMouseLeave,
}) {
  const monthLabels = getMonthLabels();
  const dayLabels = getDayLabels(weekStartsOn);

  const monthMarkers = useMemo(
    () => buildMonthMarkers(weeks.length, to, weekStartsOn, monthLabels),
    [to, weeks.length, weekStartsOn, monthLabels]
  );

  const gridCols = labelWidth + weeks.length * cellSize + Math.max(0, weeks.length - 1) * colGap;
  const weekColTemplate = `${labelWidth}px repeat(${weeks.length}, ${cellSize}px)`;

  return (
    <div
      ref={scrollRef}
      className={`overflow-x-auto overflow-y-hidden heatmap-scroll-thin${embedded ? "" : " pb-1"}`}
    >
      <div style={{ minWidth: gridCols }}>
        {/* Month labels */}
        <div
          className="grid text-[10px] uppercase text-oai-gray-400 dark:text-oai-gray-400 mb-1"
          style={{
            gridTemplateColumns: weekColTemplate,
            columnGap: colGap,
          }}
        >
          <span />
          {monthMarkers.map((m) => (
            <span key={`${m.label}-${m.index}`} style={{ gridColumnStart: m.index + 2 }} className="whitespace-nowrap">
              {m.label}
            </span>
          ))}
        </div>

        {/* Grid */}
        <div
          className="grid"
          style={{
            gridTemplateColumns: weekColTemplate,
            columnGap: colGap,
          }}
        >
          {/* Day labels */}
          <div
            className="grid text-[10px] text-oai-gray-400 dark:text-oai-gray-400 sticky left-0 bg-white dark:bg-oai-gray-900 pr-2"
            style={{ gridTemplateRows: `repeat(7, ${cellSize}px)`, rowGap: colGap }}
          >
            {dayLabels.map((l) => (
              <span key={l} className="leading-none">
                {l}
              </span>
            ))}
          </div>

          {/* Cells */}
          <div
            className="grid"
            style={{
              gridAutoFlow: "column",
              gridTemplateRows: `repeat(7, ${cellSize}px)`,
              gap: colGap,
            }}
          >
            {weeks.map((week, wi) =>
              (Array.isArray(week) ? week : []).map((cell, di) => {
                if (!cell) return null;
                const key = cell.day || `e-${wi}-${di}`;
                const level = Number(cell.level) || 0;
                const color = heatmapColors[level] || heatmapColors[0];
                return (
                  <span
                    key={key}
                    onMouseEnter={(e) => onCellMouseEnter(e, cell)}
                    onMouseLeave={onCellMouseLeave}
                    className="rounded-[2px] transition-transform hover:scale-125 hover:z-10 cursor-pointer"
                    style={{ width: cellSize, height: cellSize, background: color }}
                  />
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
