import { act, renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDialogManagement } from '../../useDialogManagement';
import { registerPermissionCallbacks } from './permissionCallbacks';
import { sendBridgeEvent } from '../../../utils/bridge';
import { Modal } from 'antd';

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
  vi.useRealTimers();
  delete window.onCodexRuntimeEvent;
  delete window.__pendingCodexRuntimeEvents;
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
  const emit = (rootThreadId: string | null, message: string) => act(() => window.onCodexRuntimeEvent?.(JSON.stringify({
    kind: 'nativeWarning', rootThreadId, threadId: rootThreadId,
    payload: { message, willRetry: true },
  })));
  emit('warning-root', 'Native upstream retry reason');
  emit(null, 'The native configuration contains a deprecated setting');
  emit('other-root', 'Other chat warning');
  currentProviderRef.current = 'claude';
  emit('warning-root', 'Previous provider warning');
  expect(addToast).toHaveBeenCalledTimes(2);
  expect(addToast).toHaveBeenCalledWith('Native upstream retry reason', 'warning');
  expect(addToast).toHaveBeenCalledWith('The native configuration contains a deprecated setting', 'warning');
  expect(sendBridgeEvent).not.toHaveBeenCalled();
  expect(result.current.currentPermissionRequest).toBeNull();
});

it('coalesces repeated configuration toasts while retaining raw events and distinct notices', () => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  const onEvent = vi.fn();
  window.addEventListener('codex-runtime-event', onEvent);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  act(() => registerPermissionCallbacks({ ...result.current, addToast,
    currentProviderRef: { current: 'codex' }, currentSessionIdRef: { current: 'root' } }));
  const emit = (method: string, message = 'Ignored native configuration', sessionEpoch = 'epoch', rootThreadId: string | null = null) => {
    act(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning', channelId: 'C',
      sessionEpoch, runtimeBackend: 'cli', rootThreadId, payload: { method, message } })));
  };
  try {
    emit('configWarning');
    emit('configWarning', undefined, undefined, 'root');
    emit('deprecationNotice');
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(3);
    emit('configWarning', 'A different setting was ignored');
    emit('configWarning', undefined, 'new-epoch');
    emit('guardianWarning');
    emit('guardianWarning');
    emit('error');
    emit('error');
    expect(addToast).toHaveBeenCalledTimes(7);
    vi.advanceTimersByTime(60_000);
    emit('configWarning');
    expect(addToast).toHaveBeenCalledTimes(8);
    expect(sendBridgeEvent).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener('codex-runtime-event', onEvent);
  }
});

it.each(['configWarning', 'deprecationNotice'])('keeps %s details behind a compact warning without interrupting the question', method => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  const showWarning = vi.spyOn(Modal, 'warning').mockReturnValue({ destroy: vi.fn(), update: vi.fn() });
  const diagnostic = 'Codex is ignoring old settings.\ndisable_response_storage is ignored.\nnetwork_access is ignored.';
  act(() => registerPermissionCallbacks({ ...result.current, addToast,
    currentProviderRef: { current: 'codex' }, currentSessionIdRef: { current: 'thread' } }));
  act(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning', threadId: 'thread',
    payload: { method, message: diagnostic } })));
  expect(addToast).toHaveBeenCalledTimes(1);
  const [message, severity, action] = addToast.mock.calls[0];
  expect(message).not.toContain('disable_response_storage');
  expect(severity).toBe('warning');
  expect(message).toBe(method === 'configWarning'
    ? 'Codex reported a configuration warning. Review the details.'
    : 'Codex reported an API compatibility notice. Review the details.');
  expect(showWarning).not.toHaveBeenCalled();
  action.onClick();
  expect(showWarning).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.objectContaining({ props: expect.objectContaining({ children: diagnostic }) }),
  }));
  expect(sendBridgeEvent).not.toHaveBeenCalled();
  showWarning.mockRestore();
});

it('uses the current translation when the language changes after callback registration', () => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  let current = ((_key: string, fallback: string) => fallback) as TFunction;
  registerPermissionCallbacks({ ...result.current, addToast,
    currentProviderRef: { current: 'codex' }, currentSessionIdRef: { current: 'thread' } }, () => current);
  current = ((key: string) => key === 'askUserQuestion.warningDetails' ? '查看详情' : 'Codex 配置兼容提示') as TFunction;
  act(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning', threadId: 'thread',
    payload: { method: 'configWarning', message: 'The native configuration has an ignored setting' } })));
  expect(addToast).toHaveBeenCalledWith('Codex 配置兼容提示', 'warning', expect.objectContaining({ label: '查看详情' }));
});

it('does not consume a configuration notice while another session or provider is selected', () => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  const currentProviderRef = { current: 'claude' };
  const currentSessionIdRef = { current: 'other-root' as string | null };
  act(() => registerPermissionCallbacks({ ...result.current, addToast, currentProviderRef, currentSessionIdRef }));
  const emit = () => act(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning', rootThreadId: 'root',
    payload: { method: 'configWarning', message: 'Ignored native configuration' } })));
  emit();
  currentProviderRef.current = 'codex';
  emit();
  currentSessionIdRef.current = 'root';
  emit();
  expect(addToast).toHaveBeenCalledTimes(1);
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
