import { useCallback, useEffect, useRef, useState } from 'react';
import { sendBridgeEvent } from '../utils/bridge';

export interface CodexPlanItem {
  id: string;
  threadId: string;
  turnId?: string | null;
  text: string;
  status?: string | null;
  authoritative?: boolean;
}

interface CodexRuntimeEvent {
  kind?: string;
  threadId?: string | null;
  turnId?: string | null;
  rootThreadId?: string | null;
  payload?: { item?: CodexPlanItem; authoritative?: boolean; state?: string; outcome?: string };
}

interface CodexPlanStateOptions {
  provider: string;
  threadId: string | null;
  cwd?: string;
  turnActive?: boolean;
}

/** Tracks the current native plan item independently from turn/plan TODOs. */
export function useCodexPlanState({ provider, threadId, cwd = '', turnActive = false }: CodexPlanStateOptions) {
  const [plan, setPlan] = useState<CodexPlanItem | null>(null);
  const [executionPending, setExecutionPending] = useState(false);
  const executionPendingRef = useRef<string | null>(null);

  useEffect(() => {
    // Binding the first native root can share a React batch with its plan.
    setPlan(current => provider === 'codex' && current?.threadId === threadId ? current : null);
    executionPendingRef.current = null;
    setExecutionPending(false);
  }, [provider, threadId]);

  useEffect(() => {
    const handleRuntimeEvent = (event: Event) => {
      if (provider !== 'codex') return;
      const detail = (event as CustomEvent<CodexRuntimeEvent>).detail;
      if (threadId && detail?.rootThreadId && detail.rootThreadId !== threadId) return;
      if (detail?.kind === 'runtimeReset' || detail?.kind === 'runtimeStateChanged' && detail.payload?.state === 'failed') {
        setPlan(null);
      } else if (detail?.kind === 'operationDone' && detail.threadId === threadId
        && ['failed', 'interrupted', 'cancelled'].includes(detail.payload?.outcome ?? '')) {
        setPlan(current => current?.turnId === detail.turnId ? null : current);
      }
      if (detail?.kind === 'turnStarted') {
        setPlan(current => current && current.threadId === detail.threadId && current.turnId !== detail.turnId ? null : current);
        return;
      }
      if (!detail || detail.kind !== 'planUpdated' || !detail.payload?.item) return;
      if (threadId && detail.threadId && detail.threadId !== threadId) return;
      const item = detail.payload.item;
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      const resolvedThreadId = detail.threadId ?? item.threadId;
      if (!item.id || !text || !resolvedThreadId) return;
      setPlan({
        ...item,
        threadId: resolvedThreadId,
        text,
        authoritative: detail.payload.authoritative === true || item.authoritative === true,
      });
    };
    const handleCommandResult = (event: Event) => {
      if (!executionPendingRef.current) return;
      const detail = (event as CustomEvent<string | Record<string, unknown>>).detail;
      let result: Record<string, unknown> = {};
      if (typeof detail === 'string') {
        try { result = JSON.parse(detail) as Record<string, unknown>; } catch { return; }
      } else if (detail && typeof detail === 'object') {
        result = detail;
      }
      if (result.requestType !== 'execute_codex_plan' || result.requestId !== executionPendingRef.current) return;
      executionPendingRef.current = null;
      setExecutionPending(false);
      if (typeof result.error === 'string' && result.error) window.addToast?.(result.error, 'error');
    };
    window.addEventListener('codex-runtime-event', handleRuntimeEvent);
    window.addEventListener('codex-interaction-response', handleCommandResult);
    return () => {
      window.removeEventListener('codex-runtime-event', handleRuntimeEvent);
      window.removeEventListener('codex-interaction-response', handleCommandResult);
    };
  }, [provider, threadId]);

  const executePlan = useCallback(() => {
    if (provider !== 'codex' || !threadId || !plan?.authoritative || executionPendingRef.current || turnActive) {
      return false;
    }
    const requestId = `execute-plan-${crypto.randomUUID()}`;
    const sent = sendBridgeEvent('execute_codex_plan', JSON.stringify({
      requestId,
      threadId,
      cwd,
      planItemId: plan.id,
      planText: plan.text,
    }));
    if (!sent) return false;
    executionPendingRef.current = requestId;
    setExecutionPending(true);
    return true;
  }, [cwd, plan, provider, threadId, turnActive]);

  return { plan, executionPending, executePlan };
}

