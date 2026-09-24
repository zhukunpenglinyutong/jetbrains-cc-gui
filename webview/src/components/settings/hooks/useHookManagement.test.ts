import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookItem, HookSource } from '../../../types/hooks';
import { useHookManagement } from './useHookManagement';

const item: HookItem = {
  sourceId: 'claude-global',
  provider: 'claude',
  scope: 'GLOBAL',
  event: 'PreToolUse',
  command: 'echo ready',
  enabled: true,
  toggleSupported: false,
  rawLocation: 'C:/Users/test/.claude/settings.json',
  schemaVersion: 1,
  format: 'claude-settings-json',
  revision: '1:1',
  validationIssues: [],
  extensions: {},
};
const otherItem: HookItem = {
  ...item,
  sourceId: 'claude-project',
  scope: 'PROJECT',
  rawLocation: 'C:/project/.claude/settings.json',
  revision: '2:2',
};
const source: HookSource = {
  provider: 'claude',
  scope: 'GLOBAL_LOCAL',
  location: 'C:/Users/test/.claude/settings.local.json',
  format: 'settings-json',
  exists: true,
  readOnly: false,
  revision: '4:4',
  validationIssues: [],
};

describe('useHookManagement conflict recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sendToJava = vi.fn(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    window.sendToJava = undefined;
  });

  it('reloads the current source after a revision conflict', () => {
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.loadHookSource(item));
    act(() => result.current.updateHookSource({
      success: true,
      location: item.rawLocation,
      revision: item.revision,
      content: 'echo ready',
      backupDirectory: 'C:/Users/test/.claude/.ccgui-hooks-backups',
      lastModified: 1720000000000,
    }));
    expect(result.current.editor?.backupDirectory).toBe('C:/Users/test/.claude/.ccgui-hooks-backups');
    expect(result.current.editor?.lastModified).toBe(1720000000000);
    act(() => result.current.updateHookMutationResult({
      success: false,
      errorCode: 'HOOK_REVISION_CONFLICT',
    }));
    expect(result.current.mutationError).toBe('HOOK_REVISION_CONFLICT');

    act(() => result.current.reloadHookSource());

    expect(result.current.sourceLoading).toBe(true);
    expect(result.current.mutationError).toBe('HOOK_REVISION_CONFLICT');
    expect(window.sendToJava).toHaveBeenLastCalledWith(
      `get_hook_source:${JSON.stringify({ location: item.rawLocation })}`,
    );
  });

  it('surfaces a source reload failure without replacing the editor content', () => {
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.loadHookSource(item));
    act(() => result.current.updateHookSource({
      success: true,
      location: item.rawLocation,
      revision: item.revision,
      content: 'echo ready',
    }));
    act(() => result.current.updateHookSource({
      success: false,
      errorCode: 'READ_FAILED',
    }));

    expect(result.current.sourceError).toBe('READ_FAILED');
    expect(result.current.editor?.content).toBe('echo ready');
  });

  it('keeps the editor unavailable when the initial source read fails', () => {
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.loadHookSource(item));
    expect(result.current.editor?.content).toBeNull();
    act(() => result.current.updateHookSource({
      success: false,
      errorCode: 'READ_FAILED',
    }));

    expect(result.current.sourceError).toBe('READ_FAILED');
    expect(result.current.editor?.content).toBeNull();
  });

  it('ignores a stale source response after another source is opened', () => {
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.loadHookSource(item));
    act(() => result.current.loadHookSource(otherItem));
    act(() => result.current.updateHookSource({
      success: true,
      location: item.rawLocation,
      revision: '3:3',
      content: 'stale content',
    }));

    expect(result.current.sourceLoading).toBe(true);
    expect(result.current.editor?.item).toEqual(otherItem);
    expect(result.current.editor?.content).toBeNull();
  });

  it('does not apply a stale mutation result to another source', () => {
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.loadHookSource(item));
    act(() => result.current.updateHookSource({
      success: true,
      location: item.rawLocation,
      revision: item.revision,
      content: 'echo ready',
    }));
    act(() => result.current.saveHookSource('echo saved'));
    expect(result.current.mutationLoading).toBe(true);
    act(() => result.current.loadHookSource(otherItem));
    expect(result.current.mutationLoading).toBe(false);
    act(() => result.current.updateHookMutationResult({
      success: true,
      location: item.rawLocation,
      revision: '3:3',
      content: 'echo saved',
    }));

    expect(result.current.mutationLoading).toBe(false);
    expect(result.current.editor?.item).toEqual(otherItem);
    expect(result.current.editor?.content).toBeNull();
  });

  it('exposes the latest backup and updated timestamp after saving', () => {
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.loadHookSource(item));
    act(() => result.current.updateHookSource({
      success: true,
      location: item.rawLocation,
      revision: item.revision,
      content: 'echo ready',
      backupDirectory: 'C:/Users/test/.claude/.ccgui-hooks-backups',
    }));
    act(() => result.current.updateHookMutationResult({
      success: true,
      location: item.rawLocation,
      revision: '3:3',
      content: 'echo saved',
      backupPath: 'C:/Users/test/.claude/.ccgui-hooks-backups/settings.backup.json',
      lastModified: 1720000001000,
    }));

    expect(result.current.lastBackupPath).toBe('C:/Users/test/.claude/.ccgui-hooks-backups/settings.backup.json');
    expect(result.current.editor?.lastModified).toBe(1720000001000);
  });

  it('uses a catalog source location for the shared read and save flow', () => {
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.loadHookSource(source));
    expect(window.sendToJava).toHaveBeenLastCalledWith(
      `get_hook_source:${JSON.stringify({ location: source.location })}`,
    );

    act(() => result.current.updateHookSource({
      success: true,
      location: source.location,
      revision: source.revision,
      content: '{}',
    }));
    act(() => result.current.saveHookSource('{"disableAllHooks":true}'));

    expect(window.sendToJava).toHaveBeenLastCalledWith(
      `save_hook_source:${JSON.stringify({
        location: source.location,
        expectedRevision: source.revision,
        content: '{"disableAllHooks":true}',
      })}`,
    );
  });

  it('sends managed toggle identity and ignores a timed-out response after retry', () => {
    const managedItem: HookItem = {
      ...item,
      managedToggleSupported: true,
      managedKey: 'PreToolUse/0/hooks/0',
    };
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.toggleHook?.(managedItem, false));
    expect(window.sendToJava).toHaveBeenLastCalledWith(
      `toggle_hook:${JSON.stringify({
        requestId: 'hook-toggle-1',
        provider: 'claude',
        scope: 'GLOBAL',
        event: 'PreToolUse',
        matcher: undefined,
        sourceId: managedItem.sourceId,
        managedKey: managedItem.managedKey,
        format: managedItem.format,
        location: managedItem.rawLocation,
        expectedRevision: managedItem.revision,
        enabled: false,
      })}`,
    );

    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.toggleError).toBe('HOOK_TOGGLE_TIMEOUT');
    act(() => result.current.toggleHook?.(managedItem, false));
    act(() => result.current.updateHookToggleResult?.({
      success: true,
      requestId: 'hook-toggle-1',
      sourceId: managedItem.sourceId,
    }));
    expect(result.current.toggleLoadingId).toBe(managedItem.sourceId);

    act(() => result.current.updateHookToggleResult?.({
      success: true,
      requestId: 'hook-toggle-2',
      sourceId: managedItem.sourceId,
    }));
    expect(result.current.toggleLoadingId).toBeNull();
  });

  it('sends a provider-native Codex toggle', () => {
    const nativeItem: HookItem = {
      ...item,
      sourceId: 'codex-global',
      provider: 'codex',
      event: 'pre_tool_use',
      managedKey: 'pre_tool_use/0',
      rawLocation: 'C:/Users/test/.codex/config.toml',
      format: 'config-toml',
      toggleSupported: true,
      managedToggleSupported: false,
      toggleMode: 'native',
    };
    const { result } = renderHook(() => useHookManagement());

    act(() => result.current.toggleHook?.(nativeItem, false));

    expect(window.sendToJava).toHaveBeenLastCalledWith(
      `toggle_hook:${JSON.stringify({
        requestId: 'hook-toggle-1',
        provider: 'codex',
        scope: 'GLOBAL',
        event: 'pre_tool_use',
        matcher: undefined,
        sourceId: nativeItem.sourceId,
        managedKey: nativeItem.managedKey,
        format: 'config-toml',
        location: nativeItem.rawLocation,
        expectedRevision: nativeItem.revision,
        enabled: false,
      })}`,
    );
  });
});
