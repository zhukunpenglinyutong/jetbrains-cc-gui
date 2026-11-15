import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AskUserQuestionDialog, { type AskUserQuestionRequest } from './AskUserQuestionDialog';
import { formatAnswers, normalizeQuestions } from './AskUserQuestionDialog/answerState';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : _key),
  }),
}));

const questions: AskUserQuestionRequest['questions'] = [{
  id: 'approval',
  question: 'Allow the noop tool?',
  header: 'noop',
  options: [{ label: 'Allow', description: '' }, { label: 'Deny', description: '' }],
  multiSelect: false,
  required: true,
  choiceOnly: true,
}];

describe('choice-only question', () => {
  it('offers neither the Other row nor a free-text box', () => {
    render(
      <AskUserQuestionDialog
        isOpen
        request={{ requestId: 'r', toolName: 'mcpServer/elicitation/request', questions }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        timeoutSeconds={300}
      />,
    );
    expect(screen.queryByPlaceholderText('请输入您的答案...')).toBeNull();
    expect(screen.queryByRole('button', { name: /其他/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Allow/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Deny/ })).toBeTruthy();
  });

  it('submits exactly the selected option', () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionDialog
        isOpen
        request={{ requestId: 'r', toolName: 'mcpServer/elicitation/request', questions }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        timeoutSeconds={300}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Allow/ }));
    fireEvent.click(screen.getByText('提交'));
    expect(onSubmit).toHaveBeenCalledWith('r', { approval: 'Allow' });
  });

  it('ignores free text restored from a draft', () => {
    const result = formatAnswers(
      normalizeQuestions(questions),
      { approval: new Set(['Deny']) },
      { approval: 'sure, go ahead' },
    );
    expect(result.approval).toBe('Deny');
  });
});
