import { useCallback, useEffect, useRef, useState } from 'react';
import { CodexStorageError, storageRequest } from './codexStorageBridge';
import type { CodexStorageMutationStatus } from './codexStorageBridge';

/** Poll admission without rescanning rollouts or depending on the visible session page. */
export function useCodexStorageMutationStatus(enabled = true) {
  const [status, setStatus] = useState<CodexStorageMutationStatus | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const inFlight = useRef<Promise<CodexStorageMutationStatus> | null>(null);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!inFlight.current) {
      inFlight.current = storageRequest('get_ai_storage_mutation_status').catch((cause: unknown): CodexStorageMutationStatus => {
        const code = cause instanceof CodexStorageError ? cause.code : 'STORAGE_OPERATION_FAILED';
        return { available: false, unavailableReason: code, deletionAvailable: false, deletionUnavailableReason: code,
          runningSessionIds: [], writerSessionIds: [] };
      }).finally(() => { inFlight.current = null; });
    }
    const result = await inFlight.current;
    if (mounted.current && request === generation.current) setStatus(result);
    return result;
  }, []);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(() => { void poll(); }, 2000);
    };
    if (enabled) void poll();
    else setStatus(null);
    return () => { stopped = true; mounted.current = false; generation.current++; clearTimeout(timer); };
  }, [enabled, refresh]);

  return { status, refresh };
}
