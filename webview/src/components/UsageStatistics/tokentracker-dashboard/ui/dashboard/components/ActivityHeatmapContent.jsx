import React from "react";
import { copy } from "../../../lib/copy";
import { ActivityHeatmap3DPreview } from "./ActivityHeatmap3DPreview";
import { ActivityHeatmapHeader } from "./ActivityHeatmapHeader";
import { ActivityHeatmapGrid } from "./ActivityHeatmapGrid";
import { ActivityHeatmapLegend } from "./ActivityHeatmapLegend";
import { ActivityHeatmapTooltip } from "./ActivityHeatmapTooltip";
import { ActivityHeatmapModal } from "./ActivityHeatmapModal";
import {
  CELL_SIZE,
  CELL_GAP,
  LABEL_WIDTH,
  HEATMAP_STYLE_CSS,
} from "./activityHeatmapScale";

function getCellMetrics(embedded) {
  return embedded
    ? { cellSize: 10, colGap: 2, labelWidth: 22 }
    : { cellSize: CELL_SIZE, colGap: CELL_GAP, labelWidth: LABEL_WIDTH };
}

// Pure presentational body of ActivityHeatmap: empty state, card chrome,
// header, 2D grid / 3D preview, legend, fullscreen 3D modal, hover tooltip.
export function ActivityHeatmapContent({
  embedded,
  hideLegend,
  view,
  onViewChange,
  timeZoneShortLabel,
  weeks,
  to,
  weekStartsOn,
  heatmapColors,
  isDark,
  mainContainerRef,
  scrollRef,
  onCellMouseEnter,
  onCellMouseLeave,
  onOpenModal,
  isModalOpen,
  isClosing,
  onCloseModal,
  onModalAnimationEnd,
  activePalette,
  onPaletteChange,
  modalAutoRotate,
  onAutoRotateChange,
  resetViewRef,
  stats,
  estimatedCostLabel,
  formatTokens,
  formatTokensTooltip,
  hoveredCell,
  tooltipPos,
}) {
  if (!weeks.length) {
    return (
      <div className="py-8 text-center text-sm text-oai-gray-500">
        {copy("heatmap.empty")}
      </div>
    );
  }

  const { cellSize, colGap, labelWidth } = getCellMetrics(embedded);

  return (
    <div
      ref={mainContainerRef}
      className={
        embedded
          ? "relative"
          : "relative rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5"
      }
    >
      {/* Header */}
      {!embedded && (
        <ActivityHeatmapHeader
          view={view}
          onViewChange={onViewChange}
          timeZoneShortLabel={timeZoneShortLabel}
        />
      )}

      {view === "3d" && (
        <ActivityHeatmap3DPreview
          weeks={weeks}
          isDark={isDark}
          palette={activePalette}
          onOpen={onOpenModal}
        />
      )}


      {/* Heatmap — scroll to latest (rightmost) on mount */}
      {view === "2d" && (
        <ActivityHeatmapGrid
          weeks={weeks}
          to={to}
          weekStartsOn={weekStartsOn}
          heatmapColors={heatmapColors}
          cellSize={cellSize}
          colGap={colGap}
          labelWidth={labelWidth}
          embedded={embedded}
          scrollRef={scrollRef}
          onCellMouseEnter={onCellMouseEnter}
          onCellMouseLeave={onCellMouseLeave}
        />
      )}

      {/* Legend */}
      {!hideLegend && <ActivityHeatmapLegend heatmapColors={heatmapColors} />}

      {/* 3D Interactive Fullscreen Modal */}
      {isModalOpen && (
        <ActivityHeatmapModal
          isClosing={isClosing}
          onClose={onCloseModal}
          onAnimationEnd={onModalAnimationEnd}
          weeks={weeks}
          isDark={isDark}
          activePalette={activePalette}
          onPaletteChange={onPaletteChange}
          modalAutoRotate={modalAutoRotate}
          onAutoRotateChange={onAutoRotateChange}
          resetViewRef={resetViewRef}
          stats={stats}
          estimatedCostLabel={estimatedCostLabel}
          formatTokens={formatTokens}
          formatTokensTooltip={formatTokensTooltip}
        />
      )}

      {/* 2D 精致 Hover Tooltip — portaled to body so the modal's
          `overflow-hidden` + `transform` ancestors can't clip it. */}
      {hoveredCell && !isModalOpen && (
        <ActivityHeatmapTooltip
          cell={hoveredCell}
          tooltipPos={tooltipPos}
          isDark={isDark}
          heatmapColors={heatmapColors}
          formatTokens={formatTokens}
          formatTokensTooltip={formatTokensTooltip}
        />
      )}

      <style>{HEATMAP_STYLE_CSS}</style>
    </div>
  );
}
