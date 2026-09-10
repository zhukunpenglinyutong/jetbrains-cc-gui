import React from "react";
import { toFiniteNumber } from "../../../lib/format";
import { useTokenFormat } from "../../../hooks/useTokenFormat.js";
import { useProjectUsageDetail } from "../../../hooks/use-project-usage-detail";
import { getLocalDayKey } from "../../../lib/timezone";
import { splitProjectKey, projectRefHost } from "./project-usage-utils.jsx";

const MAX_TREND_BARS = 60;

function resolveSeriesRange(daily, from, to, todayKey) {
  let start = from || daily[0].day;
  let end = to || daily[daily.length - 1].day;
  if (start > end) [start, end] = [end, start];
  if (todayKey && end > todayKey) end = todayKey;
  const lastDataDay = daily[daily.length - 1].day;
  if (end < lastDataDay) end = lastDataDay;
  return { start, end };
}

// Fill calendar gaps so the trend reads as real cadence, not a compressed
// list of active days. Capped to the most recent MAX_TREND_BARS days, and
// never past "today" — a month range ends on the 31st, but rendering future
// days as zero bars would read as inactivity that hasn't happened yet.
function fillDailySeries(daily, from, to, todayKey) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const { start, end } = resolveSeriesRange(daily, from, to, todayKey);
  const cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(endDate.getTime())) return daily;
  const spanDays = Math.round((endDate.getTime() - cursor.getTime()) / 86400000) + 1;
  if (spanDays > MAX_TREND_BARS) {
    cursor.setUTCDate(cursor.getUTCDate() + (spanDays - MAX_TREND_BARS));
  }
  const out = [];
  while (cursor.getTime() <= endDate.getTime() && out.length < MAX_TREND_BARS) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(key) || { day: key, total_tokens: 0, billable_total_tokens: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function useProjectDetailStats(data, loading, error) {
  const totals = data?.totals || null;
  const billableTotal = toFiniteNumber(totals?.billable_total_tokens) ?? 0;
  const daysActive = Number(data?.days_active || 0);
  const inputTokens = toFiniteNumber(totals?.input_tokens) ?? 0;
  const cachedTokens = toFiniteNumber(totals?.cached_input_tokens) ?? 0;
  const cacheHitRatio =
    inputTokens + cachedTokens > 0 ? cachedTokens / (inputTokens + cachedTokens) : null;
  const rangeTotal = toFiniteNumber(data?.range_total_tokens) ?? 0;
  const totalTokens = toFiniteNumber(totals?.total_tokens) ?? 0;
  const shareRatio = rangeTotal > 0 ? totalTokens / rangeTotal : null;
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const hasData = !loading && !error && totals && totalTokens > 0;
  return {
    totals,
    billableTotal,
    daysActive,
    cacheHitRatio,
    shareRatio,
    totalTokens,
    sources,
    hasData,
  };
}

export function useProjectDetailDerived({ entry, query }) {
  const projectKey = typeof entry?.project_key === "string" ? entry.project_key : "";
  const { owner, repo } = splitProjectKey(projectKey);
  const projectRef = typeof entry?.project_ref === "string" ? entry.project_ref : "";
  const host = projectRefHost(projectRef);

  const { data, loading, error } = useProjectUsageDetail({
    projectKey,
    from: query.from,
    to: query.to,
    timeZone: query.timeZone,
    tzOffsetMinutes: query.tzOffsetMinutes,
  });
  const { formatTokens, formatTokensTooltip } = useTokenFormat();

  const stats = useProjectDetailStats(data, loading, error);

  const daily = React.useMemo(
    () =>
      fillDailySeries(
        data?.daily,
        data?.from,
        data?.to,
        getLocalDayKey({ timeZone: query.timeZone, offsetMinutes: query.tzOffsetMinutes }),
      ),
    [data, query.timeZone, query.tzOffsetMinutes],
  );

  return {
    projectKey,
    owner,
    repo,
    projectRef,
    host,
    data,
    loading,
    error,
    daily,
    formatTokens,
    formatTokensTooltip,
    ...stats,
  };
}
