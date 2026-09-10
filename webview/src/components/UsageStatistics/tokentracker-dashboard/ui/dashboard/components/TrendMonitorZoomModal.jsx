import React from "react";
import { X } from "lucide-react";
import { copy } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import { useTrendData } from "../../../hooks/use-trend-data";
import { getLocalDayKey } from "../../../lib/timezone";
import { computeZoomStats } from "../../../lib/trend-stats";
import { TrendMonitorZoomStatsPanel } from "./TrendMonitorZoomStatsPanel.jsx";
import { TrendMonitorZoomControls } from "./TrendMonitorZoomControls.jsx";
import { TrendMonitorZoomChart } from "./TrendMonitorZoomChart.jsx";
import { defaultRangeForPeriod, initialPeriod, monthsBetween } from "./trendZoomUtils";

export function TrendMonitorZoomModal({
  zoomConfig,
  period,
  from,
  to,
  timeZoneLabel,
  onClose,
  renderChart,
}) {
  // The 30-min view defaults to *today* (in the dashboard's timezone), not the
  // dashboard range end — opening it should land on the current day's activity.
  const todayKey = React.useMemo(
    () =>
      getLocalDayKey({
        timeZone: zoomConfig?.timeZone,
        offsetMinutes: zoomConfig?.tzOffsetMinutes,
        date: zoomConfig?.now || new Date(),
      }) || to || from || null,
    [zoomConfig?.timeZone, zoomConfig?.tzOffsetMinutes, zoomConfig?.now, to, from],
  );

  const [zoomPeriod, setZoomPeriod] = React.useState(() => initialPeriod(period));
  const [selectedDay, setSelectedDay] = React.useState(todayKey);
  // Selected from/to window for the Day and Month tiers (the 30-min tier uses
  // selectedDay instead).
  const [rangeSel, setRangeSel] = React.useState(() =>
    defaultRangeForPeriod(initialPeriod(period), todayKey),
  );
  const [isClosing, setIsClosing] = React.useState(false);

  // Newest day the 30-min view may navigate to.
  const maxDay = todayKey;

  // Switch tier; Day/Month reset to their default window so the range stays sane.
  const selectGranularity = (next) => {
    setZoomPeriod(next);
    if (next !== "day") setRangeSel(defaultRangeForPeriod(next, todayKey));
  };

  // Per-granularity request window for the independent data instance.
  const requestRange = React.useMemo(() => {
    if (zoomPeriod === "day") {
      return { from: selectedDay, to: selectedDay, months: undefined };
    }
    if (zoomPeriod === "total") {
      return { from: undefined, to: rangeSel.to, months: monthsBetween(rangeSel.from, rangeSel.to) };
    }
    return { from: rangeSel.from, to: rangeSel.to, months: undefined };
  }, [zoomPeriod, selectedDay, rangeSel]);

  const { rows, from: dataFrom, to: dataTo, loading } = useTrendData({
    ...zoomConfig,
    period: zoomPeriod,
    from: requestRange.from,
    to: requestRange.to,
    months: requestRange.months,
  });

  const stats = React.useMemo(() => computeZoomStats(rows), [rows]);

  const handleClose = React.useCallback(() => setIsClosing(true), []);

  const handleAnimationEnd = (e) => {
    if (e.target === e.currentTarget && isClosing) onClose();
  };

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  if (typeof document === "undefined") return null;

  // Render inline (NOT createPortal to document.body). The fixed-position
  // overlay still covers the viewport — no ancestor establishes a containing
  // block for `position: fixed` (verified: only overflow, no transform/filter).
  // In the Windows WebView2 host's transparent composition, overlays portaled
  // directly under <body> (outside #root) mount and composite in the renderer
  // but are NOT presented on-screen, so the modal looked like it "didn't open".
  // The 3D heatmap modal renders inline for the same reason and works. macOS
  // WKWebView / browsers are unaffected either way.
  return (
    <div
      onAnimationEnd={handleAnimationEnd}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center p-3 md:p-6 backdrop-blur-md bg-black/15 dark:bg-black/40",
        isClosing ? "animate-tt-fade-out" : "animate-tt-fade-in",
      )}
    >
      {/* Shared modal motion — identical to ActivityHeatmap's 3D Insight modal so
          the two "zoom to inspect" surfaces feel like one family. */}
      <style>{`
        @keyframes tt-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes tt-fade-out { from { opacity: 1; } to { opacity: 0; } }
        @keyframes tt-modal-entrance {
          from { opacity: 0; transform: scale(0.96) translateY(10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes tt-modal-exit {
          from { opacity: 1; transform: scale(1) translateY(0); }
          to { opacity: 0; transform: scale(0.96) translateY(10px); }
        }
        .animate-tt-fade-in { animation: tt-fade-in 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .animate-tt-fade-out { animation: tt-fade-out 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .animate-tt-modal { animation: tt-modal-entrance 0.3s cubic-bezier(0.34, 1.3, 0.64, 1) forwards; }
        .animate-tt-modal-exit { animation: tt-modal-exit 0.2s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @media (prefers-reduced-motion: reduce) {
          .animate-tt-fade-in, .animate-tt-fade-out, .animate-tt-modal, .animate-tt-modal-exit { animation: none; }
        }
      `}</style>

      <div
        className={cn(
          "relative w-full max-w-6xl h-[88vh] backdrop-blur-2xl bg-white/90 dark:bg-oai-gray-900/90 border border-oai-gray-200/50 dark:border-white/10 shadow-2xl rounded-2xl flex flex-col md:flex-row overflow-hidden",
          isClosing ? "animate-tt-modal-exit" : "animate-tt-modal",
        )}
      >
        <button
          type="button"
          onClick={handleClose}
          aria-label={copy("trend.zoom.close_aria")}
          className="absolute top-4 right-4 z-50 p-2 rounded-full border border-oai-gray-200/60 dark:border-oai-gray-800/60 bg-white/50 dark:bg-oai-gray-900/50 text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-900 dark:hover:text-white hover:rotate-90 hover:scale-105 active:scale-95 transition-all duration-300"
        >
          <X size={16} />
        </button>

        <TrendMonitorZoomStatsPanel stats={stats} timeZoneLabel={timeZoneLabel} />

        {/* Right: controls + enlarged chart */}
        <div className="flex-1 min-w-0 flex flex-col p-5 md:p-6 overflow-y-auto">
          <TrendMonitorZoomControls
            zoomPeriod={zoomPeriod}
            onSelectGranularity={selectGranularity}
            selectedDay={selectedDay}
            maxDay={maxDay}
            onSelectDay={setSelectedDay}
            rangeSel={rangeSel}
            onSelectRange={setRangeSel}
          />
          <TrendMonitorZoomChart
            loading={loading}
            rows={rows}
            from={dataFrom}
            to={dataTo}
            period={zoomPeriod}
            timeZoneLabel={timeZoneLabel}
            renderChart={renderChart}
          />
        </div>
      </div>
    </div>
  );
}
