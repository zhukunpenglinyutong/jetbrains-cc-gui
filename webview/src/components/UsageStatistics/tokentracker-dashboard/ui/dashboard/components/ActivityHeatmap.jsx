import React, { useRef } from "react";
import { ActivityHeatmapContent } from "./ActivityHeatmapContent";
import { useHeatmapTooltip } from "./useHeatmapTooltip";
import { useHeatmapModal } from "./useHeatmapModal";
import { useHeatmapView } from "./useHeatmapView";
import { useActivityHeatmapData } from "./useActivityHeatmapData";

export function ActivityHeatmap({
  heatmap,
  timeZoneLabel,
  timeZoneShortLabel,
  hideLegend = false,
  // When `true`, the heatmap renders bare: no outer card chrome (rounded
  // border + bg + padding), no inner title row (heading + 2D/3D toggle +
  // timezone label). Use this when the host already provides a section
  // wrapper (e.g. the leaderboard profile modal). Default keeps the
  // standalone dashboard appearance.
  embedded = false,
}) {
  const scrollRef = useRef(null);
  const mainContainerRef = useRef(null);

  const { view, setView } = useHeatmapView({
    embedded,
    scrollRef,
    weeks: heatmap?.weeks,
  });

  const { hoveredCell, tooltipPos, handleCellMouseEnter, handleCellMouseLeave } =
    useHeatmapTooltip(scrollRef);

  const {
    isModalOpen,
    isClosing,
    modalAutoRotate,
    setModalAutoRotate,
    resetViewRef,
    activePalette,
    setActivePalette,
    handleOpenModal,
    handleCloseModal,
    handleAnimationEnd,
  } = useHeatmapModal();

  const {
    isDark,
    heatmapColors,
    weekStartsOn,
    normalized,
    weeks,
    stats,
    estimatedCostLabel,
    formatTokens,
    formatTokensTooltip,
  } = useActivityHeatmapData({ heatmap });

  return (
    <ActivityHeatmapContent
      embedded={embedded}
      hideLegend={hideLegend}
      view={view}
      onViewChange={setView}
      timeZoneShortLabel={timeZoneShortLabel}
      weeks={weeks}
      to={normalized?.to}
      weekStartsOn={weekStartsOn}
      heatmapColors={heatmapColors}
      isDark={isDark}
      mainContainerRef={mainContainerRef}
      scrollRef={scrollRef}
      onCellMouseEnter={handleCellMouseEnter}
      onCellMouseLeave={handleCellMouseLeave}
      onOpenModal={handleOpenModal}
      isModalOpen={isModalOpen}
      isClosing={isClosing}
      onCloseModal={handleCloseModal}
      onModalAnimationEnd={handleAnimationEnd}
      activePalette={activePalette}
      onPaletteChange={setActivePalette}
      modalAutoRotate={modalAutoRotate}
      onAutoRotateChange={setModalAutoRotate}
      resetViewRef={resetViewRef}
      stats={stats}
      estimatedCostLabel={estimatedCostLabel}
      formatTokens={formatTokens}
      formatTokensTooltip={formatTokensTooltip}
      hoveredCell={hoveredCell}
      tooltipPos={tooltipPos}
    />
  );
}
