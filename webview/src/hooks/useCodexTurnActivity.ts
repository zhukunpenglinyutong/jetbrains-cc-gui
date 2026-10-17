import { useEffect, useRef, useState } from 'react';

/** Keeps the native FIFO occupied while non-modal interactions remain visible. */
export function useCodexTurnActivity(provider: string, threadId: string | null) {
  const operationsRef = useRef(new Set<string>());
  const scopeRef = useRef({ provider, threadId });
  const [active, setActive] = useState(false);
  useEffect(() => {
    const previous = scopeRef.current;
    // Binding the first native id must retain the operation queued before it;
    // leaving an existing root must forget its busy state in the new chat.
    if (previous.provider !== provider || (previous.threadId && previous.threadId !== threadId)) {
      operationsRef.current.clear();
      setActive(false);
    }
    scopeRef.current = { provider, threadId };
  }, [provider, threadId]);
  useEffect(() => {
    if (provider !== 'codex') return;
    const onRuntime = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; clientOperationId?: string;
        rootThreadId?: string; payload?: { state?: string } }>).detail;
      if (!detail || (threadId && detail.rootThreadId && detail.rootThreadId !== threadId)) return;
      if (detail.kind === 'runtimeReset' || detail.payload?.state === 'failed') {
        operationsRef.current.clear();
      } else if (detail.clientOperationId && ['operationQueued', 'turnStarted'].includes(detail.kind ?? '')) {
        operationsRef.current.add(detail.clientOperationId);
      } else if (detail.kind === 'operationDone' && detail.clientOperationId) {
        operationsRef.current.delete(detail.clientOperationId);
      }
      setActive(operationsRef.current.size > 0);
    };
    window.addEventListener('codex-runtime-event', onRuntime);
    return () => window.removeEventListener('codex-runtime-event', onRuntime);
  }, [provider, threadId]);
  return active;
}
