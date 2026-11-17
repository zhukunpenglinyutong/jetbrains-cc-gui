import { useCallback, useEffect, useRef, useState } from 'react';
import { parseCapacityPayload, type PlanUsageSnapshot } from '../utils/planUsagePace';

export type GeminiPlanUsageState = {
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  snapshot: PlanUsageSnapshot | null;
};

const EMPTY: GeminiPlanUsageState = { status: 'idle', snapshot: null };

/**
 * Apply one poll result. Until the first present payload the bar stays hidden:
 * backends without quota data (CLI absent, not logged in, probe errors) would
 * otherwise show a permanent "Usage —" dash.
 */
function applySnapshot(
  prev: GeminiPlanUsageState,
  snap: PlanUsageSnapshot,
): GeminiPlanUsageState {
  if (snap.present) {
    return { status: 'ready', snapshot: snap };
  }
  if (!prev.snapshot?.present) {
    return EMPTY;
  }
  return { status: 'unavailable', snapshot: snap };
}

/**
 * Gemini (Antigravity CLI) plan usage for ContextBar via the Java bridge
 * ({@code get_gemini_plan_usage:<slug>} → zero-cost {@code agy -p "/usage"}
 * probe resolved for the selected model's billing family). The selected model
 * slug rides the poll so the Java cache keys the snapshot by billing family
 * and a family switch re-probes instead of serving the other family's quota.
 */
export function useGeminiPlanUsage(currentProvider: string, selectedModel?: string) {
  const [state, setState] = useState<GeminiPlanUsageState>(EMPTY);
  const genRef = useRef(0);
  const handlerRef = useRef<((json: string) => void) | null>(null);

  const refresh = useCallback(() => {
    if (currentProvider !== 'gemini') {
      setState(EMPTY);
      return;
    }
    const gen = ++genRef.current;
    // Keep the last data while re-polling; stay hidden until the first payload.
    setState((prev) => (prev.snapshot?.present ? prev : EMPTY));

    const w = window as unknown as {
      updateGeminiPlanUsage?: (json: string) => void;
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
    w.updateGeminiPlanUsage = (json: string) => {
      if (handlerRef.current) {
        handlerRef.current(json);
      }
    };

    try {
      w.sendToJava?.(`get_gemini_plan_usage:${selectedModel ?? ''}`);
    } catch {
      if (gen === genRef.current) {
        setState((prev) =>
          applySnapshot(prev, { present: false, message: 'Usage unavailable' }));
      }
    }
  }, [currentProvider, selectedModel]);

  useEffect(() => {
    void refresh();
    if (currentProvider !== 'gemini') {
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

  return { ...state, refresh };
}

export type UseGeminiPlanUsageReturn = ReturnType<typeof useGeminiPlanUsage>;
