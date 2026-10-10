import { act, renderHook } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { useCodexCompactionStatus } from './useCodexCompactionStatus';

describe('Codex manual compaction waiting state', () => {
  const t = ((key: string) => key) as TFunction;
  const options = () => ({
    provider: 'codex', threadId: 'root' as string | null, t, loading: false,
    setMessages: vi.fn(), setLoading: vi.fn(), setLoadingStartTime: vi.fn(),
  });
  const emit = (detail: unknown) => act(() => {
    window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail }));
  });
  const submitted = () => JSON.parse(vi.mocked(window.sendToJava!).mock.calls.at(-1)![0].slice('codex_compact:'.length));
  beforeEach(() => { window.sendToJava = vi.fn(); });
  afterEach(() => { delete window.sendToJava; });

  it('waits before dispatch, sends once and finishes only on the matching terminal', () => {
    const opts = options();
    const { result } = renderHook(() => useCodexCompactionStatus(opts));
    act(() => { result.current.startCompaction(); result.current.startCompaction(); });
    expect(result.current.pending).toBe(true);
    expect(opts.setLoading).toHaveBeenCalledWith(true);
    expect(opts.setLoadingStartTime).toHaveBeenCalledWith(expect.any(Number));
    expect(opts.setLoading.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(window.sendToJava!).mock.invocationCallOrder[0]);
    expect(window.sendToJava).toHaveBeenCalledOnce();
    const response = { ...submitted(), requestType: 'codex_compact', success: true };
    emit({ ...response, requestId: 'older-request' });
    emit({ ...response, threadId: 'other-root' });
    emit({ ...response, requestType: 'execute_codex_plan' });
    expect(result.current.pending).toBe(true);
    emit(JSON.stringify(response));
    emit(response);
    expect(result.current.pending).toBe(false);
    expect(opts.setLoading).toHaveBeenLastCalledWith(false);
    expect(opts.setLoadingStartTime).toHaveBeenLastCalledWith(null);
    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it('unlocks a threadless session whose echo arrives without a threadId', () => {
    // Java omits null JSON fields, so a session without a thread echoes no
    // threadId at all; that must still match the page's null.
    const opts = { ...options(), threadId: null };
    const { result } = renderHook(() => useCodexCompactionStatus(opts));
    act(() => result.current.startCompaction());
    expect(result.current.pending).toBe(true);
    emit({ requestId: submitted().requestId, requestType: 'codex_compact', success: true });
    expect(result.current.pending).toBe(false);
    expect(opts.setLoading).toHaveBeenLastCalledWith(false);
    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it('retains compaction ownership without rewriting loading after native cleanup', () => {
    const opts = options();
    const { result, rerender } = renderHook(() => useCodexCompactionStatus(opts), {
      initialProps: { loading: true },
    });
    act(() => result.current.startCompaction());
    const startedAt = result.current.startedAt;
    expect(startedAt).toEqual(expect.any(Number));
    opts.setLoading.mockClear();
    rerender({ loading: false });
    expect(opts.setLoading).not.toHaveBeenCalled();
    expect(result.current.pending).toBe(true);
    expect(result.current.startedAt).toBe(startedAt);
    emit({ ...submitted(), requestType: 'codex_compact', success: true });
    expect(result.current.startedAt).toBeNull();
  });

  it('cannot rearm loading from an earlier cleanup render after the writer error finishes', () => {
    const opts = options();
    const { result } = renderHook(() => {
      const [loading, setLoading] = useState(false);
      const [started, setStarted] = useState<number | null>(null);
      const rejectAfterCleanup = useRef(false);
      const compact = useCodexCompactionStatus({ ...opts, setLoading, setLoadingStartTime: setStarted });
      useLayoutEffect(() => {
        if (!loading && rejectAfterCleanup.current) {
          rejectAfterCleanup.current = false;
          window.dispatchEvent(new CustomEvent('codex-interaction-response', {
            detail: { ...submitted(), requestType: 'codex_compact', success: false,
              error: 'thread root already has an active writer' },
          }));
        }
      }, [loading]);
      return { ...compact, loading, started, cleanup: () => {
        rejectAfterCleanup.current = true;
        setLoading(false);
      } };
    });
    act(() => result.current.startCompaction());
    expect(result.current.loading).toBe(true);
    act(() => result.current.cleanup());
    expect(result.current.pending).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.started).toBeNull();
    expect(opts.setMessages).toHaveBeenCalledOnce();
  });

  it.each(['interrupted', 'cancelled'])('waits for the actual compact stop terminal: %s', outcome => {
    const opts = options();
    const { result } = renderHook(() => useCodexCompactionStatus(opts));
    act(() => result.current.startCompaction());
    expect(result.current.pending).toBe(true);
    emit({ ...submitted(), requestType: 'codex_compact', outcome, success: false, error: 'compact failed' });
    expect(result.current.pending).toBe(false);
    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it.each(['an active writer', 'a live local writer'])('shows writer occupancy inside the conversation: %s', writer => {
    const opts = options();
    const { result } = renderHook(() => useCodexCompactionStatus(opts));
    act(() => result.current.startCompaction());
    const response = { ...submitted(), requestType: 'codex_compact', success: false,
      error: `java.lang.RuntimeException: thread root already has ${writer}` };
    emit(response); emit(response);
    expect(result.current.pending).toBe(false);
    expect(opts.setMessages).toHaveBeenCalledOnce();
    expect(opts.setMessages.mock.calls[0][0]([])).toEqual([
      expect.objectContaining({ type: 'error',
        content: 'chat.compactSummary.nativeFailed: chat.compactSummary.writerOccupied' }),
    ]);
  });

  it('does not duplicate an error already delivered through the native callback', () => {
    const opts = options();
    const { result } = renderHook(() => useCodexCompactionStatus(opts));
    act(() => result.current.startCompaction());
    emit({ ...submitted(), requestType: 'codex_compact', success: false, error: 'native error', errorReported: true });
    expect(result.current.pending).toBe(false);
    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it('captures an immediate bridge rejection and releases the wait', () => {
    const opts = options();
    const { result } = renderHook(() => useCodexCompactionStatus(opts));
    window.sendToJava = vi.fn(message => {
      window.dispatchEvent(new CustomEvent('codex-interaction-response', {
        detail: { ...JSON.parse(message.slice('codex_compact:'.length)), requestType: 'codex_compact', success: false },
      }));
    });
    act(() => result.current.startCompaction());
    expect(result.current.pending).toBe(false);
    expect(opts.setLoading).toHaveBeenLastCalledWith(false);
    expect(opts.setMessages).toHaveBeenCalledOnce();
  });

  it('releases the wait and reports a missing bridge inside the conversation', () => {
    delete window.sendToJava;
    const opts = options();
    const { result } = renderHook(() => useCodexCompactionStatus(opts));
    act(() => result.current.startCompaction());
    expect(result.current.pending).toBe(false);
    expect(opts.setLoading).toHaveBeenLastCalledWith(false);
    expect(opts.setMessages.mock.calls[0][0]([])[0].type).toBe('error');
  });

  it('ignores malformed and previous-chat replies without unlocking a newer request', () => {
    const opts = options();
    const { result, rerender } = renderHook(({ provider, threadId }) =>
      useCodexCompactionStatus({ ...opts, provider, threadId }), {
      initialProps: { provider: 'codex', threadId: 'root' as string | null },
    });
    act(() => result.current.startCompaction());
    const old = submitted();
    rerender({ provider: 'codex', threadId: 'other' });
    act(() => result.current.startCompaction());
    emit('bad json'); emit('null'); emit(42);
    emit({ ...old, requestType: 'codex_compact', success: true });
    expect(result.current.pending).toBe(true);
    rerender({ provider: 'claude', threadId: null });
    act(() => result.current.startCompaction());
    expect(window.sendToJava).toHaveBeenCalledTimes(2);
    expect(opts.setMessages).not.toHaveBeenCalled();
  });
});
