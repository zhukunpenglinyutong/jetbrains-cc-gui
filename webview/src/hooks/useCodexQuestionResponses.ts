import { useEffect, useRef } from 'react';

interface QuestionResponseOptions {
  provider: string;
  threadId: string | null;
  enqueue: (content: string) => void;
  /** The runtime already accepted the answer, but this page can no longer send it to its chat. */
  onUndelivered: () => void;
}

/**
 * A late async answer starts a normal, tracked turn through the existing message queue.
 * Delivery errors are reported by useCodexDeliveryRecovery, which owns every Codex dialog reply.
 */
export function useCodexQuestionResponses({ provider, threadId, enqueue, onUndelivered }: QuestionResponseOptions) {
  const consumed = useRef(new Set<string>());
  useEffect(() => {
    const onResponse = (event: Event) => {
      let value: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return; }
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const result = value as Record<string, unknown>;
      const followUp = result.followUp;
      if (typeof result.interactionKey !== 'string' || result.replied !== true
          || !followUp || typeof followUp !== 'object' || Array.isArray(followUp)) return;
      const input = followUp as Record<string, unknown>;
      if (typeof input.text !== 'string' || !input.text.trim() || consumed.current.has(result.interactionKey)) return;
      consumed.current.add(result.interactionKey);
      if (consumed.current.size > 256) consumed.current.delete(consumed.current.values().next().value!);
      // The question is already closed natively, so a dropped answer would vanish without a word.
      if (provider !== 'codex' || !threadId || input.threadId !== threadId) {
        onUndelivered();
        return;
      }
      enqueue(input.text);
    };
    window.addEventListener('codex-interaction-response', onResponse);
    return () => window.removeEventListener('codex-interaction-response', onResponse);
  }, [provider, threadId, enqueue, onUndelivered]);
}
