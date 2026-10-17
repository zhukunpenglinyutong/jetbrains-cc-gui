import { act, renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import { sendBridgeEvent } from '../utils/bridge';
import { useDialogManagement } from './useDialogManagement';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));

const t = ((key: string) => key) as any;

// Regression coverage for issue #1360. When the Java safety-net timer fires, or
// a session switch calls clearPendingRequests, the backend force-closes the
// WebView dialogs. forceClose*(null) means "close every dialog of this kind" and
// MUST drain the entire pending queue — otherwise the active dialog is closed,
// the queue-draining effect immediately re-opens the next queued (and now stale)
// request, and a dialog from a previous session resurfaces in the new one.
describe('useDialogManagement - forceClose queue draining (issue #1360)', () => {
  const mkAsk = (requestId: string) => ({ requestId } as any);
  const mkPermission = (channelId: string) => ({ channelId } as any);
  const mkPlan = (requestId: string) => ({ requestId } as any);

  it('forceCloseAskUserQuestionDialog(null) drains the whole queue; no queued dialog resurfaces', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    // A becomes the active dialog, B is enqueued behind it.
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('A');

    act(() => { result.current.forceCloseAskUserQuestionDialog(null); });

    // The whole queue must be gone — B must NOT resurface after A is closed.
    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(result.current.currentAskUserQuestionRequest).toBeNull();
  });

  it('forceCloseAskUserQuestionDialog(id) closes the matching active dialog and lets the next queued one surface', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });

    act(() => { result.current.forceCloseAskUserQuestionDialog('A'); });

    // Only A was targeted, so the genuine follow-up B should open next.
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('B');
  });

  it('forceCloseAskUserQuestionDialog(id) for a queued-only id leaves the active dialog intact and prunes just that entry', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });

    // B is only queued (A is active); force-closing B must NOT touch A.
    act(() => { result.current.forceCloseAskUserQuestionDialog('B'); });
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('A');

    // Closing A now finds an empty queue (B was pruned) — nothing resurfaces.
    act(() => { result.current.forceCloseAskUserQuestionDialog('A'); });
    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(result.current.currentAskUserQuestionRequest).toBeNull();
  });

  it('replaces an open Grok question instead of queueing it behind the old dialog', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    const ask = (requestId: string) => ({
      requestId,
      provider: 'grok' as const,
      toolName: 'AskUserQuestion',
      questions: [],
      dialogToken: `token-${requestId}`,
    });

    act(() => { result.current.openAskUserQuestionDialog(ask('A')); });
    act(() => { result.current.openAskUserQuestionDialog(ask('B')); });

    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('B');
    expect(sendBridgeEvent).toHaveBeenCalledWith(
      'ask_user_question_response',
      JSON.stringify({ requestId: 'A', dialogToken: 'token-A', answers: {} }),
    );
  });

  it('ignores a replay of the Grok question that was just replaced', () => {
    vi.mocked(sendBridgeEvent).mockClear();
    const { result } = renderHook(() => useDialogManagement({ t }));
    const ask = (requestId: string) => ({
      requestId,
      provider: 'grok' as const,
      toolName: 'AskUserQuestion',
      questions: [],
      dialogToken: `token-${requestId}`,
    });

    act(() => { result.current.openAskUserQuestionDialog(ask('A')); });
    act(() => { result.current.openAskUserQuestionDialog(ask('B')); });
    act(() => { result.current.openAskUserQuestionDialog(ask('A')); });

    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('B');
    expect(sendBridgeEvent).toHaveBeenCalledTimes(1);
    expect(sendBridgeEvent).toHaveBeenCalledWith(
      'ask_user_question_response',
      JSON.stringify({ requestId: 'A', dialogToken: 'token-A', answers: {} }),
    );
  });

  it('answers a queued Grok question when a newer one arrives behind another provider', () => {
    vi.mocked(sendBridgeEvent).mockClear();
    const { result } = renderHook(() => useDialogManagement({ t }));
    const ask = (requestId: string, provider: 'claude' | 'codex' | 'grok') => ({
      requestId,
      provider,
      toolName: 'AskUserQuestion',
      questions: [],
      dialogToken: `token-${requestId}`,
    });

    act(() => { result.current.openAskUserQuestionDialog(ask('C', 'claude')); });
    act(() => { result.current.openAskUserQuestionDialog(ask('D', 'codex')); });
    act(() => { result.current.openAskUserQuestionDialog(ask('A', 'grok')); });
    act(() => { result.current.openAskUserQuestionDialog(ask('B', 'grok')); });

    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('C');
    expect(sendBridgeEvent).toHaveBeenCalledWith(
      'ask_user_question_response',
      JSON.stringify({ requestId: 'A', dialogToken: 'token-A', answers: {} }),
    );
    expect(sendBridgeEvent).not.toHaveBeenCalledWith(
      'ask_user_question_response',
      JSON.stringify({ requestId: 'B', dialogToken: 'token-B', answers: {} }),
    );
    expect(sendBridgeEvent).not.toHaveBeenCalledWith(
      'ask_user_question_response',
      JSON.stringify({ requestId: 'D', dialogToken: 'token-D', answers: {} }),
    );

    act(() => { result.current.forceCloseAskUserQuestionDialog('C', 'token-C'); });

    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('D');
  });

  it('forceClosePermissionDialog(null) drains the whole permission queue', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });
    expect(result.current.permissionDialogOpen).toBe(true);

    act(() => { result.current.forceClosePermissionDialog(null); });

    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.currentPermissionRequest).toBeNull();
  });

  it('forceClosePlanApprovalDialog(null) drains the whole plan-approval queue', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openPlanApprovalDialog(mkPlan('A')); });
    act(() => { result.current.openPlanApprovalDialog(mkPlan('B')); });
    expect(result.current.planApprovalDialogOpen).toBe(true);

    act(() => { result.current.forceClosePlanApprovalDialog(null); });

    expect(result.current.planApprovalDialogOpen).toBe(false);
    expect(result.current.currentPlanApprovalRequest).toBeNull();
  });
});

