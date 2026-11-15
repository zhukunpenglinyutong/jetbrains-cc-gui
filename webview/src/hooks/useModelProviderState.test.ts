import { act, cleanup, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelProviderState } from './useModelProviderState';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));

const latestSettingsRequest = () => {
  const payload = vi.mocked(sendBridgeEvent).mock.calls.filter(call => call[0] === 'codex_update_settings').at(-1)?.[1];
  if (!payload) throw new Error('No settings request was sent');
  return JSON.parse(payload);
};

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

  it('does not leave settings pending when bridge dispatch is refused', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    vi.mocked(sendBridgeEvent).mockReturnValue(false);
    act(() => result.current.handleModeSelect('plan'));
    expect(result.current.codexSettingsPending).toBe(false);
    expect(options.addToast).toHaveBeenCalledWith('toast.codexSettingsDispatchFailed', 'error');
    vi.mocked(sendBridgeEvent).mockReset();
  });

  it('sends explicit native Ultracode changes without modifying effort', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleReasoningChange('low'));
    act(() => result.current.handleClaudeUltracodeChange(true));
    expect(result.current.claudeUltracode).toBe(true);
    expect(result.current.reasoningEffort).toBe('low');
    expect(sendBridgeEvent).toHaveBeenLastCalledWith('set_claude_ultracode', 'true');
    act(() => result.current.handleClaudeUltracodeChange(false));
    expect(result.current.claudeUltracode).toBe(false);
    expect(sendBridgeEvent).toHaveBeenLastCalledWith('set_claude_ultracode', 'false');
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

  it('ignores an older failure after selecting A, B, then A again', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    const requestId = latestSettingsRequest().requestId;
    act(() => result.current.handleModeSelect('default'));
    act(() => result.current.handleModeSelect('plan'));
    act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: {
      requestType: 'codex_update_settings', requestId,
      requestedSettings: { collaborationMode: 'plan' }, error: 'Old failure',
    } })));
    expect(result.current.codexSettingsPending).toBe(true);
    expect(options.addToast).not.toHaveBeenCalled();
  });

  it('invalidates old requests on provider changes and reports each current failure once', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    const oldRequestId = latestSettingsRequest().requestId;
    act(() => result.current.handleProviderSelect('claude'));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    const currentRequestId = latestSettingsRequest().requestId;
    const emit = (requestId: string) => act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: {
      requestType: 'codex_update_settings', requestId,
      requestedSettings: { collaborationMode: 'plan' }, error: 'Unavailable',
    } })));
    emit(oldRequestId);
    expect(result.current.codexSettingsPending).toBe(true);
    expect(options.addToast).not.toHaveBeenCalled();
    emit(currentRequestId);
    emit(currentRequestId);
    expect(result.current.codexSettingsPending).toBe(false);
    expect(options.addToast).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('clears a failed current settings update and reports its error (serialized: %s)', serialized => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    expect(result.current.codexSettingsPending).toBe(true);
    const response = { requestType: 'codex_update_settings', requestId: latestSettingsRequest().requestId, requestedSettings: { collaborationMode: 'plan' }, error: 'Configuration unavailable' };
    act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: serialized ? JSON.stringify(response) : response })));
    expect(result.current.codexSettingsPending).toBe(false);
    expect(result.current.codexEffectiveSettings).toBeNull();
    expect(options.addToast).toHaveBeenCalledWith('Configuration unavailable', 'error');
  });

  it.each([
    ['Codex runtime access is inactive', 'toast.codexSettingsRuntimeInactive'],
    ['Codex app-server daemon is unavailable', 'toast.codexSettingsServiceUnavailable'],
    ['Codex bridge is unavailable', 'toast.codexSettingsServiceUnavailable'],
    ['Codex settings update failed', 'toast.codexSettingsUpdateFailed'],
    ['Codex settings update returned no acknowledgement', 'toast.codexSettingsUpdateFailed'],
  ])('localizes a known settings failure: %s', (error, messageKey) => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    const response = { requestType: 'codex_update_settings', requestId: latestSettingsRequest().requestId,
      requestedSettings: { collaborationMode: 'plan' }, error };
    act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: response })));
    expect(result.current.codexSettingsPending).toBe(false);
    expect(result.current.codexEffectiveSettings).toBeNull();
    expect(options.addToast).toHaveBeenCalledWith(messageKey, 'error');
    act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: response })));
    expect(options.addToast).toHaveBeenCalledTimes(1);
  });

  it('uses the current language when a pending settings request fails', () => {
    const oldT = ((key: string) => `old:${key}`) as TFunction;
    const newT = ((key: string) => `new:${key}`) as TFunction;
    const { result, rerender } = renderHook(({ t }) => useModelProviderState({ addToast: options.addToast, t }), {
      initialProps: { t: oldT },
    });
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    const requestId = latestSettingsRequest().requestId;
    rerender({ t: newT });
    act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: {
      requestType: 'codex_update_settings', requestId, requestedSettings: { collaborationMode: 'plan' },
      error: 'Codex app-server daemon is unavailable',
    } })));
    expect(options.addToast).toHaveBeenCalledWith('new:toast.codexSettingsServiceUnavailable', 'error');
  });

  it('ignores stale failures and keeps successful queue acknowledgements pending until native confirmation', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('plan'));
    options.addToast.mockClear();
    for (const response of [
      { requestType: 'codex_update_settings', requestedSettings: { collaborationMode: 'default' }, error: 'Old failure' },
      { requestType: 'codex_update_settings', requestedSettings: { collaborationMode: 'plan' }, revision: 2, applied: false },
      { requestType: 'codex_compact', error: 'Unrelated failure' },
      'invalid json', null,
    ]) act(() => window.dispatchEvent(new CustomEvent('codex-interaction-response', { detail: response })));
    expect(result.current.codexSettingsPending).toBe(true);
    expect(options.addToast).not.toHaveBeenCalled();
  });

  it('derives an unclaimed access scope from the authoritative mode', () => {
    // A wiped localStorage snapshot leaves the scope on the safe default while
    // the app-level mode still says Full Auto; the scope must follow the mode
    // instead of silently keeping the runtime sandboxed.
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      codexPermissionMode: 'default',
    }));
    const { result } = renderHook(() => useModelProviderState(options));
    expect(result.current.codexSandboxSource).toBe('default');
    expect(result.current.codexSandboxSelection).toBe('workspace-write');

    act(() => result.current.setCodexPermissionMode('bypassPermissions'));

    expect(result.current.codexSandboxSelection).toBe('danger-full-access');
    expect(result.current.codexApprovalPreset).toBe('full-access');
    expect(latestSettingsRequest().settings).toMatchObject({
      sandboxSelection: 'danger-full-access', sandboxSource: 'default', approvalPreset: 'full-access',
    });
  });

  it.each([
    { kind: 'runtimeReset', payload: { reason: 'requested' } },
    ...['starting', 'initializing', 'draining', 'stopped', 'failed'].map(state => ({
      kind: 'runtimeStateChanged', payload: { state },
    })),
  ])('clears the old native confirmation on $kind $payload', detail => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => result.current.handleModeSelect('bypassPermissions'));
    act(() => {
      window.dispatchEvent(new CustomEvent('codex-runtime-event', {
        detail: { kind: 'thread/settings/updated', payload: {
          sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never',
        } },
      }));
    });
    expect(result.current.codexEffectiveSandbox).toBe('danger-full-access');

    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', { detail })));

    expect(result.current.codexEffectiveSandbox).toBeNull();
    expect(result.current.codexEffectiveSettings).toBeNull();
    expect(result.current.codexSandboxSelection).toBe('danger-full-access');
  });

  it('does not reuse a previous provider confirmation after switching away and back', () => {
    const { result } = renderHook(() => useModelProviderState(options));
    act(() => result.current.handleProviderSelect('codex'));
    act(() => window.dispatchEvent(new CustomEvent('codex-runtime-event', {
      detail: { kind: 'thread/settings/updated', payload: { sandboxPolicy: { type: 'readOnly' } } },
    })));
    expect(result.current.codexEffectiveSandbox).toBe('read-only');

    act(() => result.current.handleProviderSelect('claude'));
    act(() => result.current.handleProviderSelect('codex'));

    expect(result.current.codexEffectiveSettings).toBeNull();
    expect(result.current.codexEffectiveSandbox).toBeNull();
  });

  it('never overrides an explicitly chosen access scope', () => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      codexPermissionMode: 'default',
      codexSandboxSelection: 'workspace-write',
      codexSandboxSource: 'user',
    }));
    const { result } = renderHook(() => useModelProviderState(options));

    act(() => result.current.setCodexPermissionMode('bypassPermissions'));

    expect(result.current.codexSandboxSelection).toBe('workspace-write');
    expect(result.current.codexSandboxSource).toBe('user');
  });
});
