import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDialogManagement } from '../../useDialogManagement';
import { registerPermissionCallbacks } from './permissionCallbacks';
import { sendBridgeEvent } from '../../../utils/bridge';

vi.mock('../../../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));
const t = ((key: string) => key) as TFunction;
const payload = (dialogToken: string) => JSON.stringify({
  channelId: 'C', requestId: 'C', dialogToken, deadlineMs: 10_000,
  toolName: 'test', inputs: {}, questions: [],
});
const cases = [
  { kind: 'permission', current: 'currentPermissionRequest', close: 'forceClosePermissionDialog' },
  { kind: 'askUserQuestion', current: 'currentAskUserQuestionRequest', close: 'forceCloseAskUserQuestionDialog' },
  { kind: 'planApproval', current: 'currentPlanApprovalRequest', close: 'forceClosePlanApprovalDialog' },
] as const;

function registerDialogCallbacks(dialogs: ReturnType<typeof useDialogManagement>) {
  registerPermissionCallbacks({ ...dialogs, addToast: vi.fn(),
    currentProviderRef: { current: 'codex' }, currentSessionIdRef: { current: null } });
}

afterEach(() => {
  delete window.__pendingDialogEvents;
  delete window.showPermissionDialog;
  delete window.showAskUserQuestionDialog;
  delete window.showPlanApprovalDialog;
  delete window.forceClosePermissionDialog;
  delete window.forceCloseAskUserQuestionDialog;
  delete window.forceClosePlanApprovalDialog;
  vi.clearAllMocks();
});

describe.each(cases)('$kind bootstrap delivery', ({ kind, current, close }) => {
  it('drains show, close-all, fresh show in their original order', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    window.__pendingDialogEvents = [
      { kind, type: 'show', payload: payload('old') },
      { kind, type: 'close', targetId: null },
      { kind, type: 'show', payload: payload('new') },
    ];
    act(() => { registerDialogCallbacks(result.current); });
    expect(result.current[current]?.dialogToken).toBe('new');
    expect(window.__pendingDialogEvents).toEqual([]);
    expect(sendBridgeEvent).not.toHaveBeenCalled();
  });

  it('acknowledges the exact token only after consuming the queued close', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    window.__pendingDialogEvents = [
      { kind, type: 'close', targetId: 'C', dialogToken: 'old' },
      { kind, type: 'show', payload: payload('old') },
    ];
    expect(sendBridgeEvent).not.toHaveBeenCalled();
    act(() => { registerDialogCallbacks(result.current); });
    expect(result.current[current]).toBeNull();
    expect(sendBridgeEvent).toHaveBeenCalledWith('dialog_delivery_ack', JSON.stringify({
      functionName: close, targetId: 'C', dialogToken: 'old',
    }));
  });
});

it('echoes the request token in all three response types', () => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const request = JSON.parse(payload('response-token'));
  act(() => {
    result.current.openPermissionDialog(request);
    result.current.openAskUserQuestionDialog(request);
    result.current.openPlanApprovalDialog(request);
  });
  act(() => {
    result.current.handlePermissionApprove('C');
    result.current.handleAskUserQuestionSubmit('C', {});
    result.current.handlePlanApprovalApprove('C', 'default');
  });
  expect(vi.mocked(sendBridgeEvent).mock.calls.map(([event, json]) => [event, JSON.parse(json!).dialogToken]))
    .toEqual([
      ['permission_decision', 'response-token'],
      ['ask_user_question_response', 'response-token'],
      ['plan_approval_response', 'response-token'],
    ]);
});

it('shows native warnings for the current Codex root without changing loading or sending a reply', () => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  const currentProviderRef = { current: 'codex' };
  const currentSessionIdRef = { current: 'warning-root' as string | null };
  const options = { ...result.current, addToast, currentProviderRef, currentSessionIdRef };
  act(() => { registerPermissionCallbacks(options); });
  const emit = (rootThreadId: string, message: string) => act(() => window.onCodexRuntimeEvent?.(JSON.stringify({
    kind: 'nativeWarning', rootThreadId, threadId: rootThreadId,
    payload: { message, willRetry: true },
  })));
  emit('warning-root', 'Native upstream retry reason');
  emit('other-root', 'Other chat warning');
  currentProviderRef.current = 'claude';
  emit('warning-root', 'Previous provider warning');
  expect(addToast).toHaveBeenCalledTimes(1);
  expect(addToast).toHaveBeenCalledWith('Native upstream retry reason', 'warning');
  expect(sendBridgeEvent).not.toHaveBeenCalled();
  expect(result.current.currentPermissionRequest).toBeNull();
});

it('offers confirm and cancel for MCP user verification and maps cancel to the native union', () => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  act(() => { registerDialogCallbacks(result.current); });
  act(() => {
    window.onCodexRuntimeEvent?.(JSON.stringify({
      kind: 'interactionRequested',
      channelId: 'C',
      interactionKey: 'verification-key',
      dialogToken: 'verification-token',
      deliverySequence: 2,
      payload: {
        method: 'mcpServer/elicitation/request',
        params: {
          serverName: 'fixture',
          request: { mode: 'userVerification', message: 'Verify this server?' },
        },
      },
    }));
  });
  expect(result.current.currentAskUserQuestionRequest?.questions[0]?.options.map(option => option.label))
    .toEqual(['Confirm', 'Cancel']);
  act(() => {
    result.current.handleAskUserQuestionSubmit('verification-key', {
      __codex_user_verification__: 'Cancel',
    });
  });
  const call = vi.mocked(sendBridgeEvent).mock.calls.find(([event]) => event === 'codex_interaction_response');
  expect(call).toBeDefined();
  expect(JSON.parse(call![1] as string).result).toEqual({ action: 'cancel', content: null });
});
