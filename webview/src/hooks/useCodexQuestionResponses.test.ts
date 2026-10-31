import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCodexQuestionResponses } from './useCodexQuestionResponses';

const emit = (detail: unknown) => act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail })));
const response = { replied: true, interactionKey: 'question-1', followUp: { threadId: 'thread-1', text: 'Answer: B' } };

describe('async Codex question replies', () => {
  it('queues one late answer through the normal sender, even if the acknowledgement is replayed', () => {
    const enqueue = vi.fn();
    const onUndelivered = vi.fn();
    renderHook(() => useCodexQuestionResponses({ provider: 'codex', threadId: 'thread-1', enqueue, onUndelivered }));
    emit(JSON.stringify(response));
    emit(response);
    emit({ ...response, followUp: null });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('Answer: B');
    expect(onUndelivered).not.toHaveBeenCalled();
  });

  it('never sends a late response into another thread or provider, and says the answer was not sent', () => {
    const enqueue = vi.fn();
    const onUndelivered = vi.fn();
    const { rerender } = renderHook(({ provider, threadId }) =>
      useCodexQuestionResponses({ provider, threadId, enqueue, onUndelivered }),
    { initialProps: { provider: 'codex', threadId: 'another-thread' } });
    emit(response);
    emit(response);
    rerender({ provider: 'claude', threadId: 'thread-1' });
    emit({ ...response, interactionKey: 'question-2' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(onUndelivered).toHaveBeenCalledTimes(2);
  });

  it('leaves delivery errors to the delivery recovery and ignores malformed or non-interaction acknowledgements', () => {
    const enqueue = vi.fn();
    const onUndelivered = vi.fn();
    renderHook(() => useCodexQuestionResponses({ provider: 'codex', threadId: 'thread-1', enqueue, onUndelivered }));
    for (const value of ['{', null, [], { error: 'Other operation' }, { ...response, replied: false },
      { interactionKey: 'question-1', error: 'The native runtime disconnected' },
      { ...response, followUp: { threadId: 'thread-1', text: '  ' } }]) emit(value);
    expect(onUndelivered).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
