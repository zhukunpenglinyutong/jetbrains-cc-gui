import { useCallback, useEffect, useRef, useState } from 'react';
import { parseCapacityPayload, type PlanUsageSnapshot } from '../utils/planUsagePace';
import { subscribeActiveProvider } from '../utils/runtimeProviderCapabilities';

export type ClaudePlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: PlanUsageSnapshot | null;
};

const EMPTY: ClaudePlanUsageState = { status: 'idle', snapshot: null };

/**
 * Apply one poll result. Until the first present payload the bar stays hidden:
 * backends that never emit {@code rate_limit_event} (API keys, proxies) would
 * otherwise show a permanent "Usage —" dash.
 */
function applySnapshot(
  prev: ClaudePlanUsageState,
  snap: PlanUsageSnapshot,
): ClaudePlanUsageState {
  if (snap.present) {
    return { status: 'ready', snapshot: snap };
  }
  if (!prev.snapshot?.present) {
    return EMPTY;
  }
  return { status: 'unavailable', snapshot: snap };
}

/**
 * Claude plan usage for ContextBar via Java bridge
 * ({@code get_claude_plan_usage} → cached SDK rate_limit_event snapshot).
 */
export function useClaudePlanUsage(currentProvider: string) {
  const [state, setState] = useState<ClaudePlanUsageState>(EMPTY);
  const genRef = useRef(0);
  const handlerRef = useRef<((json: string) => void) | null>(null);
  const activeProviderIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    if (currentProvider !== 'claude') {
      setState(EMPTY);
      return;
    }
    const gen = ++genRef.current;
    // Keep the last data while re-polling; stay hidden until the first event.
    setState((prev) => (prev.snapshot?.present ? prev : EMPTY));

    const w = window as unknown as {
      updateClaudePlanUsage?: (json: string) => void;
      sendToJava?: (cmd: string) => void;
    };

    const handler = (jsonStr: string) => {
      if (gen !== genRef.current) return;
      try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        setState((prev) => applySnapshot(prev, parseCapacityPayload(data)));
      } catch {
        setState((prev) =>
          applySnapshot(prev, { present: false, message: 'Usage unavailable' }));
      }
    };

    handlerRef.current = handler;
    w.updateClaudePlanUsage = (json: string) => {
      if (handlerRef.current) {
        handlerRef.current(json);
      }
    };

    try {
      w.sendToJava?.('get_claude_plan_usage:');
    } catch {
      if (gen === genRef.current) {
        setState((prev) =>
          applySnapshot(prev, { present: false, message: 'Usage unavailable' }));
      }
    }
  }, [currentProvider]);

  useEffect(() => {
    void refresh();
    if (currentProvider !== 'claude') {
      return () => {
        genRef.current += 1;
      };
    }
    const id = window.setInterval(() => {
      void refresh();
    }, 120_000);
    return () => {
      window.clearInterval(id);
      genRef.current += 1;
    };
  }, [currentProvider, refresh]);

  // Re-poll immediately when the active Claude provider changes (e.g. via the
  // runtime provider dropdown): currentProvider only tracks the engine, so a
  // provider switch would otherwise wait for the next 120s interval. Java
  // pushes updateActiveProvider after every switch_provider.
  useEffect(() => {
    if (currentProvider !== 'claude') {
      activeProviderIdRef.current = null;
      return;
    }
    const unsubscribe = subscribeActiveProvider((json) => {
      try {
        const provider = JSON.parse(json) as { id?: string };
        if (!provider?.id) return;
        const previous = activeProviderIdRef.current;
        activeProviderIdRef.current = provider.id;
        // Refresh on the first event too: after navigating away and back
        // (e.g. settings), this ref starts null again and that first push may
        // itself be a switch — treating it as a silent baseline would leave
        // stale usage on screen. Same-id re-pushes are deduped.
        if (previous !== provider.id) {
          // Drop the old provider's snapshot first: a backend without usage
          // support then stays hidden instead of showing "Usage —".
          setState(EMPTY);
          void refresh();
        }
      } catch {
        // Malformed payloads are ignored; the 120s interval still polls.
      }
    });
    return unsubscribe;
  }, [currentProvider, refresh]);

  return { ...state, refresh };
}

export type UseClaudePlanUsageReturn = ReturnType<typeof useClaudePlanUsage>;
