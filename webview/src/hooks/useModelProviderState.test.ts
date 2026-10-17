import { act, cleanup, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelProviderState } from './useModelProviderState';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));

const options = { addToast: vi.fn(), t: ((key: string) => key) as TFunction };

// Since the app-server migration (design D5) the Codex runtime is the CLI
// itself: native auto capability is decided by native constraints at send
// time, not by a TypeScript SDK version floor.
describe('Codex native auto availability', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('reports native auto available regardless of dependency status', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(true);
    act(() => result.current.setSdkStatus({ 'codex-sdk': { installed: true, meetsMinimumVersion: false } }));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(true);
    act(() => result.current.setSdkStatus({}));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(true);
  });

  it('keeps a saved auto mode with unknown dependency status', () => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex', codexPermissionMode: 'auto',
    }));
    const { result } = renderHook(() => useModelProviderState(options));
    expect(result.current.codexNativeAutoReviewAvailable).toBe(true);
    expect(result.current.codexPermissionMode).toBe('auto');
  });

  it('keeps a saved auto mode when switching to codex with an outdated SDK report', () => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude', codexPermissionMode: 'auto',
    }));
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.setSdkStatus({ 'codex-sdk': { installed: true, meetsMinimumVersion: false } }));
    act(() => result.current.handleProviderSelect('codex'));
    expect(result.current.permissionMode).toBe('auto');
    expect(sendBridgeEvent).toHaveBeenCalledWith('set_mode', 'auto');
  });

  it('selecting auto emits the native auto mode', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('auto'));
    expect(result.current.permissionMode).toBe('auto');
    expect(result.current.codexPermissionMode).toBe('auto');
    expect(sendBridgeEvent).toHaveBeenLastCalledWith('set_mode', 'auto');
  });

  it('preserves native Codex plan mode independently of approval policy', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    expect(result.current.permissionMode).toBe('plan');
    expect(sendBridgeEvent).toHaveBeenLastCalledWith('set_mode', 'plan');
  });

  it('keeps a settings change pending until native effective settings arrive', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    expect(result.current.codexSettingsPending).toBe(true);
    expect(result.current.codexEffectiveSettings).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent('codex-runtime-event', {
        detail: {
          kind: 'thread/settings/updated',
          payload: { collaborationMode: { mode: 'plan' }, model: 'gpt-test', effort: 'high',
            approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' } },
        },
      }));
    });

    expect(result.current.codexSettingsPending).toBe(false);
    expect(result.current.codexEffectiveSettings).toEqual({
      collaborationMode: { mode: 'plan' }, model: 'gpt-test', effort: 'high',
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'workspaceWrite' },
    });
  });
});
