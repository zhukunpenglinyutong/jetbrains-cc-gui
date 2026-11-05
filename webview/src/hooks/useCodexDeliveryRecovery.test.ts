import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDialogManagement } from './useDialogManagement';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn(), openBrowserExternal: vi.fn() }));

const t = ((key: string, options?: { error?: string }) =>
  options?.error ? `${key}|${options.error}` : key) as unknown as TFunction;

const permission = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  channelId: 'C',
  toolName: 'item/commandExecution/requestApproval',
  inputs: { command: 'git status' },
  dialogToken: 'token-1',
  codexInteractionKey: 'key-1',
  codexMethod: 'item/commandExecution/requestApproval',
  provider: 'codex',
  ...overrides,
});

function acknowledge(interactionKey: string, error?: string, extra: Record<string, unknown> = {}) {
  act(() => {
    window.dispatchEvent(new CustomEvent('codex-interaction-response', {
      detail: JSON.stringify(error === undefined ? { interactionKey } : { interactionKey, error, ...extra }),
    }));
  });
}

function renderDialogs() {
  const addToast = vi.fn();
  const hook = renderHook(() => useDialogManagement({ t, addToast }));
  return { ...hook, addToast };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Codex answers that never reach the runtime', () => {
  it('reopens the permission dialog and explains why when delivery fails', () => {
    const { result, addToast } = renderDialogs();
    const request = permission();
    act(() => { result.current.openPermissionDialog(request); });
    act(() => { result.current.handlePermissionApprove('C'); });
    expect(result.current.currentPermissionRequest).toBeNull();

    acknowledge('key-1', 'Codex app-server daemon is unavailable');

    expect(result.current.currentPermissionRequest).toEqual(request);
    expect(result.current.permissionDialogOpen).toBe(true);
    expect(addToast).toHaveBeenCalledWith(
      'permission.codexDeliveryRetry|Codex app-server daemon is unavailable', 'error');
  });

  it('stops reopening after one retry and tells the user to stop and resend', () => {
    const { result, addToast } = renderDialogs();
    act(() => { result.current.openPermissionDialog(permission()); });
    act(() => { result.current.handlePermissionApprove('C'); });
    acknowledge('key-1', 'first failure');
    act(() => { result.current.handlePermissionDecision('C', {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] },
    }); });

    acknowledge('key-1', 'Unknown or stale Codex interaction');

    expect(result.current.currentPermissionRequest).toBeNull();
    expect(addToast).toHaveBeenLastCalledWith(
      'permission.codexDeliveryFailed|Unknown or stale Codex interaction', 'error');
  });

  it('does not reopen a dialog whose deadline has already passed', () => {
    const { result, addToast } = renderDialogs();
    act(() => { result.current.openPermissionDialog(permission({ deadlineMs: Date.now() + 5_000 })); });
    act(() => { result.current.handlePermissionSkip('C'); });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

    acknowledge('key-1', 'daemon timeout');

    expect(result.current.currentPermissionRequest).toBeNull();
    expect(addToast).toHaveBeenCalledWith('permission.codexDeliveryFailed|daemon timeout', 'error');
    vi.restoreAllMocks();
  });

  it('ignores acknowledgements for delivered answers and for requests this page did not send', () => {
    const { result, addToast } = renderDialogs();
    act(() => { result.current.openPermissionDialog(permission()); });
    act(() => { result.current.handlePermissionCancel('C'); });

    acknowledge('key-1');
    acknowledge('key-1', 'late failure after success');
    acknowledge('someone-else', 'not ours');

    expect(result.current.currentPermissionRequest).toBeNull();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('only explains a failure that cannot succeed on retry', () => {
    const { result, addToast } = renderDialogs();
    act(() => { result.current.openPermissionDialog(permission()); });
    act(() => { result.current.handlePermissionApprove('C'); });

    acknowledge('key-1', 'Unknown or stale Codex interaction', { retryable: false });

    expect(result.current.currentPermissionRequest).toBeNull();
    expect(addToast).toHaveBeenCalledWith(
      'permission.codexDeliveryFailed|Unknown or stale Codex interaction', 'error');
  });

  it('does not ask again for an answer whose delivery is only unconfirmed', () => {
    const { result, addToast } = renderDialogs();
    act(() => { result.current.openPermissionDialog(permission()); });
    act(() => { result.current.handlePermissionApprove('C'); });

    acknowledge('key-1', 'codex.respondInteraction timed out after 10000 ms',
      { retryable: false, deliveryUnconfirmed: true });

    // A slow daemon usually delivers the first answer late; a second one would contradict it.
    expect(result.current.currentPermissionRequest).toBeNull();
    expect(result.current.permissionDialogOpen).toBe(false);
    expect(addToast).toHaveBeenCalledWith(
      'permission.codexDeliveryUnconfirmed|codex.respondInteraction timed out after 10000 ms', 'error');
  });

  it('does not bring back a dialog the runtime already closed', () => {
    const { result, addToast } = renderDialogs();
    act(() => { result.current.openPermissionDialog(permission()); });
    act(() => { result.current.handlePermissionApprove('C'); });
    act(() => { result.current.forceClosePermissionDialog('C', 'token-1'); });

    acknowledge('key-1', 'codex.respondInteraction timed out after 10000 ms');

    expect(result.current.currentPermissionRequest).toBeNull();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('reopens a Codex question whose answer was not delivered', () => {
    const { result, addToast } = renderDialogs();
    const question: AskUserQuestionRequest = {
      requestId: 'question-key',
      toolName: 'item/tool/requestUserInput',
      questions: [],
      provider: 'codex',
      dialogToken: 'question-token',
      codexInteractionKey: 'question-key',
      codexMethod: 'item/tool/requestUserInput',
    };
    act(() => { result.current.openAskUserQuestionDialog(question); });
    act(() => { result.current.handleAskUserQuestionSubmit('question-key', { q: 'yes' }); });

    acknowledge('question-key', 'invalid native Codex interaction result');

    expect(result.current.currentAskUserQuestionRequest).toEqual(question);
    expect(addToast).toHaveBeenCalledWith(
      'permission.codexDeliveryRetry|invalid native Codex interaction result', 'error');
  });
});
