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

it.each([
  ['configWarning', 'Codex is ignoring 3 unrecognized configuration settings. Check for typos or deprecated settings.'],
  ['deprecationNotice', 'Full-history hydration is deprecated for paginated threads'],
  ['guardianWarning', 'Automatic approval review approved (risk: low, authorization: high): Read the requested directory.'],
  ['guardianWarning', 'Automatic approval review denied (risk: high): The action is outside the requested scope.'],
  ['warning', 'Model metadata for `kimi-k3` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.'],
  ['warning', 'Long threads can make the model less accurate.'],
])('keeps Codex %s quiet while subscribers still receive it: %s', (method, message) => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  const onEvent = vi.fn();
  const event = { kind: 'nativeWarning', channelId: 'C', sessionEpoch: 'epoch', rootThreadId: 'root', threadId: 'root',
    payload: { method, message } };
  window.__pendingCodexRuntimeEvents = [JSON.stringify(event)];
  window.addEventListener('codex-runtime-event', onEvent);
  try {
    act(() => registerPermissionCallbacks({ ...result.current, addToast,
      currentProviderRef: { current: 'codex' }, currentSessionIdRef: { current: 'root' } }));
    act(() => window.onCodexRuntimeEvent?.(JSON.stringify(event)));
    expect(addToast).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(sendBridgeEvent).not.toHaveBeenCalled();
    expect(result.current.currentPermissionRequest).toBeNull();
  } finally {
    window.removeEventListener('codex-runtime-event', onEvent);
  }
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

it('does not consume an error notice while another session or provider is selected', () => {
  const { result } = renderHook(() => useDialogManagement({ t }));
  const addToast = vi.fn();
  const currentProviderRef = { current: 'claude' };
  const currentSessionIdRef = { current: 'other-root' as string | null };
  act(() => registerPermissionCallbacks({ ...result.current, addToast, currentProviderRef, currentSessionIdRef }));
  const emit = () => act(() => window.onCodexRuntimeEvent?.(JSON.stringify({ kind: 'nativeWarning', rootThreadId: 'root',
    payload: { message: 'Upstream request failed' } })));
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

describe('MCP tool-call approval with an empty form schema (issue 2079)', () => {
  const meta = { codex_approval_kind: 'mcp_tool_call' };

  function requestElicitation(requestedSchema: unknown) {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => { registerDialogCallbacks(result.current); });
    act(() => {
      window.onCodexRuntimeEvent?.(JSON.stringify({
        kind: 'interactionRequested',
        channelId: 'C',
        interactionKey: 'mcp-key',
        dialogToken: 'mcp-token',
        deliverySequence: 1,
        payload: {
          method: 'mcpServer/elicitation/request',
          params: {
            serverName: 'noop',
            request: { mode: 'form', message: 'Allow the noop tool?', _meta: meta, requestedSchema },
          },
        },
      }));
    });
    return result;
  }

  function sentResult() {
    const call = vi.mocked(sendBridgeEvent).mock.calls.find(([event]) => event === 'codex_interaction_response');
    return call ? JSON.parse(call[1] as string).result : undefined;
  }

  const emptySchema = { type: 'object', properties: {} };

  it('offers Allow and Deny instead of an unsupported-format dialog', () => {
    const result = requestElicitation(emptySchema);
    const questions = result.current.currentAskUserQuestionRequest?.questions;
    expect(questions).toHaveLength(1);
    expect(questions?.[0]?.question).toBe('Allow the noop tool?');
    expect(questions?.[0]?.options.map(option => option.label)).toEqual(['Allow', 'Deny']);
  });

  it('maps Allow to a one-time accept without echoing _meta', () => {
    const result = requestElicitation(emptySchema);
    const id = result.current.currentAskUserQuestionRequest!.questions[0]!.id!;
    act(() => { result.current.handleAskUserQuestionSubmit('mcp-key', { [id]: 'Allow' }); });
    expect(sentResult()).toEqual({ action: 'accept', content: {} });
  });

  it('does not widen Allow when the request offers a string persist mode', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => { registerDialogCallbacks(result.current); });
    act(() => {
      window.onCodexRuntimeEvent?.(JSON.stringify({
        kind: 'interactionRequested', channelId: 'C', interactionKey: 'mcp-key', dialogToken: 'mcp-token',
        deliverySequence: 1,
        payload: { method: 'mcpServer/elicitation/request', params: {
          serverName: 'plugin', mode: 'form', message: 'Allow?', requestedSchema: emptySchema,
          _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' } } },
      }));
    });
    const id = result.current.currentAskUserQuestionRequest!.questions[0]!.id!;
    act(() => { result.current.handleAskUserQuestionSubmit('mcp-key', { [id]: 'Allow' }); });
    expect(sentResult()._meta).toBeUndefined();
  });

  it('does not offer Allow for a tool suggestion, which Allow could not install', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => { registerDialogCallbacks(result.current); });
    act(() => {
      window.onCodexRuntimeEvent?.(JSON.stringify({
        kind: 'interactionRequested', channelId: 'C', interactionKey: 'mcp-key', dialogToken: 'mcp-token',
        deliverySequence: 1,
        payload: { method: 'mcpServer/elicitation/request', params: {
          serverName: 'plugin', mode: 'form', message: 'Install?', requestedSchema: emptySchema,
          _meta: { codex_approval_kind: 'tool_suggestion', persist: 'always' } } },
      }));
    });
    expect(result.current.currentAskUserQuestionRequest?.questions).toEqual([]);
  });

  it('restricts the Allow/Deny question to its two options', () => {
    const result = requestElicitation(emptySchema);
    expect(result.current.currentAskUserQuestionRequest?.questions[0]?.choiceOnly).toBe(true);
  });

  it('maps Deny to decline without content', () => {
    const result = requestElicitation(emptySchema);
    const id = result.current.currentAskUserQuestionRequest!.questions[0]!.id!;
    act(() => { result.current.handleAskUserQuestionSubmit('mcp-key', { [id]: 'Deny' }); });
    expect(sentResult()).toEqual({ action: 'decline', content: null });
  });

  it('does not treat free text as an approval', () => {
    const result = requestElicitation(emptySchema);
    const id = result.current.currentAskUserQuestionRequest!.questions[0]!.id!;
    act(() => { result.current.handleAskUserQuestionSubmit('mcp-key', { [id]: 'sure, go ahead' }); });
    expect(sentResult().action).toBe('decline');
  });

  it('maps closing the dialog to cancel', () => {
    const result = requestElicitation(emptySchema);
    act(() => { result.current.handleAskUserQuestionCancel('mcp-key'); });
    expect(sentResult()).toEqual({ action: 'cancel', content: null, _meta: meta });
  });

  it('still reports malformed schemas as invalid question data', () => {
    expect(requestElicitation(undefined).current.currentAskUserQuestionRequest?.questions).toEqual([]);
    expect(requestElicitation({ type: 'object' }).current.currentAskUserQuestionRequest?.questions).toEqual([]);
  });

  it('keeps one question per field for a normal form', () => {
    const result = requestElicitation({ type: 'object', properties: { name: { type: 'string' } } });
    const questions = result.current.currentAskUserQuestionRequest?.questions;
    expect(questions?.map(question => question.id)).toEqual(['name']);
  });
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
