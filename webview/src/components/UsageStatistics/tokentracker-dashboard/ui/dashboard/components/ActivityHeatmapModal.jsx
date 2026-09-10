import React from "react";
import { copy } from "../../../lib/copy";
import { ActivityHeatmap3D, PALETTES } from "./ActivityHeatmap3D";
import { PALETTE_ACCENTS } from "./activityHeatmapScale";
import { RotateCcw, X, Terminal, Info, Play, Pause } from "lucide-react";

// 3D Interactive Fullscreen Modal: yearly token stats, AI evaluation quote,
// palette legend, and the interactive 3D arena with HUD controls.
export function ActivityHeatmapModal({
  isClosing,
  onClose,
  onAnimationEnd,
  weeks,
  isDark,
  activePalette,
  onPaletteChange,
  modalAutoRotate,
  onAutoRotateChange,
  resetViewRef,
  stats,
  estimatedCostLabel,
  formatTokens,
  formatTokensTooltip,
}) {
  const activeAccent = PALETTE_ACCENTS[activePalette] || PALETTE_ACCENTS.emerald;
  const activeAccentColors = PALETTES[activePalette]
    ? (isDark ? PALETTES[activePalette].dark : PALETTES[activePalette].light)
    : (isDark ? PALETTES.emerald.dark : PALETTES.emerald.light);

  return (
    <div
      onAnimationEnd={onAnimationEnd}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={`fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 backdrop-blur-md bg-black/15 dark:bg-black/40 ${isClosing ? "animate-tt-fade-out" : "animate-tt-fade-in"}`}
    >
      {/* Modal Container */}
      <div className={`relative w-full max-w-6xl h-[88vh] backdrop-blur-2xl bg-white/90 dark:bg-oai-gray-900/90 border border-oai-gray-200/50 dark:border-white/10 shadow-2xl rounded-2xl flex flex-col md:flex-row overflow-hidden ${isClosing ? "animate-tt-modal-exit" : "animate-tt-modal"}`}>

        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 z-50 p-2 rounded-full border border-oai-gray-200/60 dark:border-oai-gray-800/60 bg-white/50 dark:bg-oai-gray-900/50 text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-900 dark:hover:text-white hover:rotate-90 hover:scale-105 active:scale-95 transition-all duration-300"
        >
          <X size={16} />
        </button>

        {/* Left Side: Stats and Controls */}
        <div className="w-full md:w-[340px] border-b md:border-b-0 md:border-r border-zinc-200/50 dark:border-zinc-800/40 p-5 md:p-6 flex flex-col gap-6 overflow-y-auto backdrop-blur-md bg-zinc-50/50 dark:bg-zinc-950/50">

          {/* Header Badge & Title */}
          <div>
            <div className="flex items-center gap-1.5 select-none">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: activeAccent.rawColor }} />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: activeAccent.rawColor }} />
              </span>
              <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
                {copy("heatmap.3d.modal.eyebrow")}
              </span>
            </div>
            <h4 className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight leading-none mt-2 select-none">
              {copy("heatmap.3d.modal.title")}
            </h4>
            <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500 mt-2 font-normal select-none">
              {copy("heatmap.3d.modal.desc")}
            </p>
          </div>

          {/* Core Metrics Borderless Grid (Gallery Design) */}
          <div className="grid grid-cols-2 gap-x-5 gap-y-5 border-y border-zinc-200/50 dark:border-zinc-800/50 py-5 select-none">

            {/* 1. Total Tokens */}
            <div className="flex flex-col gap-1 relative group cursor-help">
              {/* Detailed Interactive Tooltip */}
              <div className="absolute left-0 bottom-full mb-2 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 z-50">
                <div className="bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 text-[10px] font-semibold font-mono rounded-lg px-2.5 py-1.5 shadow-xl border border-zinc-200 dark:border-zinc-800/80 whitespace-nowrap flex flex-col">
                  <span className="text-[9px] text-zinc-400 dark:text-zinc-500">{copy("heatmap.3d.modal.stats.precision_total_tokens")}</span>
                  <span className="mt-0.5 font-bold text-zinc-900 dark:text-zinc-50">
                    {formatTokensTooltip(stats.totalTokens)} {copy("heatmap.unit.tokens")}
                  </span>
                </div>
              </div>

              <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                {copy("heatmap.3d.modal.stats.total_tokens")}
              </span>
              <div className="flex items-baseline gap-1.5">
                <span className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                  {formatTokens(stats.totalTokens, { decimals: 2 })}
                </span>

                {/* Compact Trend Line */}
                <div className="opacity-30 group-hover:opacity-60 transition-opacity">
                  <svg width="24" height="10" viewBox="0 0 24 10" fill="none">
                    <path d="M1 9C3 7 5 7 7 4C9 1 11 0 13 2C15 4 17 0 23 0" stroke={activeAccent.rawColor} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
            </div>

            {/* 2. Estimated Cost */}
            <div className="flex flex-col gap-1 group cursor-default">
              <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                {copy("heatmap.3d.modal.stats.estimated_cost")}
              </span>
              <span className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                {estimatedCostLabel}
              </span>
            </div>

            {/* 3. Active Rate / Active Days */}
            <div className="flex flex-col gap-1 group cursor-default">
              <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                {copy("heatmap.3d.modal.stats.active_rate_days")}
              </span>
              <span className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                {stats.activeRate}%{" "}
                <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 font-mono">
                  ({stats.activeDays}{copy("heatmap.3d.modal.stats.days_suffix")})
                </span>
              </span>
            </div>

            {/* 4. Active Streak */}
            <div className="flex flex-col gap-1 group cursor-default">
              <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                {copy("heatmap.3d.modal.stats.max_streak")}
              </span>
              <span className="text-xl font-black text-amber-500 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                {stats.maxStreak} <span className="text-[10px] font-bold text-amber-500/80 font-mono">{copy("heatmap.3d.modal.stats.days_suffix")}</span>
              </span>
            </div>

            {/* 5. Peak Day & Value */}
            <div className="flex flex-col gap-1 col-span-2 relative group cursor-help">
              {/* Detailed Tooltip */}
              <div className="absolute left-0 bottom-full mb-2 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-200 z-50">
                <div className="bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 text-[10px] font-semibold font-mono rounded-lg px-2.5 py-1.5 shadow-xl border border-zinc-200 dark:border-zinc-800/80 whitespace-nowrap flex flex-col">
                  <span className="text-[9px] text-zinc-400 dark:text-zinc-500">{copy("heatmap.3d.modal.stats.precision_peak_value")}</span>
                  <span className="mt-0.5 font-bold text-zinc-900 dark:text-zinc-50">
                    {stats.maxSingleDay.value > 0
                      ? `${formatTokensTooltip(stats.maxSingleDay.value)} ${copy("heatmap.unit.tokens")}`
                      : copy("heatmap.3d.modal.stats.no_data")}
                  </span>
                  <span className="text-[8px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                    {stats.maxSingleDay.day || copy("heatmap.3d.modal.stats.no_data")}
                  </span>
                </div>
              </div>

              <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                {copy("heatmap.3d.modal.stats.peak_day")}
              </span>
              <span className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight font-mono transition-transform duration-200 group-hover:-translate-y-[1px]">
                {stats.maxSingleDay.value > 0
                  ? formatTokens(stats.maxSingleDay.value, { decimals: 2 })
                  : copy("heatmap.3d.modal.stats.no_data")}{" "}
                <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 font-mono">
                  ({stats.maxSingleDay.day || copy("heatmap.3d.modal.stats.no_data")})
                </span>
              </span>
            </div>

          </div>

          {/* High-End Text Quote Analysis (Pure E-paper Blockquote Style) */}
          <div className="flex flex-col gap-2.5 py-1">
            <div className="flex items-center gap-1.5 select-none">
              <Terminal size={11} style={{ color: activeAccent.rawColor }} />
              <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono" style={{ color: activeAccent.rawColor }}>
                {copy(stats.aiEvaluationTitleKey)}
              </span>
            </div>

            <div
              className="pl-3.5 border-l-2 relative transition-all duration-300 group"
              style={{ borderColor: activeAccent.rawColor }}
            >
              {/* Subtle blur background reflection */}
              <div className="absolute inset-y-0 left-0 w-[3px] blur-[2px] opacity-15 pointer-events-none rounded-full" style={{ backgroundColor: activeAccent.rawColor }} />

              <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400 font-normal">
                {copy(stats.aiEvaluationKey)}
              </p>
            </div>
          </div>

          {/* Immersive Theme Accent Legend */}
          <div className="mt-auto border-t border-zinc-200/50 dark:border-zinc-800/50 pt-4 select-none">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[9px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest font-mono">
                  {copy("heatmap.3d.modal.legend.title")}
                </span>
                <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                  {copy(`heatmap.3d.modal.palette.${activePalette}`)}
                </span>
              </div>
              <div className="flex gap-1">
                {activeAccentColors.map((color, idx) => (
                  <div
                    key={idx}
                    className="flex-1 h-1 rounded-[2px]"
                    style={{ backgroundColor: color }}
                    title={copy("heatmap.tooltip.level", { level: idx })}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: 3D Visualization Arena */}
        <div className="flex-1 h-full relative flex items-center justify-center overflow-hidden p-4">

          {/* Decorative Ambient Radial Glow Spheres */}
          <div className="absolute top-1/4 left-1/3 w-96 h-96 rounded-full blur-[130px] pointer-events-none -translate-x-1/2 -translate-y-1/2 transition-all duration-500" style={{ backgroundColor: activeAccent.rawColor + "15" }} />
          <div className="absolute bottom-1/4 right-1/3 w-80 h-80 rounded-full blur-[120px] pointer-events-none translate-x-1/2 translate-y-1/2 bg-purple-500/[0.04] dark:bg-purple-500/[0.08]" />

          {/* Floating Interactive HUD Capsule */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-3 p-1.5 backdrop-blur-md bg-white/70 dark:bg-oai-gray-900/75 border border-oai-gray-200/60 dark:border-oai-gray-800/80 rounded-full shadow-lg z-30 select-none">
            {/* 1. Theme picker dots */}
            <div className="flex items-center gap-1.5 px-2">
              {Object.keys(PALETTE_ACCENTS).map((key) => {
                const isSelected = activePalette === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onPaletteChange(key)}
                    title={copy(`heatmap.3d.modal.palette.${key}`)}
                    className={`w-3.5 h-3.5 rounded-full transition-all duration-200 relative hover:scale-125 ${
                      key === "emerald" ? "bg-[#10b981]" : key === "ocean" ? "bg-[#3b82f6]" : key === "neon" ? "bg-[#a855f7]" : "bg-[#f59e0b]"
                    }`}
                  >
                    {isSelected && (
                      <span className="absolute inset-0 rounded-full ring-2 ring-offset-1 ring-offset-white dark:ring-offset-oai-gray-900 ring-oai-gray-900 dark:ring-white scale-110" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Vertical Divider */}
            <div className="w-[1px] h-4 bg-oai-gray-200 dark:bg-oai-gray-800" />

            {/* 2. Controls */}
            <div className="flex items-center gap-1 pr-1">
              {/* Auto Rotate Button */}
              <button
                type="button"
                onClick={() => {
                  const next = !modalAutoRotate;
                  onAutoRotateChange(next);
                  if (resetViewRef.current) resetViewRef.current.toggleAutoRotate(next);
                }}
                title={modalAutoRotate ? copy("heatmap.3d.modal.control.pause") : copy("heatmap.3d.modal.control.play")}
                className={`p-1.5 rounded-full transition-all duration-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 ${
                  modalAutoRotate ? activeAccent.accentText : "text-oai-gray-400 hover:text-oai-gray-600 dark:hover:text-oai-gray-250"
                }`}
              >
                {modalAutoRotate ? <Pause size={12} /> : <Play size={12} />}
              </button>

              {/* Reset View Button */}
              <button
                type="button"
                onClick={() => {
                  onAutoRotateChange(false);
                  if (resetViewRef.current) resetViewRef.current.reset();
                }}
                title={copy("heatmap.3d.modal.control.reset")}
                className="p-1.5 rounded-full text-oai-gray-400 hover:text-oai-gray-600 dark:hover:text-oai-gray-250 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-all duration-200"
              >
                <RotateCcw size={12} />
              </button>
            </div>
          </div>

          <ActivityHeatmap3D
            weeks={weeks}
            isDark={isDark}
            interactive={true}
            palette={activePalette}
            autoRotateInit={modalAutoRotate}
            onResetViewRef={resetViewRef}
          />

          {/* Corner tips */}
          <div className="absolute bottom-4 right-4 flex items-center gap-1.5 text-[9px] font-bold text-oai-gray-400 bg-white/80 dark:bg-oai-gray-900/80 border border-oai-gray-200/50 dark:border-oai-gray-800/80 rounded-md px-2.5 py-1.5 select-none pointer-events-none backdrop-blur-md shadow-sm">
            <Info size={10} className={activeAccent.accentText} />
            <span>{copy("heatmap.3d.modal.footer.tip")}</span>
          </div>
        </div>

      </div>
    </div>
  );
}
