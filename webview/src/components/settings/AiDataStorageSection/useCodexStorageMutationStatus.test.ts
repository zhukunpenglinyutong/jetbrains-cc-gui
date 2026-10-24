import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexStorageMutationStatus } from './codexStorageBridge';
import { storageRequest } from './codexStorageBridge';
import { useCodexStorageMutationStatus } from './useCodexStorageMutationStatus';

vi.mock('./codexStorageBridge', () => ({
  storageRequest: vi.fn(),
  CodexStorageError: class extends Error { code = 'STORAGE_RESPONSE_TIMEOUT'; },
}));

const idle: CodexStorageMutationStatus = { available: true, deletionAvailable: true, runningSessionIds: [], writerSessionIds: [] };
const busy: CodexStorageMutationStatus = { ...idle, available: false, unavailableReason: 'SESSION_RUNNING', runningSessionIds: ['target'] };

beforeEach(() => { vi.useFakeTimers(); vi.mocked(storageRequest).mockReset().mockResolvedValue(idle); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Codex live activity polling', () => {
  it('starts only when enabled and forgets activity when disabled', async () => {
    const { result, rerender } = renderHook(({ enabled }) => useCodexStorageMutationStatus(enabled), { initialProps: { enabled: false } });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(storageRequest).not.toHaveBeenCalled();
    vi.mocked(storageRequest).mockResolvedValue(busy);
    await act(async () => { rerender({ enabled: true }); });
    expect(result.current.status?.runningSessionIds).toEqual(['target']);
    rerender({ enabled: false });
    expect(result.current.status).toBeNull();
    const calls = vi.mocked(storageRequest).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(storageRequest).toHaveBeenCalledTimes(calls);
  });

  it('observes completion without reloading history and stops polling after unmount', async () => {
    vi.mocked(storageRequest).mockResolvedValueOnce(busy).mockResolvedValue(idle);
    const { result, unmount } = renderHook(() => useCodexStorageMutationStatus());
    await act(async () => {});
    expect(result.current.status?.runningSessionIds).toEqual(['target']);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.status).toEqual(idle);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(storageRequest).toHaveBeenCalledTimes(2);
  });

  it('discards an in-flight response when disabled', async () => {
    let complete!: (status: CodexStorageMutationStatus) => void;
    vi.mocked(storageRequest).mockReturnValue(new Promise<CodexStorageMutationStatus>(resolve => { complete = resolve; }));
    const { result, rerender } = renderHook(({ enabled }) => useCodexStorageMutationStatus(enabled), { initialProps: { enabled: true } });
    rerender({ enabled: false });
    await act(async () => { complete(busy); });
    expect(result.current.status).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(storageRequest).toHaveBeenCalledTimes(1);
  });
});
