import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookItem, HookSourcePayload } from '../../../types/hooks';
import { EMPTY_HOOK_CATALOG } from '../../../types/hooks';
import { useHookManagement, type UseHookManagementReturn } from './useHookManagement';

const item: HookItem = {
  sourceId: 'claude-global', provider: 'claude', scope: 'GLOBAL', event: 'Stop',
  command: 'echo ready', enabled: true, toggleSupported: false, managedToggleSupported: true,
  rawLocation: 'C:/fixture/.claude/settings.json', schemaVersion: 1, format: 'claude-settings-json',
  revision: '1:1', validationIssues: [], extensions: {},
};
const other: HookItem = { ...item, sourceId: 'project', scope: 'PROJECT', rawLocation: 'C:/project/.claude/settings.json' };
type Result = { current: UseHookManagementReturn };
function request(command: string): Record<string, string> {
  const call = [...vi.mocked(window.sendToJava!).mock.calls].reverse().find(([text]) => text.startsWith(`${command}:`));
  if (!call) throw new Error(`Missing ${command}`);
  return JSON.parse(call[0].slice(command.length + 1)) as Record<string, string>;
}
function sourceResponse(result: Result, fields: Partial<HookSourcePayload> = {}) {
  const pending = request('get_hook_source');
  act(() => result.current.updateHookSource({ success: true, requestId: pending.requestId,
    location: pending.location, revision: '1:1', content: 'echo ready', ...fields }));
}
function open(result: Result, target = item, content = 'echo ready') {
  act(() => result.current.loadHookSource(target));
  sourceResponse(result, { content });
}
function mutationResponse(result: Result, fields: Partial<HookSourcePayload> = {}) {
  const pending = request('save_hook_source');
  act(() => result.current.updateHookMutationResult({ success: true, requestId: pending.requestId,
    location: pending.location, revision: '2:2', content: pending.content, ...fields }));
}

