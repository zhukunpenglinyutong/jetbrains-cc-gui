import { useCallback, useEffect, useRef, useState } from 'react';
import { BRIDGE_READY_EVENT } from '../utils/bridgeStartup';
import { parseCapacityPayload, type PlanUsageSnapshot } from '../utils/planUsagePace';
import {
  getLastActiveCodexProviderJson,
  subscribeActiveCodexProvider,
} from '../utils/runtimeProviderCapabilities';

export type CodexPlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: PlanUsageSnapshot | null;
};

const EMPTY: CodexPlanUsageState = { status: 'idle', snapshot: null };

// Module-level so request ids never repeat across remounts: an instance-scoped
// counter restarts at 1 and a slow in-flight reply from the previous instance
// would otherwise be accepted as the new one's own.
let requestSeq = 0;

/**
 * Apply one poll result. Until the first present payload the bar stays hidden:
 * API-key/managed Codex providers have no ChatGPT subscription quota and must
 * not show a permanent "Usage —" dash. An explicit `api_key_mode` response also
 * hides any previously displayed subscription quota.
 */
function applySnapshot(
  prev: CodexPlanUsageState,
  snap: PlanUsageSnapshot,
  reasonCode?: string,
): CodexPlanUsageState {
  if (snap.present) {
    return { status: 'ready', snapshot: snap };
  }
  if (reasonCode === 'api_key_mode' || !prev.snapshot?.present) {
    return EMPTY;
  }
  return { status: 'unavailable', snapshot: snap };
}

/**
 * Codex plan usage for ContextBar via Java bridge
 * ({@code get_codex_plan_usage} → {@code CodexSubscriptionQuotaService}
 * session {@code token_count} / {@code wham/usage} snapshot).
 */
export function useCodexPlanUsage(currentProvider: string) {
  const [state, setState] = useState<CodexPlanUsageState>(EMPTY);
  const genRef = useRef(0);
  const activeProviderIdRef = useRef<string | null>(null);

  const refresh = useCallback(() => {
    if (currentProvider !== 'codex') {
      setState(EMPTY);
      return;
    }
    const gen = ++genRef.current;
    const requestId = String(++requestSeq);
    // Keep the last data while re-polling; stay hidden until the first present payload.
    setState((prev) => (prev.snapshot?.present ? prev : EMPTY));

    const w = window as unknown as {
      updateCodexPlanUsage?: (json: string) => void;
      sendToJava?: (cmd: string) => void;
    };

    const handler = (jsonStr: string) => {
      if (gen !== genRef.current) return;
      try {
        const data = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
        const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
        const echoed = obj?.request_id;
        if (echoed != null && String(echoed) !== requestId) return;
        const reasonCode = typeof obj?.reason_code === 'string' ? obj.reason_code : undefined;
        setState((prev) => applySnapshot(prev, parseCapacityPayload(data), reasonCode));
      } catch {
        setState((prev) =>
          applySnapshot(prev, { present: false, message: 'Usage unavailable' }));
      }
    };

    w.updateCodexPlanUsage = handler;

    try {
      w.sendToJava?.(`get_codex_plan_usage:${requestId}`);
    } catch {
      if (gen === genRef.current) {
        setState((prev) =>
          applySnapshot(prev, { present: false, message: 'Usage unavailable' }));
      }
    }
  }, [currentProvider]);

  useEffect(() => {
    void refresh();
    if (currentProvider !== 'codex') {
      return () => {
        genRef.current += 1;
      };
    }
    const onBridgeReady = () => {
      void refresh();
    };
    window.addEventListener(BRIDGE_READY_EVENT, onBridgeReady);
    const id = window.setInterval(() => {
      void refresh();
    }, 120_000);
    return () => {
      window.removeEventListener(BRIDGE_READY_EVENT, onBridgeReady);
      window.clearInterval(id);
      genRef.current += 1;
    };
  }, [currentProvider, refresh]);

  // Re-poll immediately when the active Codex provider changes (e.g. CLI login ↔ managed API key).
  useEffect(() => {
    if (currentProvider !== 'codex') {
      activeProviderIdRef.current = null;
      return;
    }
    activeProviderIdRef.current = providerIdOf(getLastActiveCodexProviderJson());
    const unsubscribe = subscribeActiveCodexProvider((json) => {
      try {
        const provider = JSON.parse(json) as { id?: string };
        if (!provider?.id) return;
        const previous = activeProviderIdRef.current;
        activeProviderIdRef.current = provider.id;
        if (previous !== null && previous !== provider.id) {
          setState(EMPTY);
          void refresh();
        }
      } catch {
        // Malformed payloads are ignored; the 120s interval still polls.
      }
    });
    return unsubscribe;
  }, [currentProvider, refresh]);

  // A conversation bound to another Codex supplier changes whether subscription quota applies.
  useEffect(() => {
    if (currentProvider !== 'codex') return;
    let previous: string | null = null;
    const onSnapshot = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: string; supplierId?: string; busy?: boolean }>).detail;
      if (detail?.provider !== 'codex' || !detail.supplierId || detail.busy) return;
      const changed = previous !== null && previous !== detail.supplierId;
      previous = detail.supplierId;
      if (changed) {
        setState(EMPTY);
        void refresh();
      }
    };
    window.addEventListener('session-supplier-snapshot', onSnapshot);
    return () => window.removeEventListener('session-supplier-snapshot', onSnapshot);
  }, [currentProvider, refresh]);

  return { ...state, refresh };
}

export type UseCodexPlanUsageReturn = ReturnType<typeof useCodexPlanUsage>;

function providerIdOf(json: string | null): string | null {
  if (!json) return null;
  try {
    const id = (JSON.parse(json) as { id?: unknown } | null)?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}
