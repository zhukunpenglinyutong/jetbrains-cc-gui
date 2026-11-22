import { describe, expect, it } from 'vitest';
import {
  buildInitialAnswerState,
  formatAnswers,
  normalizeQuestions,
  toggleAnswerSelection,
  withBlankOptionalAnswers,
} from './answerState';

describe('native question dictionary keys', () => {
  it.each(['__proto__', 'constructor', 'toString'])('preserves the literal %s question id through selection and submission', id => {
    const request = { requestId: 'dictionary', toolName: 'requestUserInput', questions: [{ id, question: 'Choose a value', header: 'value',
      options: [{ label: 'selected', description: '' }], multiSelect: false }] };
    const { initialAnswers, initialCustomInputs } = buildInitialAnswerState(request);
    expect(Object.hasOwn(initialAnswers, id)).toBe(true);
    expect(Object.hasOwn(initialCustomInputs, id)).toBe(true);
    const answers = toggleAnswerSelection(initialAnswers, id, false, 'selected');
    const result = formatAnswers(normalizeQuestions(request.questions), answers, initialCustomInputs);
    expect(JSON.parse(JSON.stringify(result))).toEqual(Object.fromEntries([[id, 'selected']]));
  });
});

describe('preselected options', () => {
  const options = [
    { label: 'Height', description: '' },
    { label: 'Width', description: '', selected: true },
    { label: 'Font', description: '', selected: true },
  ];

  it('opens a multi-select question with every preselected option checked', () => {
    const { initialAnswers } = buildInitialAnswerState({ requestId: 'r', toolName: 'AskUserQuestion',
      questions: [{ id: 'props', question: 'Which?', header: '', options, multiSelect: true }] });
    expect([...initialAnswers.props]).toEqual(['Width', 'Font']);
  });

  it('opens a single-select question with one value at most', () => {
    const { initialAnswers } = buildInitialAnswerState({ requestId: 'r', toolName: 'AskUserQuestion',
      questions: [{ id: 'props', question: 'Which?', header: '', options, multiSelect: false }] });
    expect([...initialAnswers.props]).toEqual(['Width']);
  });
});

describe('withBlankOptionalAnswers', () => {
  const questions = normalizeQuestions([
    { id: 'extras', question: 'Extras?', header: '', options: [{ label: 'A', description: '' }], multiSelect: true, required: false },
    { id: 'note', question: 'Note?', header: '', options: [], multiSelect: false, required: false },
    { id: 'needed', question: 'Which?', header: '', options: [{ label: 'B', description: '' }], multiSelect: false },
  ]);

  it('adds an empty answer for each optional question left blank, and for no other', () => {
    expect(withBlankOptionalAnswers(questions, {})).toEqual({ extras: [], note: '' });
  });

  it('keeps the answers that were given', () => {
    expect(withBlankOptionalAnswers(questions, { extras: ['A'], needed: 'B' }))
      .toEqual({ extras: ['A'], note: '', needed: 'B' });
  });
});
