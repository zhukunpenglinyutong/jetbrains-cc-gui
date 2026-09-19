import { useCallback, useEffect, useState } from "react";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { formatDateUTC } from "../lib/date-range";
import { isMockEnabled } from "../lib/mock-data";
import { getLocalDayKey, getTimeZoneCacheKey } from "../lib/timezone";
import {
  getUsageDaily,
  getUsageSummary,
} from "../lib/api";
import { useLatestRequestGuard } from "./use-latest-request-guard";
import { touchLocalStorageCacheKey } from "../lib/local-storage-lru";
import { isTauriRuntime } from "../lib/tt-transport";

// Bounds the per-range response cache keys (they embed from/to/tz/device, so
// every period/device switch mints one) — see lib/local-storage-lru.ts.
const USAGE_CACHE_INDEX_KEY = "tokentracker.usage-cache-index";
const USAGE_CACHE_MAX_ENTRIES = 24;

export function useUsageData({
  baseUrl,
  accessToken,
  guestAllowed = false,
  from,
  to,
  includeDaily = true,
  includeSummary = true,
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  now,
  deviceId = null,
}: any = {}) {
  const [daily, setDaily] = useState<any[]>([]);
  const [summary, setSummary] = useState<any | null>(null);
  const [rolling, setRolling] = useState<any | null>(null);
  const [source, setSource] = useState<string>("edge");
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed && !mockEnabled;

  const deviceScope = deviceId || "all";
  const storageKey = (() => {
    if (!cacheKey) return null;
    const host = safeHost(baseUrl) || "default";
    const dataKey = includeDaily
      ? includeSummary ? "daily-summary" : "daily-only"
      : "summary";
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    return `tokentracker.usage.${cacheKey}.local.${host}.${from}.${to}.${dataKey}.${tzKey}.${deviceScope}`;
  })();

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const hasRequestedData = includeSummary
        ? Boolean(parsed?.summary)
        : Array.isArray(parsed?.daily);
      if (!parsed || !hasRequestedData) return null;
      touchLocalStorageCacheKey(USAGE_CACHE_INDEX_KEY, storageKey, USAGE_CACHE_MAX_ENTRIES);
      return parsed;
    } catch (_e) {
      return null;
    }
  }, [includeSummary, storageKey]);

  const writeCache = useCallback(
    (payload: any) => {
      if (!storageKey || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
        touchLocalStorageCacheKey(USAGE_CACHE_INDEX_KEY, storageKey, USAGE_CACHE_MAX_ENTRIES);
      } catch (_e) {
        // ignore write errors (quota/private mode)
      }
    },
    [storageKey],
  );

  const clearCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch (_e) {
      // ignore remove errors (quota/private mode)
    }
  }, [storageKey]);

  // Vendored change: inside the desktop app the Tauri webview is always
  // "local mode" (the Rust side proxies to the CLI's localhost server),
  // regardless of what window.location.hostname resolves to.
  const isLocalMode = isTauriRuntime() || (typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"));

  const beginRequest = useLatestRequestGuard([
    baseUrl,
    from,
    to,
    includeDaily,
    includeSummary,
    accessToken,
    deviceId,
    timeZone,
    tzOffsetMinutes,
  ]);

  const refresh = useCallback(async () => {
    const isCurrent = beginRequest();
    const resolvedToken = await resolveAuthAccessToken(accessToken);
    if (!isCurrent()) return;
    // 本地模式允许空 token
    if (!resolvedToken && !mockEnabled && !isLocalMode) {
      setLoading(false);
      return;
    }
    const dailyFetcher = getUsageDaily;
    const summaryFetcher = getUsageSummary;
    const tokenForFetch = resolvedToken;
    setLoading(true);
    setError(null);
    try {
      let dailyRes = null;
      let summaryRes = null;
      if (includeDaily) {
        if (includeSummary) {
          const [dailyResult, summaryResult] = await Promise.allSettled([
            dailyFetcher({
              baseUrl,
              accessToken: tokenForFetch,
              from,
              to,
              device: deviceId,
              timeZone,
              tzOffsetMinutes,
            }),
            summaryFetcher({
              baseUrl,
              accessToken: tokenForFetch,
              from,
              to,
              device: deviceId,
              timeZone,
              tzOffsetMinutes,
              rolling: true,
            }),
          ]);
          if (dailyResult.status === "rejected") throw dailyResult.reason;
          dailyRes = dailyResult.value;
          summaryRes = summaryResult.status === "fulfilled" ? summaryResult.value : null;
        } else {
          dailyRes = await dailyFetcher({
            baseUrl,
            accessToken: tokenForFetch,
            from,
            to,
            device: deviceId,
            timeZone,
            tzOffsetMinutes,
          });
        }
      } else if (includeSummary) {
        summaryRes = await summaryFetcher({
          baseUrl,
          accessToken: tokenForFetch,
          from,
          to,
          device: deviceId,
          timeZone,
          tzOffsetMinutes,
          rolling: true,
        });
      }

      let nextDaily = includeDaily && Array.isArray(dailyRes?.data) ? dailyRes.data : [];
      if (includeDaily) {
        nextDaily = fillDailyGaps(nextDaily, from, to, {
          timeZone,
          offsetMinutes: tzOffsetMinutes,
          now,
        });
      }
      let nextSummary = includeSummary
        ? summaryRes?.totals || dailyRes?.summary?.totals || null
        : null;
      let nextRolling = includeSummary
        ? summaryRes?.rolling || dailyRes?.summary?.rolling || null
        : null;
      if (includeSummary && includeDaily && !nextSummary && !summaryRes) {
        try {
          const fallback = await summaryFetcher({
            baseUrl,
            accessToken: tokenForFetch,
            from,
            to,
            device: deviceId,
            timeZone,
            tzOffsetMinutes,
            rolling: true,
          });
          nextSummary = fallback?.totals || null;
          nextRolling = fallback?.rolling || nextRolling;
        } catch (_e) {
          // Ignore summary fallback errors when daily data is available.
        }
      }
      const nowIso = new Date().toISOString();

      if (!isCurrent()) return;

      setDaily(nextDaily);
      setSummary(nextSummary);
      setRolling(nextRolling);
      setSource("edge");
      setFetchedAt(nowIso);

      if ((nextSummary || (!includeSummary && includeDaily)) && cacheAllowed) {
        writeCache({
          summary: nextSummary,
          rolling: nextRolling,
          daily: nextDaily,
          from,
          to,
          includeDaily,
          includeSummary,
          fetchedAt: nowIso,
        });
      } else if (!cacheAllowed) {
        clearCache();
      }
    } catch (e) {
      if (!isCurrent()) return;
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.summary || (!includeSummary && Array.isArray(cached?.daily))) {
          setSummary(cached.summary);
          setRolling(cached.rolling || null);
          const cachedDaily = Array.isArray(cached.daily) ? cached.daily : [];
          const filledDaily = includeDaily
            ? fillDailyGaps(cachedDaily, cached.from || from, cached.to || to, {
                timeZone,
                offsetMinutes: tzOffsetMinutes,
                now,
              })
            : cachedDaily;
          setDaily(filledDaily);
          setSource("cache");
          setFetchedAt(cached.fetchedAt || null);
          setError(null);
        } else {
          const err = e as any;
          setError(err?.message || String(err));
          setDaily([]);
          setSummary(null);
          setRolling(null);
          setSource("edge");
          setFetchedAt(null);
        }
      } else {
        const err = e as any;
        setError(err?.message || String(err));
        setDaily([]);
        setSummary(null);
        setRolling(null);
        setSource("edge");
        setFetchedAt(null);
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    accessToken,
    baseUrl,
    from,
    includeDaily,
    includeSummary,
    mockEnabled,
    cacheAllowed,
    now,
    readCache,
    timeZone,
    to,
    tzOffsetMinutes,
    clearCache,
    writeCache,
    isLocalMode,
    deviceId,
    beginRequest,
  ]);

  useEffect(() => {
    if (!tokenReady && !guestAllowed && !mockEnabled && !isLocalMode) {
      setDaily([]);
      setSummary(null);
      setRolling(null);
      setError(null);
      setLoading(false);
      setSource("edge");
      setFetchedAt(null);
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setDaily([]);
      setSummary(null);
      setRolling(null);
      setError(null);
      setSource("edge");
      setFetchedAt(null);
    } else {
      const cached = readCache();
      if (cached?.summary || (!includeSummary && Array.isArray(cached?.daily))) {
        setSummary(cached.summary);
        setRolling(cached.rolling || null);
        const cachedDaily = Array.isArray(cached.daily) ? cached.daily : [];
        const filledDaily = includeDaily
          ? fillDailyGaps(cachedDaily, cached.from || from, cached.to || to, {
              timeZone,
              offsetMinutes: tzOffsetMinutes,
              now,
            })
          : cachedDaily;
        setDaily(filledDaily);
        setSource("cache");
        setFetchedAt(cached.fetchedAt || null);
        setError(null);
      } else {
        // The selected range has no matching cache. Remove the previous
        // range immediately so its numbers never render under the new tab.
        setDaily([]);
        setSummary(null);
        setRolling(null);
        setSource("edge");
        setFetchedAt(null);
        setError(null);
      }
    }
    setLoading(true);
    refresh();
  }, [
    accessToken,
    mockEnabled,
    readCache,
    refresh,
    tokenReady,
    guestAllowed,
    cacheAllowed,
    clearCache,
    isLocalMode,
    includeSummary,
    from,
    to,
    includeDaily,
    timeZone,
    tzOffsetMinutes,
    now,
  ]);

  // Auto-refresh when the dashboard regains focus / becomes visible again.
  // Usage data otherwise only re-fetches on param changes, so a left-open
  // dashboard never picks up usage that synced after page load — the user had
  // to manually reload (the "open dashboard shows stale numbers" report).
  // Upload itself is already near-real-time (the notify hook runs `sync` at
  // most every ~20s); this closes the *display* refresh gap. Throttled so
  // rapid window switches don't hammer the edge.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const MIN_GAP_MS = 15_000;
    let lastAt = Date.now(); // mount already fired the initial fetch above
    const maybeRefresh = () => {
      if (document.visibilityState !== "visible") return;
      const nowMs = Date.now();
      if (nowMs - lastAt < MIN_GAP_MS) return;
      lastAt = nowMs;
      void refresh();
    };
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
    };
  }, [refresh]);

  const normalizedSource = mockEnabled ? "mock" : source;

  return {
    daily,
    summary,
    rolling,
    source: normalizedSource,
    fetchedAt,
    loading,
    error,
    refresh,
  };
}

