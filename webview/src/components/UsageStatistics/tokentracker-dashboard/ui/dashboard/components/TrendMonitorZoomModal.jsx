import React from "react";
import { Popover } from "@base-ui/react/popover";
import { X, ChevronLeft, ChevronRight, Terminal } from "lucide-react";
import { copy } from "../../../lib/copy";
import { cn } from "../../../lib/cn";
import { DateRangePopover } from "./DateRangePopover.jsx";
import { useCurrency } from "../../../hooks/useCurrency.js";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { formatTokenCount } from "../../../lib/token-format.js";
import { formatUsdCurrency } from "../../../lib/format";
import { useTrendData } from "../../../hooks/use-trend-data";
import { useDashboardPortalContainer } from "../../../hooks/useDashboardPortalContainer.js";
import { getLocalDayKey } from "../../../lib/timezone";
import { computeZoomStats, getTrendInsightKey } from "../../../lib/trend-stats";

// Granularity tabs. `period` is the value useTrendData understands
// (day -> hourly/30-min, month -> daily, total -> monthly).
const GRANULARITIES = [
  { period: "day", labelKey: "trend.zoom.gran.30min" },
  { period: "month", labelKey: "trend.zoom.gran.day" },
  { period: "total", labelKey: "trend.zoom.gran.month" },
];

const DAILY_WINDOW_DAYS = 30;
const MONTHLY_WINDOW = 24;

// System accent shared with ActivityHeatmap's 3D Insight modal (its default
// emerald palette) so both "zoom to inspect" surfaces read as one family.
const ACCENT = "#10b981";

function initialPeriod(period) {
  if (period === "day") return "day";
  if (period === "total") return "total";
  return "month";
}

// Shift a "YYYY-MM-DD" string by `delta` days (UTC). Returns input unchanged
// if it isn't a plain date.
function shiftDay(dayStr, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || ""));
  if (!m) return dayStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + delta);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// Shift a "YYYY-MM-DD" string by `delta` months (UTC), keeping the day.
function shiftMonth(dayStr, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || ""));
  if (!m) return dayStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, Number(m[3])));
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// Inclusive month span between two "YYYY-MM-DD" strings, for monthly fetches.
function monthsBetween(fromStr, toStr) {
  const a = /^(\d{4})-(\d{2})/.exec(String(fromStr || ""));
  const b = /^(\d{4})-(\d{2})/.exec(String(toStr || ""));
  if (!a || !b) return MONTHLY_WINDOW;
  const span = (Number(b[1]) * 12 + Number(b[2])) - (Number(a[1]) * 12 + Number(a[2])) + 1;
  return Math.max(1, span);
}

// Default selected range per granularity (Day -> last 30 days, Month -> last 24 months).
function defaultRangeForPeriod(zoomPeriod, today) {
  if (!today) return { from: null, to: null };
  if (zoomPeriod === "total") {
    return { from: shiftMonth(today, -(MONTHLY_WINDOW - 1)), to: today };
  }
  return { from: shiftDay(today, -(DAILY_WINDOW_DAYS - 1)), to: today };
}

// Compact "05-15 14:00" label for a peak bucket; daily/monthly keys pass through.
function prettifyPeakLabel(label) {
  const m = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(label || ""));
  if (m) return `${m[1]} ${m[2]}`;
  return label || "";
}

function StatCell({ label, value, sub, title }) {
  return (
    <div className="flex flex-col gap-1.5 group">
      <span className="text-[9px] font-bold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
        {label}
      </span>
      <span title={title} className="text-xl font-black font-mono text-zinc-900 dark:text-zinc-50 tracking-tight leading-none tabular-nums transition-transform duration-200 group-hover:-translate-y-[1px]">
        {value}
      </span>
      {sub ? (
        <span className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 font-mono tabular-nums">{sub}</span>
      ) : null}
    </div>
  );
}

