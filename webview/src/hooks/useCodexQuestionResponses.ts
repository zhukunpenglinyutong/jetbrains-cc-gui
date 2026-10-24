import { useEffect, useRef } from 'react';

interface QuestionResponseOptions {
  provider: string;
  threadId: string | null;
  enqueue: (content: string) => void;
  onError: (message: string) => void;
}

/** A late async answer starts a normal, tracked turn through the existing message queue. */
export function useCodexQuestionResponses({ provider, threadId, enqueue, onError }: QuestionResponseOptions) {
  const consumed = useRef(new Set<string>());
  useEffect(() => {
    const onResponse = (event: Event) => {
      let value: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return; }
      }
      if (!value || typeof value !== 'object' || Array.isArray(value) || provider !== 'codex') return;
      const result = value as Record<string, unknown>;
      if (typeof result.interactionKey !== 'string') return;
      if (typeof result.error === 'string') {
        onError(result.error);
        return;
      }
      const followUp = result.followUp;
      if (result.replied !== true || !followUp || typeof followUp !== 'object' || Array.isArray(followUp)) return;
      const input = followUp as Record<string, unknown>;
      if (!threadId || input.threadId !== threadId || typeof input.text !== 'string' || !input.text.trim()
          || consumed.current.has(result.interactionKey)) return;
      consumed.current.add(result.interactionKey);
      if (consumed.current.size > 256) consumed.current.delete(consumed.current.values().next().value!);
      enqueue(input.text);
    };
    window.addEventListener('codex-interaction-response', onResponse);
    return () => window.removeEventListener('codex-interaction-response', onResponse);
  }, [provider, threadId, enqueue, onError]);
}
