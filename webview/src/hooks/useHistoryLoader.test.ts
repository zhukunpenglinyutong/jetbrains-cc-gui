import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryLoader } from './useHistoryLoader';
import type { HistoryData } from '../types';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(sendBridgeEvent).mockReturnValue(true);
  window.sendToJava = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  delete window.sendToJava;
});

interface CountRequest {
  requestId: string;
  threadId: string;
}

const deliver = (payload: Record<string, unknown>) => act(() => {
  window.dispatchEvent(new CustomEvent('codex-native-data', { detail: payload }));
});

const countRequests = (): CountRequest[] => vi.mocked(sendBridgeEvent).mock.calls
  .filter(([type]) => type === 'codex_native_count_thread_messages')
  .map(([, content]) => JSON.parse(content!) as CountRequest);

const countReply = (request: CountRequest, result: Record<string, unknown>) => deliver({
  requestType: 'codex_native_count_thread_messages', ...request, ...result,
});

const mountHistory = () => {
  let data: HistoryData | null = null;
  window.setHistoryData = vi.fn((update: HistoryData | ((current: HistoryData | null) => HistoryData | null)) => {
    data = typeof update === 'function' ? update(data) : update;
  });
  const hook = renderHook((options) => useHistoryLoader(options), {
    initialProps: { currentView: 'history' as 'chat' | 'history' | 'settings', currentProvider: 'codex' },
  });
  return { ...hook, get data() { return data; }, replace: (next: HistoryData) => { data = next; } };
};

