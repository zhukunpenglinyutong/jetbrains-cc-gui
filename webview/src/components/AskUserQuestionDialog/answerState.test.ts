import { describe, expect, it } from 'vitest';
import { buildInitialAnswerState, formatAnswers, normalizeQuestions, toggleAnswerSelection } from './answerState';

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
