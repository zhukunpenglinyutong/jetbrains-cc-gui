import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
