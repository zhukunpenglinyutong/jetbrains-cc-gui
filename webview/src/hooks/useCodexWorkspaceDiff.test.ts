import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useCodexWorkspaceDiff } from './useCodexWorkspaceDiff';

const emitDiff = (detail: unknown) => act(() => {
  window.dispatchEvent(new CustomEvent('codex-workspace-diff', { detail }));
});

describe('useCodexWorkspaceDiff', () => {
  it('opens with every pushed snapshot and closes on demand', () => {
    const { result } = renderHook(() => useCodexWorkspaceDiff());
    expect(result.current.open).toBe(false);

    const snapshot = { cwd: '/repo', repository: true, root: '/repo', staged: '', unstaged: '', untracked: [] };
    emitDiff(snapshot);
    expect(result.current.open).toBe(true);
    expect(result.current.result).toEqual(snapshot);

    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.result).toEqual(snapshot);

    emitDiff({ cwd: '/repo', repository: false, error: 'no git' });
    expect(result.current.open).toBe(true);
    expect(result.current.result).toEqual({ cwd: '/repo', repository: false, error: 'no git' });
  });

  it('ignores malformed payloads and unsubscribes on unmount', () => {
    const { result, unmount } = renderHook(() => useCodexWorkspaceDiff());
    emitDiff(undefined);
    emitDiff('not-an-object');
    expect(result.current.open).toBe(false);
    expect(result.current.result).toBeNull();

    unmount();
    const spy = vi.fn();
    window.addEventListener('codex-workspace-diff', spy);
    emitDiff({ repository: true });
    expect(spy).toHaveBeenCalled();
    expect(result.current.open).toBe(false);
    window.removeEventListener('codex-workspace-diff', spy);
  });

  it('refresh re-requests the workspace diff through the bridge', () => {
    const original = window.sendToJava;
    const sendToJava = vi.fn();
    window.sendToJava = sendToJava;
    try {
      const { result } = renderHook(() => useCodexWorkspaceDiff());
      act(() => result.current.refresh());
      expect(sendToJava).toHaveBeenCalledWith('codex_read_workspace_diff:{}');
    } finally {
      window.sendToJava = original;
    }
  });
});