function safeHost(baseUrl: any) {
  try {
    const u = new URL(baseUrl);
    return u.host;
  } catch (_e) {
    return null;
  }
}

function parseUtcDate(yyyyMmDd: any) {
  if (!yyyyMmDd) return null;
  const raw = String(yyyyMmDd).trim();
  const parts = raw.split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]) - 1;
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  const dt = new Date(Date.UTC(y, m, d));
  if (!Number.isFinite(dt.getTime())) return null;
  return formatDateUTC(dt) === raw ? dt : null;
}

function addUtcDays(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function fillDailyGaps(
  rows: any[],
  from: any,
  to: any,
  { timeZone, offsetMinutes, now }: any = {},
) {
  const start = parseUtcDate(from);
  const end = parseUtcDate(to);
  if (!start || !end || end < start) return Array.isArray(rows) ? rows : [];

  const baseDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const todayKey = getLocalDayKey({ timeZone, offsetMinutes, date: baseDate });
  const today = parseUtcDate(todayKey);
  const todayTime = today ? today.getTime() : baseDate.getTime();

  const byDay = new Map();
  for (const row of rows || []) {
    if (row?.day) byDay.set(row.day, row);
  }

  const filled = [];
  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    const day = formatDateUTC(cursor);
    const existing = byDay.get(day);
    const isFuture = cursor.getTime() > todayTime;
    if (existing) {
      filled.push({ ...existing, missing: false, future: isFuture });
      continue;
    }
    filled.push({
      day,
      total_tokens: null,
      billable_total_tokens: null,
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      reasoning_output_tokens: null,
      missing: !isFuture,
      future: isFuture,
    });
  }

  return filled;
}
