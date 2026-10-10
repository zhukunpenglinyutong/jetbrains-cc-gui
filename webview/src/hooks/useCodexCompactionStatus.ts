import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage } from '../types';
import { sendBridgeEvent } from '../utils/bridge';

interface CompactionOptions {
  provider: string;
  threadId: string | null;
  t: TFunction;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
}

/** Manual compaction owns the same waiting state as a submitted message. */
export function useCodexCompactionStatus({
  provider, threadId, t, setMessages, setLoading, setLoadingStartTime,
}: CompactionOptions) {
  const pendingRequest = useRef<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const pending = startedAt !== null;

  const finish = useCallback((error?: string) => {
    pendingRequest.current = null;
    setStartedAt(null);
    setLoading(false);
    setLoadingStartTime(null);
    if (error) {
      setMessages(messages => [...messages, {
        type: 'error', content: error, timestamp: new Date().toISOString(),
      }]);
    }
  }, [setLoading, setLoadingStartTime, setMessages]);

  useEffect(() => {
    // A completion in the previous chat must not unlock a new submission.
    pendingRequest.current = null;
    setStartedAt(null);
  }, [provider, threadId]);

  useEffect(() => {
    if (provider !== 'codex') return;
    const onResponse = (event: Event) => {
      let result: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof result === 'string') {
        try { result = JSON.parse(result); } catch { return; }
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) return;
      const response = result as Record<string, unknown>;
      if (!pendingRequest.current || response.requestType !== 'codex_compact'
          || response.requestId !== pendingRequest.current
          // Java omits null fields on the wire; a threadless session's echo
          // arrives as undefined and must still match the page's null.
          || (response.threadId ?? null) !== threadId) return;
      if (response.outcome === 'interrupted' || response.outcome === 'cancelled'
          || response.success === true && !response.error) {
        finish();
        return;
      }
      const reason = typeof response.error === 'string' ? response.error : '';
      const label = t('chat.compactSummary.nativeFailed');
      const explanation = reason.includes('already has an active writer') || reason.includes('already has a live local writer')
        || reason.includes('already owned by another')
        ? t('chat.compactSummary.writerOccupied') : reason;
      finish(response.errorReported === true ? undefined : explanation ? `${label}: ${explanation}` : label);
    };
    window.addEventListener('codex-interaction-response', onResponse);
    return () => window.removeEventListener('codex-interaction-response', onResponse);
  }, [provider, threadId, t, finish]);

  const startCompaction = useCallback(() => {
    if (provider !== 'codex' || pendingRequest.current) return;
    const requestId = `compact-${crypto.randomUUID()}`;
    pendingRequest.current = requestId;
    const startTime = Date.now();
    setStartedAt(startTime);
    setLoading(true);
    setLoadingStartTime(startTime);
    // Install ownership before dispatch: an immediate rejection is terminal too.
    if (!sendBridgeEvent('codex_compact', JSON.stringify({ requestId, threadId }))) {
      finish(t('chat.bridgeUnavailable', { defaultValue: 'Bridge is not available right now' }));
    }
  }, [provider, threadId, t, finish, setLoading, setLoadingStartTime]);

  return { pending, startedAt, startCompaction };
}
