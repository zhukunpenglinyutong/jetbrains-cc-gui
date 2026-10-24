import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCodexQuestionResponses } from './useCodexQuestionResponses';

const emit = (detail: unknown) => act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail })));
const response = { replied: true, interactionKey: 'question-1', followUp: { threadId: 'thread-1', text: 'Answer: B' } };

describe('async Codex question replies', () => {
  it('queues one late answer through the normal sender, even if the acknowledgement is replayed', () => {
    const enqueue = vi.fn();
    renderHook(() => useCodexQuestionResponses({ provider: 'codex', threadId: 'thread-1', enqueue, onError: vi.fn() }));
    emit(JSON.stringify(response));
    emit(response);
    emit({ ...response, followUp: null });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('Answer: B');
  });

  it('never sends a late response into another thread or provider', () => {
    const enqueue = vi.fn();
    const { rerender } = renderHook(({ provider, threadId }) =>
      useCodexQuestionResponses({ provider, threadId, enqueue, onError: vi.fn() }),
    { initialProps: { provider: 'codex', threadId: 'another-thread' } });
    emit(response);
    rerender({ provider: 'claude', threadId: 'thread-1' });
    emit(response);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports a rejected reply and ignores malformed or non-interaction acknowledgements', () => {
    const enqueue = vi.fn();
    const onError = vi.fn();
    renderHook(() => useCodexQuestionResponses({ provider: 'codex', threadId: 'thread-1', enqueue, onError }));
    for (const value of ['{', null, [], { error: 'Other operation' }, { ...response, replied: false }]) emit(value);
    emit({ interactionKey: 'question-1', error: 'The native runtime disconnected' });
    expect(onError).toHaveBeenCalledExactlyOnceWith('The native runtime disconnected');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
