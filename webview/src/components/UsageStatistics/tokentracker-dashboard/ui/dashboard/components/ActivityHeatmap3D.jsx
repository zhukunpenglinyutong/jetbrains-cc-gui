import React from "react";
import { copy } from "../../../lib/copy";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import {
  PALETTES,
  getAITooltipMessage,
  resolvePalette,
  rotatePoint,
  computeTooltipScreenPos,
} from "./activityHeatmap3dUtils";
import { useHeatmap3dView } from "./useHeatmap3dView";
import { useHeatmap3dScene } from "./useHeatmap3dScene";
import { Heatmap3dCell } from "./Heatmap3dCell";
import { Heatmap3dTooltip } from "./Heatmap3dTooltip";

// 保持既有导入路径稳定：外部仍从本文件引入 PALETTES 与 getAITooltipMessage
export { PALETTES, getAITooltipMessage };

export function ActivityHeatmap3D({
  weeks,
  palette = "auto",
  isDark = false,
  interactive = false,   // 是否为全屏交互 Modal 模式
  autoRotateInit = false, // 默认是否自动缓缓旋转
  onResetViewRef = null,  // 外部句柄，用来重置视角
}) {
  const { formatTokens, formatTokensTooltip } = useTokenFormat();
  const { colors, gridColor } = resolvePalette(palette, isDark);

  const {
    angle,
    zoom,
    growthWave,
    svgRef,
    containerRef,
    hoveredCell,
    tooltipPos,
    setHoveredCell,
    setTooltipPos,
    cancelHide,
    scheduleHide,
    handleMouseDown,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useHeatmap3dView({ interactive, autoRotateInit, onResetViewRef });

  const {
    UNIT_SIZE,
    floorGridLines,
    cells,
    levelToHeight,
    sortedCells,
    bounds,
    pad,
    width,
    viewBox,
  } = useHeatmap3dScene({ weeks, interactive, angle, zoom, colors, isDark, growthWave });

  if (cells.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-oai-gray-500">
        {copy("heatmap.empty")}
      </div>
    );
  }

  // Hover 到某个 Voxel：定位其顶面中心并放置浮动 Tooltip
  const handleCellEnter = (c) => {
    cancelHide();
    setHoveredCell(c);
    if (!interactive || !svgRef.current) return;
    // 取得 Voxel 顶面的中心在屏幕上的坐标
    const projPoint = rotatePoint(
      (c.col - weeks.length / 2) * UNIT_SIZE,
      (c.row - 3.5) * UNIT_SIZE,
      levelToHeight(c.level),
      angle.yaw,
      angle.pitch
    );
    setTooltipPos(computeTooltipScreenPos(svgRef.current, containerRef.current, projPoint, bounds, pad));
  };

  return (
    <div
      ref={containerRef}
      className={`relative select-none outline-none ${
        interactive
          ? "cursor-grab active:cursor-grabbing w-full h-full flex items-center justify-center"
          : "w-full overflow-hidden flex justify-center"
      }`}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <svg
        ref={svgRef}
        viewBox={viewBox}
        width={interactive ? "95%" : "100%"}
        height={interactive ? "95%" : "auto"}
        role="img"
        aria-label={copy("heatmap.iso.aria") || "3D interactive activity heatmap"}
        style={{
          display: "block",
          width: "100%",
          height: "auto",
          maxWidth: interactive ? "none" : `${width}px`,
          maxHeight: interactive ? "78vh" : "none"
        }}
        className="transition-transform duration-300 ease-out"
      >
        {/* Floor grid platform */}
        {interactive && floorGridLines.map((line) => (
          <path
            key={line.key}
            d={line.d}
            fill="none"
            stroke={gridColor}
            strokeWidth={0.25}
            strokeDasharray="1.5 2.5"
            strokeLinecap="round"
          />
        ))}

        {sortedCells.map((c) => (
          <Heatmap3dCell
            key={c.key}
            cell={c}
            interactive={interactive}
            isHovered={hoveredCell && hoveredCell.key === c.key}
            onMouseEnter={() => handleCellEnter(c)}
            onMouseLeave={scheduleHide}
            formatTokensTooltip={formatTokensTooltip}
          />
        ))}
      </svg>

      {/* 10. 交互模式下的 3D 浮动 Tooltip */}
      {interactive && hoveredCell && (
        <Heatmap3dTooltip
          hoveredCell={hoveredCell}
          tooltipPos={tooltipPos}
          colors={colors}
          isDark={isDark}
          formatTokens={formatTokens}
          formatTokensTooltip={formatTokensTooltip}
          onMouseEnter={cancelHide}
          onMouseLeave={scheduleHide}
        />
      )}
    </div>
  );
}

export default ActivityHeatmap3D;
