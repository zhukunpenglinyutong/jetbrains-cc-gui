import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCodexPlanState } from './useCodexPlanState';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn(() => true) }));
const originalToast = window.addToast;

afterEach(() => {
  vi.clearAllMocks();
  window.addToast = originalToast;
});

describe('useCodexPlanState', () => {
  it('keeps the current execution pending when an older chat result arrives', () => {
    const addToast = vi.fn();
    window.addToast = addToast;
    const { result, rerender } = renderHook(props => useCodexPlanState(props), {
      initialProps: { provider: 'codex', threadId: 'first-root' },
    });
    const propose = (threadId: string) => act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', {
      detail: { kind: 'planUpdated', threadId, payload: { item: { id: `plan-${threadId}`, threadId,
        text: 'Implement fixture', authoritative: true }, authoritative: true } },
    })));
    const submitted = () => JSON.parse(vi.mocked(sendBridgeEvent).mock.calls.at(-1)![1]!) as { requestId: string };
    propose('first-root');
    act(() => { expect(result.current.executePlan()).toBe(true); });
    const first = submitted();
    rerender({ provider: 'codex', threadId: 'second-root' });
    propose('second-root');
    act(() => { expect(result.current.executePlan()).toBe(true); });
    const second = submitted();
    act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: {
      requestType: 'execute_codex_plan', threadId: 'first-root', requestId: first.requestId, error: 'Earlier native failure',
    } })));
    expect(result.current.executionPending).toBe(true);
    expect(addToast).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: {
      requestType: 'execute_codex_plan', threadId: 'second-root', requestId: second.requestId, error: 'Native fixture rejection',
    } })));
    expect(result.current.executionPending).toBe(false);
    expect(addToast).toHaveBeenCalledExactlyOnceWith('Native fixture rejection', 'error');
    expect(first.requestId).not.toBe(second.requestId);
  });
  it.each([
    { kind: 'runtimeReset' },
    { kind: 'runtimeStateChanged', payload: { state: 'failed' } },
    { kind: 'operationDone', threadId: 'thread-1', turnId: 'turn-1', payload: { outcome: 'interrupted' } },
  ])('forgets plans that their native runtime has invalidated: $kind', detail => {
    const { result } = renderHook(() => useCodexPlanState({ provider: 'codex', threadId: 'thread-1' }));
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'planUpdated', threadId: 'thread-1', turnId: 'turn-1', payload: {
        item: { id: 'plan', threadId: 'thread-1', turnId: 'turn-1', text: 'plan', authoritative: true }, authoritative: true },
    } })));
    expect(result.current.plan?.id).toBe('plan');
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail })));
    expect(result.current.plan).toBeNull();
    expect(result.current.executePlan()).toBe(false);
  });

  it('retains the first plan while its native thread id binds, and drops it on a new turn', () => {
    const { result, rerender } = renderHook(props => useCodexPlanState(props), {
      initialProps: { provider: 'codex', threadId: null as string | null },
    });
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'planUpdated', threadId: 'first-root', payload: { item: {
        id: 'first-plan', threadId: 'first-root', turnId: 'planning', text: 'first plan', authoritative: true,
      }, authoritative: true },
    } })));
    rerender({ provider: 'codex', threadId: 'first-root' });
    expect(result.current.plan?.id).toBe('first-plan');
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'turnStarted', threadId: 'first-root', turnId: 'next-turn',
    } })));
    expect(result.current.plan).toBeNull();
  });

  it('replaces a streamed plan with the authoritative item and executes once', () => {
    const { result } = renderHook(() => useCodexPlanState({
      provider: 'codex',
      threadId: 'thread-1',
      cwd: '/tmp/project',
    }));
    act(() => {
      window.dispatchEvent(new CustomEvent('codex-runtime-event', {
        detail: {
          kind: 'planUpdated',
          threadId: 'thread-1',
          payload: { item: { id: 'plan-1', threadId: 'thread-1', text: 'draft' }, authoritative: false },
        },
      }));
      window.dispatchEvent(new CustomEvent('codex-runtime-event', {
        detail: {
          kind: 'planUpdated',
          threadId: 'thread-1',
          payload: {
            item: { id: 'plan-1', threadId: 'thread-1', text: 'authoritative', authoritative: true },
            authoritative: true,
          },
        },
      }));
    });
    expect(result.current.plan?.text).toBe('authoritative');
    expect(result.current.plan?.authoritative).toBe(true);
    act(() => {
      expect(result.current.executePlan()).toBe(true);
      expect(result.current.executePlan()).toBe(false);
    });
    expect(result.current.executionPending).toBe(true);
    act(() => {
      const payload = JSON.parse(vi.mocked(sendBridgeEvent).mock.calls.at(-1)![1]!);
      window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: JSON.stringify({
        requestType: 'execute_codex_plan', requestId: payload.requestId,
      }) }));
    });
    expect(result.current.executionPending).toBe(false);
  });

  it('ignores plan events from a different thread or provider', () => {
    const { result } = renderHook(() => useCodexPlanState({ provider: 'codex', threadId: 'thread-1' }));
    act(() => {
      window.dispatchEvent(new CustomEvent('codex-runtime-event', {
        detail: { kind: 'planUpdated', threadId: 'thread-2', payload: { item: { id: 'p', text: 'wrong' }, authoritative: true } },
      }));
    });
    expect(result.current.plan).toBeNull();
  });

  it('keeps a completed plan when another native root resets', () => {
    const { result } = renderHook(() => useCodexPlanState({ provider: 'codex', threadId: 'thread-1' }));
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
      kind: 'planUpdated', threadId: 'thread-1', turnId: 'turn-1', payload: {
        item: { id: 'plan', threadId: 'thread-1', turnId: 'turn-1', text: 'ready', authoritative: true }, authoritative: true },
    } })));
    act(() => {
      window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
        kind: 'operationDone', threadId: 'thread-1', turnId: 'turn-1', payload: { outcome: 'completed' },
      } }));
      window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: {
        kind: 'runtimeReset', rootThreadId: 'thread-2',
      } }));
    });
    expect(result.current.plan?.text).toBe('ready');
    act(() => { expect(result.current.executePlan()).toBe(true); });
  });
});

