import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AskUserQuestionDialog, { type AskUserQuestionRequest } from './AskUserQuestionDialog';
import { OTHER_OPTION_MARKER } from './AskUserQuestionDialog/constants';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : _key),
  }),
}));

/**
 * The manual answer and the option list must work together.
 *
 * Regression: the custom input only rendered while the "Other" row was ticked
 * and `formatAnswers` only attached its text in that state, so
 *   - a question with options could not be answered with "option + a note",
 *   - a question without options required discovering the "Other" row first,
 *   - text typed before clicking an option was silently dropped at submit.
 */

const OPTIONS = [
  { label: '1. 选项一', description: 'desc 1' },
  { label: '2. 选项二', description: 'desc 2' },
  { label: '3. 选项三', description: 'desc 3' },
];

const OTHER_PLACEHOLDER = '请输入您的答案...';

const renderDialog = (questions: AskUserQuestionRequest['questions']) => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  render(
    <AskUserQuestionDialog
      isOpen
      request={{ requestId: 'other-input-1', toolName: 'AskUserQuestion', questions }}
      onSubmit={onSubmit}
      onCancel={onCancel}
      timeoutSeconds={300}
    />,
  );
  return { onSubmit, onCancel };
};

const question = (
  options: AskUserQuestionRequest['questions'][number]['options'],
  multiSelect = false,
): AskUserQuestionRequest['questions'] => [
  { question: 'Q', header: 'H', multiSelect, options },
];

const customBox = () => screen.getByPlaceholderText(OTHER_PLACEHOLDER) as HTMLTextAreaElement;
const optionRow = (label: string) =>
  screen.getByRole('button', { name: new RegExp(label) }) as HTMLButtonElement;
const otherRow = () => optionRow('其他');
const submit = () => fireEvent.click(screen.getByText('提交'));

describe('AskUserQuestionDialog manual answer', () => {
  it('always offers the input, even before "Other" is clicked', () => {
    renderDialog(question(OPTIONS));
    expect(customBox()).toBeTruthy();
    expect(otherRow().className).not.toContain('selected');
  });

  it('typing selects the "Other" row so the text is part of the answer', () => {
    const { onSubmit } = renderDialog(question(OPTIONS));

    fireEvent.change(customBox(), { target: { value: '我自己的答案' } });

    expect(otherRow().className).toContain('selected');
    submit();
    expect(onSubmit).toHaveBeenCalledWith('other-input-1', { Q: '我自己的答案' });
  });

  it('single-select: a typed answer replaces the picked option', () => {
    const { onSubmit } = renderDialog(question(OPTIONS));

    fireEvent.click(optionRow('1. 选项一'));
    fireEvent.change(customBox(), { target: { value: '我要自己写' } });

    // The option is released — a single-select question can only carry one value.
    expect(optionRow('1. 选项一').className).not.toContain('selected');
    submit();
    expect(onSubmit).toHaveBeenCalledWith('other-input-1', { Q: '我要自己写' });
  });

  it('single-select: picking an option afterwards clears the typed text', () => {
    const { onSubmit } = renderDialog(question(OPTIONS));

    fireEvent.change(customBox(), { target: { value: '先打了一段' } });
    fireEvent.click(optionRow('2. 选项二'));

    expect(customBox().value).toBe('');
    expect(otherRow().className).not.toContain('selected');
    submit();
    expect(onSubmit).toHaveBeenCalledWith('other-input-1', { Q: '2. 选项二' });
  });

  it('multi-select: options and a typed answer are submitted together', () => {
    const { onSubmit } = renderDialog(question(OPTIONS, true));

    fireEvent.click(optionRow('1. 选项一'));
    fireEvent.change(customBox(), { target: { value: '补充说明' } });

    expect(optionRow('1. 选项一').className).toContain('selected');
    submit();
    expect(onSubmit).toHaveBeenCalledWith('other-input-1', { Q: ['1. 选项一', '补充说明'] });
  });

  it('a question without options is answered by typing, with no "Other" row', () => {
    const { onSubmit } = renderDialog(question([]));

    expect(screen.queryByText('其他')).toBeNull();
    expect(document.activeElement).toBe(customBox());

    fireEvent.change(customBox(), { target: { value: '自由文本答案' } });
    submit();
    expect(onSubmit).toHaveBeenCalledWith('other-input-1', { Q: '自由文本答案' });
  });

  it('a question without options cannot be submitted empty', () => {
    const { onSubmit, onCancel } = renderDialog(question([]));

    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('clearing the box detaches the "Other" selection again (single-select)', () => {
    const { onSubmit } = renderDialog(question(OPTIONS));

    fireEvent.change(customBox(), { target: { value: '写了一点' } });
    fireEvent.change(customBox(), { target: { value: '' } });

    expect(otherRow().className).not.toContain('selected');
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clearing the box detaches the "Other" selection again (multi-select)', () => {
    const { onSubmit } = renderDialog(question(OPTIONS, true));

    fireEvent.change(customBox(), { target: { value: '写了一点' } });
    expect(otherRow().className).toContain('selected');
    fireEvent.change(customBox(), { target: { value: '' } });

    // The row must not stay checked over an empty box — that state looked
    // selected yet satisfied nothing, so Submit stayed disabled.
    expect(otherRow().className).not.toContain('selected');
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clicking the "Other" row still focuses the input', () => {
    renderDialog(question(OPTIONS));

    fireEvent.click(otherRow());
    expect(otherRow().className).toContain('selected');
    expect(document.activeElement).toBe(customBox());
  });
});

// The marker stays an internal detail of the answer encoding.
describe('AskUserQuestionDialog answer encoding', () => {
  it('never submits the internal marker to the backend', () => {
    const { onSubmit } = renderDialog(question(OPTIONS));

    fireEvent.click(otherRow());
    fireEvent.change(customBox(), { target: { value: 'abc' } });
    submit();

    const [, answers] = onSubmit.mock.calls[0];
    expect(JSON.stringify(answers)).not.toContain(OTHER_OPTION_MARKER);
  });
});
