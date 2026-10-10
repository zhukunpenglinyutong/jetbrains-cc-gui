import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCodexNativeCatalog } from './useCodexNativeCatalog';

const sendBridgeEvent = vi.hoisted(() => vi.fn());
vi.mock('../utils/bridge', () => ({ sendBridgeEvent }));

describe('useCodexNativeCatalog', () => {
  afterEach(() => sendBridgeEvent.mockClear());

  it('ends loading with an error when the bridge rejects dispatch', () => {
    sendBridgeEvent.mockReturnValueOnce(false);
    const { result } = renderHook(() => useCodexNativeCatalog('codex', '', true, 'mcp'));
    expect(result.current.error).toMatch(/unavailable/);
    expect(result.current.loading).toBe(false);
  });

  it('reports a repeated native cursor instead of silently treating a partial catalog as complete', () => {
    const { result } = renderHook(() => useCodexNativeCatalog('codex', '', true, 'mcp'));
    const requestId = JSON.parse(sendBridgeEvent.mock.calls[0][1]).requestId;
    const deliver = () => act(() => window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
      requestType: 'codex_native_mcp_status', requestId, data: [], nextCursor: 'repeated',
    } })));
    deliver();
    expect(result.current.loading).toBe(true);
    deliver();
    expect(result.current.error).toMatch(/cursor/);
    expect(result.current.loading).toBe(false);
    expect(sendBridgeEvent).toHaveBeenCalledTimes(2);
  });

  it('requests native catalogs and ignores stale provider updates', () => {
    const { result } = renderHook(() => useCodexNativeCatalog('codex', 'C:/repo'));
    expect(sendBridgeEvent).toHaveBeenCalledWith('codex_native_list_models', expect.stringContaining('"cwd":"C:/repo"'));
    act(() => {
      window.dispatchEvent(new CustomEvent('codex-native-data', {
        detail: {
          requestType: 'codex_native_list_skills',
          requestId: JSON.parse(sendBridgeEvent.mock.calls.find(([type]) => type === 'codex_native_list_skills')![1]).requestId,
          data: [{ name: 'review', path: 'C:/repo/.agents/skills/review' }],
        },
      }));
    });
    expect(result.current.skills).toHaveLength(1);
    expect(result.current.models).toHaveLength(0);
  });

  it('reloads MCP through the independent native control command', () => {
    const { result } = renderHook(() => useCodexNativeCatalog('codex'));
    sendBridgeEvent.mockClear();
    act(() => result.current.reloadMcp());
    expect(sendBridgeEvent).toHaveBeenCalledWith('codex_native_mcp_reload', expect.stringContaining('"requestId"'));
  });

  it('requests only the selected catalog and coalesces cwd/skills invalidation', async () => {
    renderHook(() => useCodexNativeCatalog('codex', '', true, 'skills'));
    expect(sendBridgeEvent.mock.calls.map(([type]) => type)).toEqual(['codex_native_list_skills']);
    expect(JSON.parse(sendBridgeEvent.mock.calls[0][1]).params.forceReload).toBe(true);
    sendBridgeEvent.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('codex-working-directory-changed'));
      window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail: { payload: { method: 'skills/changed' } } }));
      await Promise.resolve();
    });
    expect(sendBridgeEvent.mock.calls.map(([type]) => type)).toEqual(['codex_native_list_skills']);
  });

  it('ignores missing request identity instead of accepting an unscoped response', () => {
    const { result } = renderHook(() => useCodexNativeCatalog('codex', '', true, 'skills'));
    act(() => window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
      requestType: 'codex_native_list_skills', data: [{ name: 'stale', path: '/stale' }],
    } })));
    expect(result.current.skills).toEqual([]);
  });

  it('ignores obsolete refreshes and flattens native per-cwd skills', () => {
    const { result } = renderHook(() => useCodexNativeCatalog('codex', 'C:/repo'));
    const oldRequest = JSON.parse(sendBridgeEvent.mock.calls.find(([type]) => type === 'codex_native_list_skills')![1]);
    act(() => result.current.refresh());
    const currentRequest = JSON.parse(sendBridgeEvent.mock.calls.filter(([type]) => type === 'codex_native_list_skills').at(-1)![1]);
    act(() => {
      window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
        requestType: 'codex_native_list_skills', requestId: oldRequest.requestId, data: [{ name: 'stale' }],
      } }));
    });
    expect(result.current.skills).toEqual([]);
    act(() => {
      window.dispatchEvent(new CustomEvent('codex-native-data', { detail: {
        requestType: 'codex_native_list_skills', requestId: currentRequest.requestId,
        data: [{ cwd: 'C:/repo', skills: [{ name: 'current', path: 'skill.md' }] }],
      } }));
    });
    expect(result.current.skills[0].name).toBe('current');
    expect(result.current.loading).toBe(true);
  });
});

