import { useCallback, useEffect, useMemo, useState } from "react";
import { isAccessTokenReady, resolveAuthAccessToken } from "../lib/auth-token";
import { isMockEnabled } from "../lib/mock-data";
import { getTimeZoneCacheKey } from "../lib/timezone";
import { getUsageModelBreakdown } from "../lib/api";
import { useLatestRequestGuard } from "./use-latest-request-guard";
import { isTauriRuntime } from "../lib/tt-transport";

export function useUsageModelBreakdown({
  baseUrl,
  accessToken,
  guestAllowed = false,
  from,
  to,
  cacheKey,
  timeZone,
  tzOffsetMinutes,
  deviceId = null,
}: any = {}) {
  const [breakdown, setBreakdown] = useState<any | null>(null);
  const [source, setSource] = useState<string>("edge");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mockEnabled = isMockEnabled();
  const tokenReady = isAccessTokenReady(accessToken);
  const cacheAllowed = !guestAllowed;

  const storageKey = useMemo(() => {
    if (!cacheKey) return null;
    const host = safeHost(baseUrl) || "default";
    const tzKey = getTimeZoneCacheKey({ timeZone, offsetMinutes: tzOffsetMinutes });
    return `tokentracker.modelBreakdown.${cacheKey}.local.${host}.${from}.${to}.${tzKey}.${deviceId || "all"}`;
  }, [baseUrl, cacheKey, deviceId, from, timeZone, to, tzOffsetMinutes]);

  const readCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.breakdown) return null;
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
      } catch (_e) {
        // ignore write errors
      }
    },
    [storageKey],
  );

  const clearCache = useCallback(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(storageKey);
    } catch (_e) {
      // ignore remove errors
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
    accessToken,
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
    const breakdownFetcher = getUsageModelBreakdown;
    setLoading(true);
    setError(null);
    try {
      const res = await breakdownFetcher({
        baseUrl,
        accessToken: tokenForFetch,
        from,
        to,
        device: deviceId,
        timeZone,
        tzOffsetMinutes,
      });
      if (!isCurrent()) return;
      setBreakdown(res || null);
      setSource("edge");
      if (res && cacheAllowed) {
        writeCache({ breakdown: res, fetchedAt: new Date().toISOString() });
      } else if (!cacheAllowed) {
        clearCache();
      }
    } catch (e) {
      if (!isCurrent()) return;
      if (cacheAllowed) {
        const cached = readCache();
        if (cached?.breakdown) {
          setBreakdown(cached.breakdown);
          setSource("cache");
          setError(null);
        } else {
          setBreakdown(null);
          setSource("edge");
          const err = e as any;
          setError(err?.message || String(err));
        }
      } else {
        setBreakdown(null);
        setSource("edge");
        const err = e as any;
        setError(err?.message || String(err));
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    accessToken,
    baseUrl,
    from,
    mockEnabled,
    cacheAllowed,
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
      setBreakdown(null);
      setSource("edge");
      setError(null);
      setLoading(false);
      return;
    }
    if (!cacheAllowed) {
      clearCache();
      setBreakdown(null);
      setSource("edge");
      setError(null);
    } else {
      const cached = readCache();
      if (cached?.breakdown) {
        setBreakdown(cached.breakdown);
        setSource("cache");
        setError(null);
      } else {
        // Provider cards must never keep the previous range's breakdown.
        setBreakdown(null);
        setSource("edge");
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
  ]);

  const normalizedSource = mockEnabled ? "mock" : source;

  return {
    breakdown,
    source: normalizedSource,
    loading,
    error,
    refresh,
  };
}

function safeHost(baseUrl: any) {
  try {
    const url = new URL(baseUrl);
    return url.host;
  } catch (_e) {
    return null;
  }
}