export function TrendMonitorZoomModal({
  zoomConfig,
  period,
  from,
  to,
  timeZoneLabel,
  onClose,
  renderChart,
}) {
  const { currency, rate } = useCurrency();
  const { formatTokensTooltip } = useTokenFormat();
  const portalContainer = useDashboardPortalContainer();
  // The left summary panel always uses compact figures (9.7B / 686.1M) — full
  // numbers break the narrow panel layout. Exact values stay on hover titles.
  const formatStatTokens = (v) => formatTokenCount(v);

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
  const [dayPickerOpen, setDayPickerOpen] = React.useState(false);
  const [rangePickerOpen, setRangePickerOpen] = React.useState(false);
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

  const canPrevDay = zoomPeriod === "day" && !!selectedDay;
  const canNextDay = zoomPeriod === "day" && !!selectedDay && (!maxDay || selectedDay < maxDay);

  const costValue = stats.totalCostUsd != null
    ? formatUsdCurrency(stats.totalCostUsd, { currency, rate })
    : null;

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

        {/* Left: aggregate stats — shares ActivityHeatmap's terminal-native panel language */}
        <div className="w-full md:w-[320px] shrink-0 border-b md:border-b-0 md:border-r border-zinc-200/50 dark:border-zinc-800/40 p-5 md:p-6 flex flex-col gap-6 overflow-y-auto backdrop-blur-md bg-zinc-50/50 dark:bg-zinc-950/50">
          <div>
            <div className="flex items-center gap-1.5 select-none">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: ACCENT }} />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: ACCENT }} />
              </span>
              <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono text-zinc-400 dark:text-zinc-500">
                {copy("trend.zoom.badge")}
              </span>
            </div>
            <h4 className="text-xl font-black text-zinc-900 dark:text-zinc-50 tracking-tight leading-none mt-2 select-none">
              {copy("trend.monitor.label")}
            </h4>
            {timeZoneLabel ? (
              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 mt-1.5 font-mono select-none">{timeZoneLabel}</p>
            ) : null}
            <p className="text-[11px] leading-relaxed text-zinc-400 dark:text-zinc-500 mt-2 font-normal select-none">
              {copy("trend.zoom.desc")}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-5 gap-y-5 border-y border-zinc-200/50 dark:border-zinc-800/50 py-5 select-none">
            <StatCell
              label={copy("trend.zoom.stats.tokens")}
              value={formatStatTokens(stats.totalTokens)}
              title={formatTokensTooltip(stats.totalTokens)}
            />
            {costValue ? (
              <StatCell label={copy("trend.zoom.stats.cost")} value={costValue} />
            ) : null}
            <StatCell
              label={copy("trend.zoom.stats.conversations")}
              value={stats.conversationCount.toLocaleString()}
            />
            {stats.peak ? (
              <StatCell
                label={copy("trend.zoom.stats.peak")}
                value={formatStatTokens(stats.peak.value)}
                title={formatTokensTooltip(stats.peak.value)}
                sub={prettifyPeakLabel(stats.peak.label)}
              />
            ) : null}
          </div>

          <div className="flex flex-col gap-2 select-none">
            <div className="flex items-center gap-1.5">
              <Terminal size={11} style={{ color: ACCENT }} />
              <span className="text-[9px] font-extrabold uppercase tracking-widest font-mono" style={{ color: ACCENT }}>
                {copy("trend.zoom.insight_badge")}
              </span>
            </div>
            <div className="pl-3.5 border-l-2 relative" style={{ borderColor: ACCENT }}>
              <div className="absolute inset-y-0 left-0 w-[3px] blur-[2px] opacity-15 pointer-events-none rounded-full" style={{ backgroundColor: ACCENT }} />
              <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400 font-normal">
                {copy(getTrendInsightKey(stats), {
                  active: stats.activeBuckets,
                  peak: formatStatTokens(stats.peak?.value || 0),
                })}
              </p>
            </div>
          </div>
        </div>

        {/* Right: controls + enlarged chart */}
        <div className="flex-1 min-w-0 flex flex-col p-5 md:p-6 overflow-y-auto">
          <div className="flex items-center justify-between gap-3 mb-6 pr-10">
            {/* Granularity tabs */}
            <div
              role="tablist"
              aria-label={copy("trend.zoom.gran.aria")}
              className="flex rounded-md border border-oai-gray-200 dark:border-oai-gray-800 p-0.5 text-[11px]"
            >
              {GRANULARITIES.map((g) => (
                <button
                  key={g.period}
                  type="button"
                  role="tab"
                  aria-selected={zoomPeriod === g.period}
                  onClick={() => selectGranularity(g.period)}
                  className={cn(
                    "px-2.5 py-1 rounded transition-colors",
                    zoomPeriod === g.period
                      ? "bg-oai-gray-100 text-oai-black dark:bg-oai-gray-800 dark:text-oai-white font-medium"
                      : "text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200",
                  )}
                >
                  {copy(g.labelKey)}
                </button>
              ))}
            </div>

            {/* Day navigation (30-min view only) */}
            {zoomPeriod === "day" ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => canPrevDay && setSelectedDay((d) => shiftDay(d, -1))}
                  disabled={!canPrevDay}
                  aria-label={copy("trend.zoom.prev_day")}
                  className="p-1 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                <Popover.Root open={dayPickerOpen} onOpenChange={setDayPickerOpen}>
                  <Popover.Trigger
                    aria-label={copy("trend.zoom.pick_day")}
                    className="text-[12px] font-medium text-oai-gray-700 dark:text-oai-gray-200 tabular-nums min-w-[100px] text-center px-2 py-0.5 rounded-md border border-oai-gray-200 dark:border-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors"
                  >
                    {selectedDay || "—"}
                  </Popover.Trigger>
                  <Popover.Portal container={portalContainer}>
                    <Popover.Positioner sideOffset={8} side="bottom" align="center" className="!z-[9999]">
                      <Popover.Popup className="bg-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-700 rounded-xl shadow-lg">
                        <DateRangePopover
                          from={selectedDay}
                          to={selectedDay}
                          onApply={(fromStr) => {
                            if (fromStr) setSelectedDay(fromStr);
                            setDayPickerOpen(false);
                          }}
                          onCancel={() => setDayPickerOpen(false)}
                        />
                      </Popover.Popup>
                    </Popover.Positioner>
                  </Popover.Portal>
                </Popover.Root>
                <button
                  type="button"
                  onClick={() => canNextDay && setSelectedDay((d) => shiftDay(d, 1))}
                  disabled={!canNextDay}
                  aria-label={copy("trend.zoom.next_day")}
                  className="p-1 rounded-md text-oai-gray-400 hover:text-oai-gray-700 dark:hover:text-oai-gray-200 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-30 disabled:pointer-events-none transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            ) : (
              <Popover.Root open={rangePickerOpen} onOpenChange={setRangePickerOpen}>
                <Popover.Trigger
                  aria-label={copy("trend.zoom.pick_range")}
                  className="text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300 tabular-nums px-2.5 py-1 rounded-md border border-oai-gray-200 dark:border-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 transition-colors select-none"
                >
                  {rangeSel.from && rangeSel.to
                    ? rangeSel.from === rangeSel.to
                      ? rangeSel.from
                      : `${rangeSel.from} → ${rangeSel.to}`
                    : "—"}
                </Popover.Trigger>
                <Popover.Portal container={portalContainer}>
                  <Popover.Positioner sideOffset={8} side="bottom" align="end" className="!z-[9999]">
                    <Popover.Popup className="bg-white dark:bg-oai-gray-900 border border-oai-gray-200 dark:border-oai-gray-700 rounded-xl shadow-lg">
                      <DateRangePopover
                        from={rangeSel.from}
                        to={rangeSel.to}
                        onApply={(f, t) => {
                          if (f) setRangeSel({ from: f, to: t || f });
                          setRangePickerOpen(false);
                        }}
                        onCancel={() => setRangePickerOpen(false)}
                      />
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
          </div>

          <div className="flex-1 min-h-0 flex flex-col">
            {loading && (!rows || rows.length === 0) ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-oai-gray-400 dark:text-oai-gray-400">
                  {copy("trend.zoom.loading")}
                </p>
              </div>
            ) : (
              renderChart({
                rows,
                from: dataFrom,
                to: dataTo,
                period: zoomPeriod,
                timeZoneLabel,
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
