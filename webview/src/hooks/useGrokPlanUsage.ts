import { useCallback, useEffect, useRef, useState } from 'react';
import { BRIDGE_READY_EVENT } from '../utils/bridgeStartup';
import { parseCapacityPayload, type PlanUsageSnapshot } from '../utils/planUsagePace';

export type GrokPlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: PlanUsageSnapshot | null;
};

const EMPTY: GrokPlanUsageState = { status: 'idle', snapshot: null };

const BACKOFF_MS = [20_000, 60_000, 300_000, 1_800_000] as const;
const SUCCESS_POLL_MS = 60_000;
/** api_key auth has no credit window. Ask again rarely so a switch to OAuth shows the bar. */
const SKIP_RECHECK_MS = 300_000;
/** Java answers within ~90s (lock wait + 45s RPC). A lost reply must not end the poll loop. */
const REPLY_WATCHDOG_MS = 120_000;
/** Another window's refresh was in flight; its result is cached well before this. */
const REFRESHING_RETRY_MS = 20_000;

/**
 * skip: api_key auth. dormant: no running daemon, so nothing failed.
 * refreshing: another window is fetching right now. fresh: a live reading.
 * failure: anything else, including a stale copy.
 */
type ReplyKind = 'skip' | 'dormant' | 'refreshing' | 'fresh' | 'failure';

type ReplyFlags = { skipPolling?: unknown; dormant?: unknown; refreshing?: unknown };

function classifyReply(raw: unknown, snap: PlanUsageSnapshot): ReplyKind {
  const flags = (raw && typeof raw === 'object' ? raw : {}) as ReplyFlags;
  if (flags.skipPolling === true) return 'skip';
  if (flags.dormant === true) return 'dormant';
  if (flags.refreshing === true) return 'refreshing';
  if (snap.present && snap.stale !== true) return 'fresh';
  return 'failure';
}

/**
 * Apply one poll result. The bar stays hidden until a present payload, and a later
 * {@code present: false} hides it again. A stale present reading keeps the percent.
 */
function applySnapshot(snap: PlanUsageSnapshot): GrokPlanUsageState {
  if (snap.present) {
    return { status: 'ready', snapshot: snap };
  }
  return EMPTY;
}

function keepPresentOrEmpty(prev: GrokPlanUsageState): GrokPlanUsageState {
  return prev.snapshot?.present ? prev : EMPTY;
}

/**
 * Grok plan usage for ContextBar via the Java bridge
 * ({@code get_grok_plan_usage} → ACP {@code _x.ai/billing} on grok agent stdio).
 */
export function useGrokPlanUsage(currentProvider: string) {
  const [state, setState] = useState<GrokPlanUsageState>(EMPTY);
  const genRef = useRef(0);
  const handlerRef = useRef<((json: string) => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<(() => void) | null>(null);
  const failureStepRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** One timer: the next poll, or the watchdog while a reply is pending. */
  const scheduleNext = useCallback((delayMs: number) => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      pollRef.current?.();
    }, delayMs);
  }, [clearTimer]);

  const nextFailureDelay = useCallback(() => {
    const delay = BACKOFF_MS[failureStepRef.current];
    failureStepRef.current = Math.min(failureStepRef.current + 1, BACKOFF_MS.length - 1);
    return delay;
  }, []);

  const handleReply = useCallback((jsonStr: string) => {
    let raw: unknown;
    try {
      raw = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    } catch {
      setState(keepPresentOrEmpty);
      scheduleNext(nextFailureDelay());
      return;
    }
    const snap = parseCapacityPayload(raw);
    const kind = classifyReply(raw, snap);
    if (kind === 'skip') {
      failureStepRef.current = 0;
      setState(EMPTY);
      scheduleNext(SKIP_RECHECK_MS);
      return;
    }
    setState(applySnapshot(snap));
    if (kind === 'fresh' || kind === 'dormant') {
      // Dormant: Java answers without contacting the daemon, so the normal cadence is
      // cheap and picks up the next chat turn within a minute. It also ends a failure streak.
      failureStepRef.current = 0;
      scheduleNext(SUCCESS_POLL_MS);
    } else if (kind === 'refreshing') {
      scheduleNext(REFRESHING_RETRY_MS);
    } else {
      scheduleNext(nextFailureDelay());
    }
  }, [nextFailureDelay, scheduleNext]);

  const poll = useCallback(() => {
    if (currentProvider !== 'grok') {
      return;
    }
    const gen = ++genRef.current;
    setState(keepPresentOrEmpty);

    const w = window as unknown as {
      updateGrokPlanUsage?: (json: string) => void;
      sendToJava?: (cmd: string) => void;
    };

    handlerRef.current = (jsonStr: string) => {
      if (gen === genRef.current) {
        handleReply(jsonStr);
      }
    };
    w.updateGrokPlanUsage = (json: string) => {
      if (handlerRef.current) {
        handlerRef.current(json);
      }
    };

    // Armed before sending so a reply that arrives synchronously replaces the watchdog.
    scheduleNext(REPLY_WATCHDOG_MS);
    try {
      w.sendToJava?.('get_grok_plan_usage:');
    } catch {
      if (gen === genRef.current) {
        setState(keepPresentOrEmpty);
        scheduleNext(nextFailureDelay());
      }
    }
  }, [currentProvider, handleReply, nextFailureDelay, scheduleNext]);

  pollRef.current = poll;

  const refresh = useCallback(() => {
    failureStepRef.current = 0;
    clearTimer();
    poll();
  }, [clearTimer, poll]);

  useEffect(() => {
    failureStepRef.current = 0;
    if (currentProvider !== 'grok') {
      setState(EMPTY);
      clearTimer();
      return () => {
        genRef.current += 1;
        clearTimer();
      };
    }
    const onBridgeReady = () => {
      pollRef.current?.();
    };
    window.addEventListener(BRIDGE_READY_EVENT, onBridgeReady);
    poll();
    return () => {
      genRef.current += 1;
      window.removeEventListener(BRIDGE_READY_EVENT, onBridgeReady);
      clearTimer();
    };
  }, [clearTimer, currentProvider, poll]);

  return { ...state, refresh };
}

export type UseGrokPlanUsageReturn = ReturnType<typeof useGrokPlanUsage>;
