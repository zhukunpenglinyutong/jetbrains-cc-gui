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

it('keeps approved automatic reviews quiet during bootstrap and live delivery while retaining their events', () => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  const onEvent = vi.fn();
  const approved = 'Automatic approval review approved (risk: low, authorization: high): Read the requested directory.';
  const events = [
    approved,
    approved,
    'Automatic approval review approved (risk: low, authorization: [redacted]): 仅读取监听器元数据。',
    'Automatic approval review approved (risk: medium, authorization: high): Run the requested checks.',
  ].map(message => ({
    kind: 'nativeWarning', channelId: 'C', sessionEpoch: 'epoch', rootThreadId: 'root', threadId: 'root',
    payload: { method: 'guardianWarning', message },
  }));
  window.__pendingCodexRuntimeEvents = [JSON.stringify(events[0])];
  window.addEventListener('codex-runtime-event', onEvent);
  try {
    act(() => registerPermissionCallbacks({ ...result.current, addToast,
      currentProviderRef: { current: 'codex' }, currentSessionIdRef: { current: 'root' } }));
    for (const event of events.slice(1)) {
      act(() => window.onCodexRuntimeEvent?.(JSON.stringify(event)));
    }
    expect(addToast).not.toHaveBeenCalled();
    expect(onEvent.mock.calls.map(([event]) => event.detail)).toEqual(events);
    expect(window.__pendingCodexRuntimeEvents).toEqual([]);
    expect(sendBridgeEvent).not.toHaveBeenCalled();
    expect(result.current.currentPermissionRequest).toBeNull();
  } finally {
    window.removeEventListener('codex-runtime-event', onEvent);
  }
});

it.each([
  ['guardianWarning', 'Automatic approval review denied (risk: high): The action is outside the requested scope.'],
  ['guardianWarning', 'Automatic approval review timed out while evaluating the requested approval.'],
  ['guardianWarning', 'Automatic approval review failed: reviewer unavailable.'],
  ['guardianWarning', 'Automatic approval review aborted while evaluating the requested approval.'],
  ['guardianWarning', 'Automatic approval review stopped after repeated denials.'],
  ['guardianWarning', 'Automatic approval review approved without a recognized result format.'],
  ['guardianWarning', 'An unknown reviewer warning requires attention.'],
  ['warning', 'Automatic approval review approved (risk: low, authorization: high): An ordinary warning.'],
])('retains actionable or unrecognized %s notifications: %s', (method, message) => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  act(() => registerPermissionCallbacks({ ...result.current, addToast,
    currentProviderRef: { current: 'codex' }, currentSessionIdRef: { current: 'root' } }));
  act(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning', rootThreadId: 'root',
    payload: { method, message } })));
  expect(addToast).toHaveBeenCalledExactlyOnceWith(message, 'warning');
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

