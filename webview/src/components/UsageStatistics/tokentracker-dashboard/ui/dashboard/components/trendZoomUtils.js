// Pure helpers/constants for the TrendMonitor zoom modal. Extracted from
// TrendMonitorZoomModal.jsx so the modal and its sections stay small; no
// component imports here, so there is no import cycle.

// Granularity tabs. `period` is the value useTrendData understands
// (day -> hourly/30-min, month -> daily, total -> monthly).
export const GRANULARITIES = [
  { period: "day", labelKey: "trend.zoom.gran.30min" },
  { period: "month", labelKey: "trend.zoom.gran.day" },
  { period: "total", labelKey: "trend.zoom.gran.month" },
];

export const DAILY_WINDOW_DAYS = 30;
export const MONTHLY_WINDOW = 24;

// System accent shared with ActivityHeatmap's 3D Insight modal (its default
// emerald palette) so both "zoom to inspect" surfaces read as one family.
export const ACCENT = "#10b981";

export function initialPeriod(period) {
  if (period === "day") return "day";
  if (period === "total") return "total";
  return "month";
}

// Shift a "YYYY-MM-DD" string by `delta` days (UTC). Returns input unchanged
// if it isn't a plain date.
export function shiftDay(dayStr, delta) {
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
export function shiftMonth(dayStr, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayStr || ""));
  if (!m) return dayStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, Number(m[3])));
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// Inclusive month span between two "YYYY-MM-DD" strings, for monthly fetches.
export function monthsBetween(fromStr, toStr) {
  const a = /^(\d{4})-(\d{2})/.exec(String(fromStr || ""));
  const b = /^(\d{4})-(\d{2})/.exec(String(toStr || ""));
  if (!a || !b) return MONTHLY_WINDOW;
  const span = (Number(b[1]) * 12 + Number(b[2])) - (Number(a[1]) * 12 + Number(a[2])) + 1;
  return Math.max(1, span);
}

// Default selected range per granularity (Day -> last 30 days, Month -> last 24 months).
export function defaultRangeForPeriod(zoomPeriod, today) {
  if (!today) return { from: null, to: null };
  if (zoomPeriod === "total") {
    return { from: shiftMonth(today, -(MONTHLY_WINDOW - 1)), to: today };
  }
  return { from: shiftDay(today, -(DAILY_WINDOW_DAYS - 1)), to: today };
}

// Compact "05-15 14:00" label for a peak bucket; daily/monthly keys pass through.
export function prettifyPeakLabel(label) {
  const m = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(label || ""));
  if (m) return `${m[1]} ${m[2]}`;
  return label || "";
}