const request = (id: string, dialogToken: string, deadlineMs = 5_000) => ({
  channelId: id, requestId: id, dialogToken, deadlineMs,
  toolName: 'test', inputs: {}, questions: [],
});

type Dialogs = ReturnType<typeof useDialogManagement>;
const cases = [
  {
    kind: 'permission',
    open: (d: Dialogs) => d.openPermissionDialog,
    close: (d: Dialogs) => d.forceClosePermissionDialog,
    current: (d: Dialogs) => d.currentPermissionRequest,
    submit: (d: Dialogs) => d.handlePermissionApprove('C'),
  },
  {
    kind: 'askUserQuestion',
    open: (d: Dialogs) => d.openAskUserQuestionDialog,
    close: (d: Dialogs) => d.forceCloseAskUserQuestionDialog,
    current: (d: Dialogs) => d.currentAskUserQuestionRequest,
    submit: (d: Dialogs) => d.handleAskUserQuestionSubmit('C', {}),
  },
  {
    kind: 'planApproval',
    open: (d: Dialogs) => d.openPlanApprovalDialog,
    close: (d: Dialogs) => d.forceClosePlanApprovalDialog,
    current: (d: Dialogs) => d.currentPlanApprovalRequest,
    submit: (d: Dialogs) => d.handlePlanApprovalApprove('C', 'default'),
  },
];

describe.each(cases)('$kind request token isolation', (dialog) => {
  it('blocks a closed request replay, not a fresh request with an earlier deadline', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => { dialog.open(result.current)(request('C', 'old', 9_000)); });
    act(() => { dialog.close(result.current)('C', 'old'); });
    act(() => { dialog.open(result.current)(request('C', 'old', 9_000)); });
    expect(dialog.current(result.current)).toBeNull();
    act(() => { dialog.open(result.current)(request('C', 'new', 5_000)); });
    expect(dialog.current(result.current)?.dialogToken).toBe('new');
  });

  it('ignores an old close even if its deadline was later than the live request', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => { dialog.open(result.current)(request('C', 'new', 5_000)); });
    act(() => { dialog.close(result.current)('C', 'old'); });
    expect(dialog.current(result.current)?.dialogToken).toBe('new');
  });

  it('retains distinct requests with the same id in the pending queue', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => {
      dialog.open(result.current)(request('C', 'old'));
      dialog.open(result.current)(request('C', 'new'));
      dialog.open(result.current)(request('C', 'new'));
    });
    act(() => { dialog.close(result.current)('C', 'old'); });
    expect(dialog.current(result.current)?.dialogToken).toBe('new');
    act(() => { dialog.close(result.current)('C', 'new'); });
    expect(dialog.current(result.current)).toBeNull();
  });

  it('does not reopen a submitted request when a delayed show arrives', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => { dialog.open(result.current)(request('C', 'old')); });
    act(() => { dialog.submit(result.current); });
    act(() => { dialog.open(result.current)(request('C', 'old')); });
    expect(dialog.current(result.current)).toBeNull();
  });

  it('closes every generation when explicitly asked to close all', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));
    act(() => {
      dialog.open(result.current)(request('C', 'old'));
      dialog.open(result.current)(request('C', 'new'));
      dialog.close(result.current)(null);
    });
    act(() => { dialog.open(result.current)(request('C', 'new')); });
    expect(dialog.current(result.current)).toBeNull();
  });
});
