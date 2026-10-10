import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCodexTurnActivity } from './useCodexTurnActivity';

describe('useCodexTurnActivity', () => {
  it('keeps the parent busy through a nonblocking question and a child terminal', () => {
    const { result } = renderHook(() => useCodexTurnActivity('codex', 'root'));
    const emit = (detail: Record<string, unknown>) => act(() => {
      window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail }));
    });
    emit({ kind: 'operationQueued', clientOperationId: 'op', rootThreadId: 'root' });
    emit({ kind: 'interactionRequested', payload: { params: { isBlocking: false } } });
    emit({ kind: 'orphanTurnTerminal', rootThreadId: 'root', threadId: 'child' });
    expect(result.current).toBe(true);
    emit({ kind: 'operationDone', clientOperationId: 'op', rootThreadId: 'root' });
    expect(result.current).toBe(false);
  });

  it('forgets the previous root without dropping the first native binding', () => {
    const { result, rerender } = renderHook(({ threadId }) => useCodexTurnActivity('codex', threadId), {
      initialProps: { threadId: null as string | null },
    });
    const emit = (detail: Record<string, unknown>) => act(() => {
      window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail }));
    });
    emit({ kind: 'operationQueued', clientOperationId: 'old' });
    rerender({ threadId: 'root' });
    expect(result.current).toBe(true);
    rerender({ threadId: 'other-root' });
    expect(result.current).toBe(false);
    emit({ kind: 'operationQueued', clientOperationId: 'new', rootThreadId: 'other-root' });
    emit({ kind: 'operationDone', clientOperationId: 'old', rootThreadId: 'root' });
    expect(result.current).toBe(true);
    emit({ kind: 'operationDone', clientOperationId: 'new', rootThreadId: 'other-root' });
    expect(result.current).toBe(false);
    rerender({ threadId: null });
    expect(result.current).toBe(false);
  });
});
