import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHistoryLoader } from './useHistoryLoader';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('native history visibility', () => {
  it('filters guardian metadata across pages and counts only visible threads', () => {
    const history = vi.fn();
    window.setHistoryData = history;
    renderHook(() => useHistoryLoader({ currentView: 'history', currentProvider: 'codex' }));
    const deliver = (requestType: string, data: unknown[]) => act(() => {
      window.dispatchEvent(new CustomEvent('codex-native-data', { detail: { requestType, data, total: 10, nextCursor: 'next' } }));
    });
    deliver('codex_native_list_threads', [
      { id: 'user', name: 'Guardian review', source: 'exec' },
      { id: 'guardian', source: { subagent: { other: 'guardian' } } },
      { id: 'internal', source: { internal: 'guardian' } },
    ]);
    expect(history.mock.calls.at(-1)?.[0]).toMatchObject({ total: 1, sessions: [{ sessionId: 'user', title: 'Guardian review' }] });
    deliver('codex_native_list_threads_page', [
      { id: 'review', name: 'User review', source: { subagent: 'review' } },
      { id: 'guardian-source', threadSource: 'guardian_review' },
    ]);
    expect(history.mock.calls.at(-1)?.[0]).toMatchObject({ total: 2, cursor: 'next', partial: true });
  });
});
