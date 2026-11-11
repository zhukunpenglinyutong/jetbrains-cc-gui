import { useCallback, useEffect, useRef, useState } from 'react';
import { BRIDGE_READY_EVENT } from '../utils/bridgeStartup';
import { parseCapacityPayload, type PlanUsageSnapshot } from '../utils/planUsagePace';

export type OmpPlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: PlanUsageSnapshot | null;
};

const EMPTY: OmpPlanUsageState = { status: 'idle', snapshot: null };

const BACKOFF_MS = [20_000, 60_000, 300_000, 1_800_000] as const;
const SUCCESS_POLL_MS = 60_000;
/** Java answers within ~60s (the bridge bounds `omp usage`). A lost reply must not end the poll loop. */
const REPLY_WATCHDOG_MS = 120_000;

/**
 * Apply one poll result. The bar stays hidden until a present payload, and a later
 * {@code present: false} hides it again.
 */
function applySnapshot(snap: PlanUsageSnapshot): OmpPlanUsageState {
  if (snap.present) {
    return { status: 'ready', snapshot: snap };
  }
  return EMPTY;
}

function keepPresentOrEmpty(prev: OmpPlanUsageState): OmpPlanUsageState {
  return prev.snapshot?.present ? prev : EMPTY;
}

/**
 * OMP plan usage for ContextBar via the Java bridge
 * ({@code get_omp_plan_usage} → {@code omp usage --json}).
 */
export function useOmpPlanUsage(currentProvider: string) {
  const [state, setState] = useState<OmpPlanUsageState>(EMPTY);
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
    setState(applySnapshot(snap));
    if (snap.present) {
      failureStepRef.current = 0;
      scheduleNext(SUCCESS_POLL_MS);
    } else {
      scheduleNext(nextFailureDelay());
    }
  }, [nextFailureDelay, scheduleNext]);

  const poll = useCallback(() => {
    if (currentProvider !== 'omp') {
      return;
    }
    const gen = ++genRef.current;
    setState(keepPresentOrEmpty);

    const w = window as unknown as {
      updateOmpPlanUsage?: (json: string) => void;
      sendToJava?: (cmd: string) => void;
    };

    handlerRef.current = (jsonStr: string) => {
      if (gen === genRef.current) {
        handleReply(jsonStr);
      }
    };
    w.updateOmpPlanUsage = (json: string) => {
      if (handlerRef.current) {
        handlerRef.current(json);
      }
    };

    // Armed before sending so a reply that arrives synchronously replaces the watchdog.
    scheduleNext(REPLY_WATCHDOG_MS);
    try {
      w.sendToJava?.('get_omp_plan_usage:');
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
    if (currentProvider !== 'omp') {
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