describe('Codex fallback model metadata warning', () => {
  const metadataWarning = (slug: string) =>
    `Model metadata for \`${slug}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.`;

  const setup = () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    const addToast = vi.fn();
    const onEvent = vi.fn();
    window.addEventListener('codex-runtime-event', onEvent);
    const currentSessionIdRef = { current: 'root' };
    act(() => registerPermissionCallbacks({ ...result.current, addToast,
      currentProviderRef: { current: 'codex' }, currentSessionIdRef }));
    const emit = (message: string, { rootThreadId = 'root', sessionEpoch = 'epoch', method = 'warning' } = {}) =>
      act(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning', channelId: 'C', sessionEpoch,
        rootThreadId, threadId: rootThreadId, payload: { method, message } })));
    return { addToast, emit, onEvent, currentSessionIdRef,
      cleanup: () => window.removeEventListener('codex-runtime-event', onEvent) };
  };

  it('never interrupts the chat, for any model, while subscribers still receive it', () => {
    const { addToast, emit, onEvent, cleanup } = setup();
    try {
      emit(metadataWarning('gpt-6.1-sol'));
      emit(metadataWarning('gpt-6.1-sol'));
      emit(metadataWarning('kimi-k3'));
      expect(addToast).not.toHaveBeenCalled();
      expect(onEvent).toHaveBeenCalledTimes(3);
    } finally { cleanup(); }
  });

  it('stays quiet in a new conversation or a new runtime session', () => {
    const { addToast, emit, currentSessionIdRef, cleanup } = setup();
    try {
      emit(metadataWarning('gpt-6.1-sol'));
      currentSessionIdRef.current = 'next-root';
      emit(metadataWarning('gpt-6.1-sol'), { rootThreadId: 'next-root' });
      emit(metadataWarning('gpt-6.1-sol'), { rootThreadId: 'next-root', sessionEpoch: 'next-epoch' });
      expect(addToast).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('still shows other warnings, including similar text or the same text from another method', () => {
    const { addToast, emit, cleanup } = setup();
    try {
      emit('Long threads can make the model less accurate.');
      emit('Long threads can make the model less accurate.');
      expect(addToast).toHaveBeenCalledTimes(2);
      emit('Model metadata for `gpt-6.1-sol` could not be refreshed.');
      emit('Catalog entry `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.');
      emit(`${metadataWarning('gpt-6.1-sol')}\nThe catalog will refresh later.`);
      expect(addToast).toHaveBeenCalledTimes(5);
      emit(metadataWarning('gpt-6.1-sol'), { method: 'guardianWarning' });
      expect(addToast).toHaveBeenCalledTimes(6);
    } finally { cleanup(); }
  });
});

describe('Codex CLI version notice', () => {
  const translated = ((key: string, options: { version?: string; minimumVersion?: string }) =>
    `${key}|${options.version}|${options.minimumVersion}`) as unknown as TFunction;

  const setup = () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    const addToast = vi.fn();
    const currentProviderRef = { current: 'codex' };
    act(() => registerPermissionCallbacks({ ...result.current, addToast,
      currentProviderRef, currentSessionIdRef: { current: 'root' } }, () => translated));
    const emit = (version: string, { channelId = 'C', sessionEpoch = 'epoch', rootThreadId = null as string | null } = {}) =>
      act(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning', channelId, sessionEpoch,
        rootThreadId, payload: { method: 'cliVersionOutdated', version, minimumVersion: '0.160.0',
          message: `Codex CLI ${version} is older than 0.160.0.` } })));
    return { addToast, emit, currentProviderRef };
  };

  it('is not scoped to a conversation, since the service can still report an earlier root', () => {
    const { addToast, emit } = setup();
    emit('0.159.0', { rootThreadId: 'earlier-root' });
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('waits for Codex to be the selected provider without consuming the notice', () => {
    const { addToast, emit, currentProviderRef } = setup();
    currentProviderRef.current = 'claude';
    emit('0.159.0');
    expect(addToast).not.toHaveBeenCalled();
    currentProviderRef.current = 'codex';
    emit('0.159.0');
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('shows a localized notice with the versions', () => {
    const { addToast, emit } = setup();
    emit('0.159.0');
    expect(addToast).toHaveBeenCalledExactlyOnceWith('chat.codexCliOutdated|0.159.0|0.160.0', 'warning');
    expect(sendBridgeEvent).not.toHaveBeenCalled();
  });

  it('does not repeat when the runtime restarts with the same CLI, however much later', () => {
    const { addToast, emit } = setup();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
    emit('0.159.0');
    emit('0.159.0');
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    emit('0.159.0', { sessionEpoch: 'next-epoch' });
    expect(addToast).toHaveBeenCalledTimes(1);
  });

  it('notices a different CLI and stays scoped to its chat window', () => {
    const { addToast, emit } = setup();
    emit('0.159.0');
    emit('0.158.0');
    emit('0.159.0', { channelId: 'other-channel' });
    expect(addToast).toHaveBeenCalledTimes(3);
  });
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

describe('Codex command approval suggestions', () => {
  const ruleDecision = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } };

  function requestCommandApproval(params: Record<string, unknown>) {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => { registerDialogCallbacks(result.current); });
    act(() => {
      window.onCodexRuntimeEvent?.(JSON.stringify({
        kind: 'interactionRequested',
        channelId: 'C',
        interactionKey: 'approval-key',
        dialogToken: 'approval-token',
        deliverySequence: 1,
        payload: { method: 'item/commandExecution/requestApproval', params },
      }));
    });
    return result.current.currentPermissionRequest?.suggestions;
  }

  it('keeps the advertised decision list as-is instead of appending the proposed rule twice', () => {
    expect(requestCommandApproval({
      command: 'git status',
      availableDecisions: ['accept', ruleDecision, 'cancel'],
      proposedExecpolicyAmendment: ['git', 'status'],
    })).toEqual(['accept', ruleDecision, 'cancel']);
  });

  it('still offers the proposed rule when the server advertises no decision list', () => {
    expect(requestCommandApproval({
      command: 'git status',
      proposedExecpolicyAmendment: ['git', 'status'],
    })).toEqual(['accept', 'acceptForSession', 'decline', ruleDecision]);
  });
});