describe('useHookManagement correlated source operations', () => {
  beforeEach(() => { vi.useFakeTimers(); window.sendToJava = vi.fn(() => true); });
  afterEach(() => { vi.useRealTimers(); window.sendToJava = undefined; });

  it('reloads the current source against a revision conflict', () => {
    const { result } = renderHook(useHookManagement);
    open(result);
    act(() => result.current.saveHookSource('edited'));
    mutationResponse(result, { success: false, errorCode: 'HOOK_REVISION_CONFLICT' });
    expect(result.current.mutationError).toBe('HOOK_REVISION_CONFLICT');
    act(() => result.current.reloadHookSource());
    expect(result.current.sourceLoading).toBe(true);
    expect(result.current.mutationError).toBe('HOOK_REVISION_CONFLICT');
    sourceResponse(result, { content: 'external edit', revision: '3:3' });
    expect(result.current.editor?.content).toBe('external edit');
    expect(result.current.mutationError).toBeNull();
  });

  it('keeps the previous source after a failed reload', () => {
    const { result } = renderHook(useHookManagement);
    open(result);
    act(() => result.current.reloadHookSource());
    sourceResponse(result, { success: false, errorCode: 'READ_FAILED' });
    expect(result.current.editor?.content).toBe('echo ready');
    expect(result.current.sourceError).toBe('READ_FAILED');
  });

  it('keeps the editor unavailable after the initial read fails', () => {
    const { result } = renderHook(useHookManagement);
    act(() => result.current.loadHookSource(item));
    sourceResponse(result, { success: false, errorCode: 'READ_FAILED' });
    expect(result.current.editor?.content).toBeNull();
  });

  it('rejects stale source responses even after A to B to A navigation', () => {
    const { result } = renderHook(useHookManagement);
    act(() => result.current.loadHookSource(item));
    const first = request('get_hook_source');
    act(() => result.current.loadHookSource(other));
    act(() => result.current.loadHookSource(item));
    act(() => result.current.updateHookSource({ success: true, requestId: first.requestId,
      location: item.rawLocation, revision: 'old', content: 'stale' }));
    expect(result.current.sourceLoading).toBe(true);
    expect(result.current.editor?.content).toBeNull();
    sourceResponse(result, { content: 'newest' });
    expect(result.current.editor?.content).toBe('newest');
  });

  it('does not apply an older mutation result after another source opens', () => {
    const { result } = renderHook(useHookManagement);
    open(result);
    act(() => result.current.saveHookSource('saved'));
    const pending = request('save_hook_source');
    open(result, other, 'other');
    act(() => result.current.updateHookMutationResult({ success: true, requestId: pending.requestId,
      location: pending.location, revision: '2:2', content: 'saved' }));
    expect(result.current.editor?.content).toBe('other');
    expect(result.current.mutationLoading).toBe(false);
  });

  it('publishes the confirmed revision, backup and timestamp after saving', () => {
    const { result } = renderHook(useHookManagement);
    open(result);
    act(() => result.current.saveHookSource('saved'));
    mutationResponse(result, { backupPath: 'C:/private/backup.bak', lastModified: 1234 });
    expect(result.current.editor?.content).toBe('saved');
    expect(result.current.editor?.lastModified).toBe(1234);
    expect(result.current.lastBackupPath).toBe('C:/private/backup.bak');
    expect(result.current.canRestore).toBe(true);
  });

  it('supports catalog sources without a hook item', () => {
    const { result } = renderHook(useHookManagement);
    const source = { provider: 'claude' as const, scope: 'PROJECT' as const, location: 'C:/project/.claude/settings.json',
      format: 'settings-json', exists: true, readOnly: false, revision: '1:1', validationIssues: [] };
    act(() => result.current.loadHookSource(source));
    sourceResponse(result, { content: '{}' });
    act(() => result.current.saveHookSource('{"hooks":{}}'));
    expect(request('save_hook_source')).toMatchObject({ location: source.location, expectedRevision: '1:1', content: '{"hooks":{}}' });
  });

  it('reports failed delivery immediately for read and save', () => {
    const { result } = renderHook(useHookManagement);
    window.sendToJava = vi.fn(() => false);
    act(() => result.current.loadHookSource(item));
    expect(result.current.sourceLoading).toBe(false);
    expect(result.current.sourceError).toBe('BRIDGE_UNAVAILABLE');
    window.sendToJava = vi.fn(() => true);
    open(result);
    window.sendToJava = vi.fn(() => false);
    act(() => result.current.saveHookSource('saved'));
    expect(result.current.mutationLoading).toBe(false);
    expect(result.current.mutationError).toBe('BRIDGE_UNAVAILABLE');
  });

  it('bounds both source and mutation waits', () => {
    const { result } = renderHook(useHookManagement);
    act(() => result.current.loadHookSource(item));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.sourceError).toBe('HOOK_SOURCE_TIMEOUT');
    open(result);
    act(() => result.current.saveHookSource('saved'));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.mutationLoading).toBe(false);
    expect(result.current.mutationError).toBe('HOOK_MUTATION_TIMEOUT');
  });

  it('does not overwrite the source baseline when a timed-out save confirms late', () => {
    const { result } = renderHook(useHookManagement);
    open(result);
    act(() => result.current.saveHookSource('saved'));
    act(() => vi.advanceTimersByTime(5000));
    mutationResponse(result);
    expect(result.current.editor?.content).toBe('echo ready');
    expect(result.current.mutationError).toBe('HOOK_MUTATION_CONFIRMED_LATE');
    expect(request('get_hooks').requestId).toBeTruthy();
  });

  it('bounds restore waits and reports failed restore delivery', () => {
    const { result } = renderHook(useHookManagement);
    open(result);
    act(() => result.current.saveHookSource('saved'));
    mutationResponse(result, { backupPath: 'C:/private/backup.bak' });
    act(() => result.current.restoreHookSource());
    expect(request('restore_hook_source')).toMatchObject({ expectedRevision: '2:2', backupPath: 'C:/private/backup.bak' });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.mutationError).toBe('HOOK_MUTATION_TIMEOUT');
    window.sendToJava = vi.fn(() => false);
    act(() => result.current.restoreHookSource());
    expect(result.current.mutationError).toBe('BRIDGE_UNAVAILABLE');
    expect(result.current.mutationLoading).toBe(false);
  });

  it('blocks duplicate save dispatches before React state rerenders', () => {
    const { result } = renderHook(useHookManagement);
    open(result);
    act(() => { result.current.saveHookSource('first'); result.current.saveHookSource('second'); });
    expect(vi.mocked(window.sendToJava!).mock.calls.filter(([text]) => text.startsWith('save_hook_source:'))).toHaveLength(1);
  });

  it('refreshes late toggle success without clearing a newer pending toggle', () => {
    const { result } = renderHook(useHookManagement);
    act(() => result.current.toggleHook?.(item, false));
    const firstId = request('toggle_hook').requestId;
    act(() => vi.advanceTimersByTime(5000));
    act(() => result.current.toggleHook?.(item, false));
    const secondId = request('toggle_hook').requestId;
    act(() => result.current.updateHookToggleResult?.({ success: true, requestId: firstId }));
    expect(result.current.toggleLoadingId).toBe(item.sourceId);
    expect(request('get_hooks').requestId).toBeTruthy();
    act(() => result.current.updateHookToggleResult?.({ success: true, requestId: secondId }));
    expect(result.current.toggleLoadingId).toBe(item.sourceId);
    act(() => result.current.updateHooks({ ...EMPTY_HOOK_CATALOG, items: [],
      requestId: request('get_hooks').requestId }));
    expect(result.current.toggleLoadingId).toBeNull();
  });

  it('rejects a toggle acknowledgement from a previous controller mount', () => {
    const first = renderHook(useHookManagement);
    act(() => first.result.current.toggleHook?.(item, false));
    const firstId = request('toggle_hook').requestId;
    first.unmount();
    const second = renderHook(useHookManagement);
    act(() => second.result.current.toggleHook?.(item, false));
    const secondId = request('toggle_hook').requestId;
    expect(firstId).not.toBe(secondId);
    act(() => second.result.current.updateHookToggleResult?.({ success: true, requestId: firstId }));
    expect(second.result.current.toggleLoadingId).toBe(item.sourceId);
    act(() => second.result.current.updateHookToggleResult?.({ success: true, requestId: secondId }));
    expect(second.result.current.toggleLoadingId).toBe(item.sourceId);
    act(() => second.result.current.updateHooks({ ...EMPTY_HOOK_CATALOG, items: [],
      requestId: request('get_hooks').requestId }));
    expect(second.result.current.toggleLoadingId).toBeNull();
  });

  it('carries the native user state revision for project declarations', () => {
    const { result } = renderHook(useHookManagement);
    const native: HookItem = { ...other, provider: 'codex', toggleSupported: true, managedToggleSupported: false,
      event: 'PreToolUse', managedKey: 'C:/project/.codex/hooks.json:pre_tool_use:0:0', format: 'hooks-json', nativeStateRevision: 'user:revision' };
    act(() => result.current.toggleHook?.(native, false));
    expect(request('toggle_hook')).toMatchObject({ nativeStateRevision: 'user:revision', managedKey: native.managedKey, enabled: false });
  });

  it('keeps all toggles pending until the correlated catalog refresh completes', () => {
    const { result } = renderHook(useHookManagement);
    act(() => result.current.loadHooks());
    const stale = request('get_hooks').requestId;
    act(() => result.current.toggleHook?.(item, false));
    act(() => result.current.updateHookToggleResult?.({ success: true, requestId: request('toggle_hook').requestId }));
    const fresh = request('get_hooks').requestId;
    expect(fresh).not.toBe(stale);
    act(() => result.current.updateHooks({ ...EMPTY_HOOK_CATALOG, items: [item], requestId: stale }));
    expect(result.current.toggleLoadingId).toBe(item.sourceId);
    act(() => result.current.toggleHook?.(other, true, true));
    expect(vi.mocked(window.sendToJava!).mock.calls.filter(([text]) => text.startsWith('toggle_hook:'))).toHaveLength(1);
    act(() => result.current.updateHooks({ ...EMPTY_HOOK_CATALOG, items: [], requestId: fresh }));
    expect(result.current.toggleLoadingId).toBeNull();
    expect(result.current.catalog.items).toEqual([]);
  });

  it('releases a pending toggle with an error when its catalog refresh times out', () => {
    const { result } = renderHook(useHookManagement);
    act(() => result.current.toggleHook?.(item, false));
    act(() => result.current.updateHookToggleResult?.({ success: true, requestId: request('toggle_hook').requestId }));
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.toggleLoadingId).toBeNull();
    expect(result.current.toggleError).toBe('HOOK_CATALOG_TIMEOUT');
    act(() => result.current.toggleHook?.(other, false, true));
    expect(request('toggle_hook').confirmSharedChange).toBe(true);
  });
});
