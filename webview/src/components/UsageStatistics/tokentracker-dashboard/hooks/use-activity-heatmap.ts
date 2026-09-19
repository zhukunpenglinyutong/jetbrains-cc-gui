import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildActivityHeatmap,
  computeActiveStreakDays,
  getHeatmapRangeLocal,
} from "../lib/activity-heatmap";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { isMockEnabled } from "../lib/mock-data";
import { getTimeZoneCacheKey } from "../lib/timezone";
import {
  getUsageDaily,
  getUsageHeatmap,
} from "../lib/api";
import { isTauriRuntime } from "../lib/tt-transport";
import { useLatestRequestGuard } from "./use-latest-request-guard";
import { touchLocalStorageCacheKey } from "../lib/local-storage-lru";

// Bounds the per-range response cache keys (they embed weeks/tz/device, so
// every period/device switch mints one) — see lib/local-storage-lru.ts.
const HEATMAP_CACHE_INDEX_KEY = "tokentracker.heatmap-cache-index";
const HEATMAP_CACHE_MAX_ENTRIES = 24;

export function useActivityHeatmap({
  baseUrl,
  accessToken,
  guestAllowed = false,
  weeks = 52,
  weekStartsOn = "sun",
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  now,
  deviceId = null,
}: any = {}) {
  const range = useMemo(() => {
    return getHeatmapRangeLocal({ weeks, weekStartsOn, now });
  }, [now, weeks, weekStartsOn]);
  const [daily, setDaily] = useState<any[]>([]);
  const [heatmap, setHeatmap] = useState<any | null>(null);
  const [source, setSource] = useState("edge");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed;

  // Vendored change: inside the desktop app the Tauri webview is always
  // "local mode" (the Rust side proxies to the CLI's localhost server),
  // regardless of what window.location.hostname resolves to.
  const isLocalMode = isTauriRuntime() || (typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"));

  const storageKey = useMemo(() => {
    if (!cacheKey) return null;
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    return `tokentracker.heatmap.${cacheKey}.local.${weeks}.${weekStartsOn}.${tzKey}.${deviceId || "all"}`;
  }, [cacheKey, deviceId, timeZone, tzOffsetMinutes, weeks, weekStartsOn]);

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.heatmap) return null;
      return parsed;
    } catch (_e) {
      return null;
    }
  }, [storageKey]);

  const writeCache = useCallback(
    (payload: any) => {
      if (!storageKey || typeof window === "undefined") return;
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
        touchLocalStorageCacheKey(HEATMAP_CACHE_INDEX_KEY, storageKey, HEATMAP_CACHE_MAX_ENTRIES);
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

  const beginRequest = useLatestRequestGuard([
    baseUrl,
    accessToken,
    range.from,
    range.to,
    weeks,
    weekStartsOn,
    deviceId,
    timeZone,
    tzOffsetMinutes,
  ]);

  const refresh = useCallback(async () => {
    const isCurrent = beginRequest();
    const resolvedToken = await resolveAuthAccessToken(accessToken);
    if (!isCurrent()) return;
    if (!resolvedToken && !mockEnabled && !isLocalMode) return;
    const tokenForFetch = resolvedToken;
    const heatmapFetcher = getUsageHeatmap;
    const dailyFetcher = getUsageDaily;
    setLoading(true);
    setError(null);
    try {
      try {
        const res = await heatmapFetcher({
          baseUrl,
          accessToken: tokenForFetch,
          weeks,
          to: range.to,
          weekStartsOn,
          device: deviceId,
          timeZone,
          tzOffsetMinutes,
        });
        if (!isCurrent()) return;
        const weeksData = Array.isArray(res?.weeks) ? res.weeks : [];
        if (!weeksData.length && cacheAllowed) {
          const cached = readCache();
          if (cached?.heatmap) {
            setHeatmap(cached.heatmap);
            setDaily(cached.daily || []);
            setSource("cache");
            return;
          }
        }
        const hasLevels = weeksData.some((week: any) =>
          (Array.isArray(week) ? week : []).some(
            (cell: any) => cell && Number.isFinite(Number(cell.level)),
          ),
        );
        if (!hasLevels && weeksData.length) {
          const rows = [];
          for (const week of weeksData) {
            for (const cell of Array.isArray(week) ? week : []) {
              if (!cell?.day) continue;
              rows.push({
                day: cell.day,
                total_tokens: cell.total_tokens ?? cell.value ?? 0,
                billable_total_tokens:
                  cell.billable_total_tokens ?? cell.value ?? cell.total_tokens ?? 0,
              });
            }
          }
          const localHeatmap = buildActivityHeatmap({
            dailyRows: rows,
            weeks,
            to: res?.to || range.to,
            weekStartsOn,
          });
          setDaily(rows);
          setHeatmap({
            ...localHeatmap,
            week_starts_on: weekStartsOn,
            active_days: rows.filter(
              (r: any) => Number(r?.billable_total_tokens ?? r?.total_tokens) > 0,
            ).length,
            streak_days: computeActiveStreakDays({
              dailyRows: rows,
              to: res?.to || range.to,
            }),
          });
          setSource("client");
          if (cacheAllowed) {
            writeCache({
              heatmap: {
                ...localHeatmap,
                week_starts_on: weekStartsOn,
                active_days: rows.filter(
                  (r: any) => Number(r?.billable_total_tokens ?? r?.total_tokens) > 0,
                ).length,
                streak_days: computeActiveStreakDays({
                  dailyRows: rows,
                  to: res?.to || range.to,
                }),
              },
              daily: rows,
              fetchedAt: new Date().toISOString(),
            });
          } else {
            clearCache();
          }
          return;
        }

        setHeatmap(res || null);
        setDaily([]);
        setSource("edge");
        if (res && cacheAllowed) {
          writeCache({
            heatmap: res,
            daily: [],
            fetchedAt: new Date().toISOString(),
          });
        } else if (!cacheAllowed) {
          clearCache();
        }
        return;
      } catch (e) {
        const err = e as any;
        const status = err?.status ?? err?.statusCode;
        if (status === 401 || status === 403) throw e;
      }

      const dailyRes = await dailyFetcher({
        baseUrl,
        accessToken: tokenForFetch,
        from: range.from,
        to: range.to,
        device: deviceId,
        timeZone,
        tzOffsetMinutes,
      });
      if (!isCurrent()) return;
      const rows = Array.isArray(dailyRes?.data) ? dailyRes.data : [];
      setDaily(rows);
      const localHeatmap = buildActivityHeatmap({
        dailyRows: rows,
        weeks,
        to: range.to,
        weekStartsOn,
      });
      setHeatmap({
        ...localHeatmap,
        week_starts_on: weekStartsOn,
        active_days: rows.filter(
          (r: any) => Number(r?.billable_total_tokens ?? r?.total_tokens) > 0,
        ).length,
        streak_days: computeActiveStreakDays({ dailyRows: rows, to: range.to }),
      });
      setSource("client");
      if (cacheAllowed) {
        writeCache({
          heatmap: {
            ...localHeatmap,
            week_starts_on: weekStartsOn,
            active_days: rows.filter(
              (r: any) => Number(r?.billable_total_tokens ?? r?.total_tokens) > 0,
            ).length,
            streak_days: computeActiveStreakDays({ dailyRows: rows, to: range.to }),
          },
          daily: rows,
          fetchedAt: new Date().toISOString(),
        });
      } else {
        clearCache();
      }
    } catch (e) {
      if (!isCurrent()) return;
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.heatmap) {
          setHeatmap(cached.heatmap);
          setDaily(cached.daily || []);
          setSource("cache");
          setError(null);
        } else {
          const err = e as any;
          setError(err?.message || String(err));
          setDaily([]);
          setHeatmap(null);
          setSource("edge");
        }
      } else {
        const err = e as any;
        setError(err?.message || String(err));
        setDaily([]);
        setHeatmap(null);
        setSource("edge");
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    accessToken,
    baseUrl,
    mockEnabled,
    cacheAllowed,
    range.from,
    range.to,
    readCache,
    timeZone,
    tzOffsetMinutes,
    weekStartsOn,
    weeks,
    clearCache,
    writeCache,
    isLocalMode,
    deviceId,
    beginRequest,
  ]);

  useEffect(() => {
    if (!tokenReady && !guestAllowed && !mockEnabled && !isLocalMode) {
      setDaily([]);
      setLoading(false);
      setError(null);
      setHeatmap(null);
      setSource("edge");
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setDaily([]);
      setError(null);
      setHeatmap(null);
      setSource("edge");
    } else {
      const cached = readCache();
      if (cached?.heatmap) {
        setHeatmap(cached.heatmap);
        setDaily(cached.daily || []);
        setSource("cache");
      }
    }
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
  ]);

  const normalizedSource = mockEnabled ? "mock" : source === "client" ? "edge" : source;

  return { range, daily, heatmap, source: normalizedSource, loading, error, refresh };
}