describe('native history visibility', () => {
  it('filters guardian metadata and sums message counts across overlapping thread pages', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', nextCursor: 'next', data: [
      { id: 'user', name: 'Guardian review', source: 'exec', messageCount: 3 },
      { id: 'guardian', source: { subagent: { other: 'guardian' } } },
      { id: 'internal', source: { internal: 'guardian' } },
    ] });
    expect(history.data).toMatchObject({ total: 3, sessions: [{ sessionId: 'user', title: 'Guardian review' }] });
    deliver({ requestType: 'codex_native_list_threads_page', nextCursor: null, data: [
      { id: 'user', name: 'Guardian review', source: 'exec', messageCount: 3 },
      { id: 'review', name: 'User review', source: { subagent: 'review' }, messageCount: 5 },
      { id: 'guardian-source', threadSource: 'guardian_review' },
    ] });
    expect(history.data).toMatchObject({ total: 8, cursor: null, partial: false });
    expect(history.data?.sessions).toHaveLength(2);
    expect(countRequests()).toHaveLength(0);
  });

  it('shows native metadata immediately and fills real counts including a confirmed zero', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [
      { id: 'empty', name: 'Empty', turns: [], updatedAt: 1 },
      { id: 'saved', name: 'Saved', turns: [], updatedAt: 2 },
    ], nextCursor: 'opaque:next' });
    expect(history.data?.sessions).toHaveLength(2);
    expect(history.data?.sessions?.every(session => session.messageCount === undefined)).toBe(true);
    expect(history.data?.total).toBeUndefined();
    const requests = countRequests();
    expect(requests.map(request => request.threadId)).toEqual(['empty', 'saved']);
    countReply(requests[0], { messageCount: 0 });
    expect(history.data?.sessions?.[0].messageCount).toBe(0);
    expect(history.data?.total).toBeUndefined();
    countReply(requests[1], { messageCount: 12 });
    expect(history.data).toMatchObject({ total: 12, cursor: 'opaque:next', partial: true });
    expect(history.data?.sessions?.map(session => session.messageCount)).toEqual([0, 12]);
  });

  it('limits count requests and keeps failures unknown while continuing queued rows', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: Array.from({ length: 6 }, (_, index) => ({ id: `thread-${index}` })) });
    expect(countRequests()).toHaveLength(4);
    countReply(countRequests()[0], { error: 'Native history unavailable' });
    expect(countRequests()).toHaveLength(5);
    expect(history.data?.sessions?.[0].messageCount).toBeUndefined();
    expect(history.data?.total).toBeUndefined();
    act(() => { vi.advanceTimersByTime(125_000); });
    expect(countRequests()).toHaveLength(6);
    countReply(countRequests()[1], { messageCount: 99 });
    expect(history.data?.sessions?.[1].messageCount).toBeUndefined();
  });

  it('ignores foreign count requests and stale counts after the same row has refreshed', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [{ id: 'saved', updatedAt: 1 }] });
    const oldRequest = countRequests()[0];
    countReply({ ...oldRequest, requestId: 'foreign' }, { messageCount: 99 });
    expect(history.data?.total).toBeUndefined();
    deliver({ requestType: 'codex_native_list_threads', data: [{ id: 'saved', updatedAt: 2 }] });
    countReply(oldRequest, { messageCount: 99 });
    expect(history.data?.total).toBeUndefined();
    countReply(countRequests()[1], { messageCount: 7 });
    expect(history.data?.total).toBe(7);
  });

  it('keeps unknown counts when metadata or count replies contain invalid numbers', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [{ id: 'saved', messageCount: -1 }] });
    countReply(countRequests()[0], { messageCount: Number.NaN });
    expect(history.data?.sessions?.[0].messageCount).toBeUndefined();
    expect(history.data?.total).toBeUndefined();
  });

  it('cannot restore deleted rows or overwrite a later legacy list with late count replies', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [{ id: 'deleted' }, { id: 'legacy' }] });
    const requests = countRequests();
    history.replace({ ...history.data!, sessions: history.data!.sessions!.filter(session => session.sessionId !== 'deleted') });
    countReply(requests[0], { messageCount: 9 });
    expect(history.data?.sessions?.map(session => session.sessionId)).toEqual(['legacy']);
    const legacy: HistoryData = { success: true, source: 'legacy', sessions: [{ sessionId: 'legacy', title: 'Legacy', messageCount: 2 }], total: 2 };
    history.replace(legacy);
    countReply(requests[1], { messageCount: 99 });
    expect(history.data).toBe(legacy);
  });

  it('fills a count without replacing titles or favorite changes made while it was pending', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [{ id: 'saved', name: 'Original', updatedAt: 1 }] });
    history.replace({ ...history.data!, sessions: [{ ...history.data!.sessions![0], title: 'Renamed', isFavorited: true }] });
    countReply(countRequests()[0], { messageCount: 7 });
    expect(history.data).toMatchObject({ total: 7, sessions: [{ title: 'Renamed', isFavorited: true, messageCount: 7 }] });
  });

  it('keeps deleted rows and local title and favorite edits intact when another page arrives', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [
      { id: 'deleted', updatedAt: 1, messageCount: 3 },
      { id: 'saved', name: 'Original', updatedAt: 1, messageCount: 4 },
    ] });
    history.replace({ ...history.data!, total: 4, sessions: [
      { ...history.data!.sessions![1], title: 'Renamed', isFavorited: true, favoritedAt: 123 },
    ] });
    deliver({ requestType: 'codex_native_list_threads_page', data: [
      { id: 'deleted', updatedAt: 1, messageCount: 3 },
      { id: 'saved', name: 'Original', updatedAt: 1, messageCount: 4 },
      { id: 'older', updatedAt: 0, messageCount: 2 },
    ] });
    expect(history.data).toMatchObject({ total: 6, sessions: [
      { sessionId: 'saved', title: 'Renamed', isFavorited: true, favoritedAt: 123 },
      { sessionId: 'older' },
    ] });
    expect(history.data?.sessions).toHaveLength(2);
  });

  it('reuses a pending count across overlapping pages with the same metadata', () => {
    const history = mountHistory();
    const data = Array.from({ length: 4 }, (_, index) => ({ id: `saved-${index}`, updatedAt: 1 }));
    deliver({ requestType: 'codex_native_list_threads', data });
    const requests = countRequests();
    deliver({ requestType: 'codex_native_list_threads_page', data });
    countReply(requests[0], { messageCount: 7 });
    expect(history.data?.sessions?.[0].messageCount).toBe(7);
    expect(countRequests()).toHaveLength(4);
  });

  it('recounts changed native metadata and expires counts even when the timestamp stays the same', () => {
    const history = mountHistory();
    const row = { id: 'saved', updatedAt: 1, path: 'old', historyMode: 'default', status: { type: 'idle' } };
    deliver({ requestType: 'codex_native_list_threads', data: [row] });
    countReply(countRequests()[0], { messageCount: 7 });
    deliver({ requestType: 'codex_native_list_threads_page', data: [{ ...row, path: 'new' }] });
    expect(history.data?.total).toBeUndefined();
    expect(countRequests()).toHaveLength(2);
    countReply(countRequests()[1], { messageCount: 9 });
    act(() => { vi.advanceTimersByTime(60_001); });
    deliver({ requestType: 'codex_native_list_threads_page', data: [{ ...row, path: 'new' }] });
    expect(history.data?.total).toBeUndefined();
    expect(countRequests()).toHaveLength(3);
  });

  it('cannot replace a legacy fallback with an outstanding native page', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [{ id: 'saved' }] });
    deliver({ requestType: 'codex_native_list_threads_page', error: 'Codex runtime access is inactive' });
    const legacy: HistoryData = { success: true, source: 'legacy', sessions: [{ sessionId: 'legacy', title: 'Legacy', messageCount: 2 }], total: 2 };
    history.replace(legacy);
    deliver({ requestType: 'codex_native_list_threads_page', data: [{ id: 'late-native' }] });
    expect(history.data).toBe(legacy);
  });

  it('cancels counts when native history falls back and when the view changes', () => {
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [{ id: 'saved' }] });
    const request = countRequests()[0];
    deliver({ requestType: 'codex_native_list_threads', error: 'Codex runtime access is inactive' });
    expect(sendBridgeEvent).toHaveBeenCalledWith('load_history_data', 'codex');
    const before = history.data;
    countReply(request, { messageCount: 99 });
    expect(history.data).toBe(before);
    history.rerender({ currentView: 'chat', currentProvider: 'codex' });
    const requestsBefore = countRequests().length;
    act(() => { vi.advanceTimersByTime(125_000); });
    expect(countRequests()).toHaveLength(requestsBefore);
  });

  it('does not invent zero counts when the bridge cannot dispatch a count', () => {
    vi.mocked(sendBridgeEvent).mockReturnValue(false);
    const history = mountHistory();
    deliver({ requestType: 'codex_native_list_threads', data: [{ id: 'saved' }] });
    expect(history.data?.sessions?.[0].messageCount).toBeUndefined();
    expect(history.data?.total).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
  });
});
