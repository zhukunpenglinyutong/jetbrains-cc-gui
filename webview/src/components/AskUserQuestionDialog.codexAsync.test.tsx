import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import AskUserQuestionDialog from './AskUserQuestionDialog';
import { useDialogManagement } from '../hooks/useDialogManagement';
import { registerPermissionCallbacks } from '../hooks/windowCallbacks/registerCallbacks/permissionCallbacks';
import { sendBridgeEvent } from '../utils/bridge';

vi.mock('../utils/bridge', () => ({ sendBridgeEvent: vi.fn(() => true) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({
  t: (key: string, fallback?: string) => fallback ?? key,
}) }));

const t = ((key: string) => key) as TFunction;

function QuestionPage() {
  const dialogs = useDialogManagement({ t });
  registerPermissionCallbacks({ ...dialogs, addToast: vi.fn(),
    currentProviderRef: { current: 'codex' }, currentSessionIdRef: { current: 'thread' } });
  return <AskUserQuestionDialog isOpen={dialogs.askUserQuestionDialogOpen}
    request={dialogs.currentAskUserQuestionRequest}
    onSubmit={dialogs.handleAskUserQuestionSubmit} onCancel={dialogs.handleAskUserQuestionCancel} />;
}

afterEach(() => {
  delete window.onCodexRuntimeEvent;
  vi.clearAllMocks();
});

it.each([false, true])('renders native async choices and returns the selected B or cancellation: %s', cancel => {
  const { container } = render(<QuestionPage />);
  const event = JSON.stringify({ kind: 'interactionRequested', interactionKey: 'async-key',
    dialogToken: 'async-token', deliverySequence: 1,
    payload: { method: 'item/agentMessage/requestUserInput', params: { isBlocking: false,
      questions: [{ id: 'question-1', question: 'Choose A, B or C', header: '', multiSelect: false,
        options: ['A', 'B', 'C'].map(label => ({ label, description: '' })) }] } } });
  act(() => window.onCodexRuntimeEvent?.(event));
  act(() => window.onCodexRuntimeEvent?.(event));
  expect(container.querySelectorAll('.non-blocking-question')).toHaveLength(1);
  expect(screen.getByText('Choose A, B or C')).toBeTruthy();
  fireEvent.click(screen.getByText('B'));
  fireEvent.click(screen.getByText(cancel ? '取消' : '提交'));
  const replies = vi.mocked(sendBridgeEvent).mock.calls.filter(([name]) => name === 'codex_interaction_response');
  expect(replies).toHaveLength(1);
  expect(JSON.parse(replies[0]![1]!).result).toEqual({
    answers: cancel ? {} : { 'question-1': { answers: ['B'] } },
  });
  expect(container.querySelector('.non-blocking-question')).toBeNull();
});
