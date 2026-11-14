import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { useDialogManagement } from './useDialogManagement';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn(() => false), openBrowserExternal: vi.fn() }));

describe('Codex decision transport failure', () => {
  beforeEach(() => vi.mocked(sendBridgeEvent).mockReset().mockReturnValue(false));

  it.each(['handlePermissionApprove', 'handlePermissionApproveAlways', 'handlePermissionSkip',
    'handlePermissionCancel', 'handlePermissionDecision'] as const)('retains %s for a successful retry', action => {
    const { result } = renderHook(() => useDialogManagement({ t: ((key: string) => key) as any }));
    const request = { channelId: 'channel', toolName: 'command', inputs: {},
      provider: 'codex' as const, codexInteractionKey: 'approval', dialogToken: 'approval-page' };
    act(() => result.current.openPermissionDialog(request));
    const send = () => action === 'handlePermissionDecision'
      ? result.current[action]('channel', { decision: 'acceptForSession' }) : result.current[action]('channel');
    act(() => { expect(send()).toBe(false); });
    expect(result.current.currentPermissionRequest).toEqual(request);
    expect(result.current.permissionDialogOpen).toBe(true);
    vi.mocked(sendBridgeEvent).mockReturnValue(true);
    act(send);
    expect(result.current.permissionDialogOpen).toBe(false);
    expect(sendBridgeEvent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['item/tool/requestUserInput', 'handleAskUserQuestionSubmit'],
    ['item/tool/requestUserInput', 'handleAskUserQuestionCancel'],
    ['mcpServer/elicitation/request', 'handleAskUserQuestionSubmit'],
    ['mcpServer/elicitation/request', 'handleAskUserQuestionCancel'],
  ] as const)('retains %s %s for a successful retry', (method, action) => {
    const { result } = renderHook(() => useDialogManagement({ t: ((key: string) => key) as any }));
    const request = { requestId: 'question', toolName: 'requestUserInput', questions: [],
      provider: 'codex' as const, codexMethod: method, codexInteractionKey: 'question', dialogToken: 'question-page' };
    act(() => result.current.openAskUserQuestionDialog(request));
    const send = () => action === 'handleAskUserQuestionSubmit'
      ? result.current[action]('question', { answer: 'retained' }) : result.current[action]('question');
    act(() => { expect(send()).toBe(false); });
    expect(result.current.currentAskUserQuestionRequest).toEqual(request);
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    vi.mocked(sendBridgeEvent).mockReturnValue(true);
    act(send);
    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(sendBridgeEvent).toHaveBeenCalledTimes(2);
  });

  it('retains an approval and a question until their decision can be sent', () => {
    const { result } = renderHook(() => useDialogManagement({ t: ((key: string) => key) as any }));
    act(() => result.current.openPermissionDialog({ channelId: 'channel', toolName: 'command', inputs: {},
      provider: 'codex', codexInteractionKey: 'approval', dialogToken: 'approval-page' }));
    act(() => result.current.handlePermissionApprove('channel'));
    expect(result.current.permissionDialogOpen).toBe(true);
    act(() => result.current.openAskUserQuestionDialog({ requestId: 'question', toolName: 'requestUserInput',
      questions: [], provider: 'codex', codexInteractionKey: 'question', dialogToken: 'question-page' }));
    act(() => result.current.handleAskUserQuestionSubmit('question', { answer: 'retained' }));
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    vi.mocked(sendBridgeEvent).mockReturnValue(true);
    act(() => result.current.handlePermissionApprove('channel'));
    act(() => result.current.handleAskUserQuestionSubmit('question', { answer: 'retained' }));
    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.askUserQuestionDialogOpen).toBe(false);
  });
});

describe('question answers over the file IPC', () => {
  // The hook only calls `t(key)`; i18next's overloaded TFunction is not assignable from a plain function.
  const t = ((key: string) => key) as unknown as TFunction;
  const request = { requestId: 'ask-1', toolName: 'AskUserQuestion', provider: 'omp' as const, dialogToken: 'page',
    questions: [
      { id: 'extras', question: 'Extras?', header: '', options: [{ label: 'A', description: '' }], multiSelect: true, required: false },
      { id: 'needed', question: 'Which?', header: '', options: [{ label: 'B', description: '' }], multiSelect: false },
    ] };

  beforeEach(() => vi.mocked(sendBridgeEvent).mockReset().mockReturnValue(true));

  // The bridge reads an empty answer map as "dismissed", so a submit must not look like one.
  it.each([
    ['a submit names the optional question that was left blank', 'submit', { extras: [], needed: 'B' }],
    ['a dismissal still sends no answers', 'cancel', {}],
  ] as const)('%s', (_name, action, expected) => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => result.current.openAskUserQuestionDialog(request));
    act(() => {
      if (action === 'submit') result.current.handleAskUserQuestionSubmit('ask-1', { needed: 'B' });
      else result.current.handleAskUserQuestionCancel('ask-1');
    });
    const [event, payload] = vi.mocked(sendBridgeEvent).mock.calls.at(-1)!;
    expect(event).toBe('ask_user_question_response');
    expect(JSON.parse(String(payload)).answers).toEqual(expected);
  });
});
