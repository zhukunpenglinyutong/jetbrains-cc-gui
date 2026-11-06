import { useCallback, useEffect, useRef, useState } from 'react';
import { parseCapacityPayload, type PlanUsageSnapshot } from '../utils/planUsagePace';
import { subscribeActiveProvider } from '../utils/runtimeProviderCapabilities';

export type ClaudePlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: PlanUsageSnapshot | null;
};

const EMPTY: ClaudePlanUsageState = { status: 'idle', snapshot: null };

// Module-level so request ids never repeat across remounts: an instance-scoped
// counter restarts at 1 and a slow in-flight reply from the previous instance
// (e.g. after a settings round-trip) would be accepted as the new one's own.
let requestSeq = 0;

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
  const activeProviderIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    if (currentProvider !== 'claude') {
      setState(EMPTY);
      return;
    }
    const gen = ++genRef.current;
    const requestId = String(++requestSeq);
    // Keep the last data while re-polling; stay hidden until the first event.
    setState((prev) => (prev.snapshot?.present ? prev : EMPTY));

    const w = window as unknown as {
      updateClaudePlanUsage?: (json: string) => void;
      sendToJava?: (cmd: string) => void;
    };

    // Bind this poll's handler directly: a reply is only accepted by the
    // callback that replaced the previous one (no shared handlerRef churn).
    const handler = (jsonStr: string) => {
      if (gen !== genRef.current) return;
      try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        // Replies from earlier polls can still reach the global callback
        // after a switch; Java echoes the request id so stale data is dropped
        // instead of overwriting the new provider's snapshot. The id is
        // module-unique, so a stale reply from before a remount is dropped too.
        const echoed = (data as { request_id?: unknown } | null)?.request_id;
        if (echoed != null && String(echoed) !== requestId) return;
        setState((prev) => applySnapshot(prev, parseCapacityPayload(data)));
      } catch {
        setState((prev) =>
          applySnapshot(prev, { present: false, message: 'Usage unavailable' }));
      }
    };

    w.updateClaudePlanUsage = handler;

    try {
      w.sendToJava?.(`get_claude_plan_usage:${requestId}`);
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
        // Only an actual switch clears and re-polls. The first push after
        // mount (settingsBootstrap's get_active_provider reply, ~200ms after
        // load) is not a switch: the instance is already polling with current
        // data, and clearing here would blink a visible indicator
        // (ready → idle → ready). A remount after a settings-page switch is
        // covered by the mount-time refresh, which reads the new provider.
        // Same-id re-pushes are deduped.
        if (previous !== null && previous !== provider.id) {
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
