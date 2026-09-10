import type { AskUserQuestionRequest, Question } from '../AskUserQuestionDialog';
import { OTHER_OPTION_MARKER } from './constants';
import { normalizeQuestion } from './normalizeQuestion';

export const normalizeQuestions = (rawQuestions: unknown): Question[] =>
  (Array.isArray(rawQuestions) ? rawQuestions : [])
    .flatMap((raw) => {
      const question = normalizeQuestion(raw);
      return question === null ? [] : [question];
    });

export const buildInitialAnswerState = (request: AskUserQuestionRequest) => {
  const questions = normalizeQuestions(request.questions);

  const initialAnswers: Record<string, Set<string>> = {};
  const initialCustomInputs: Record<string, string> = {};
  questions.forEach((q) => {
    initialAnswers[q.question] = new Set<string>();
    initialCustomInputs[q.question] = '';
  });
  return { initialAnswers, initialCustomInputs };
};

export const toggleAnswerSelection = (
  prev: Record<string, Set<string>>,
  questionKey: string,
  multiSelect: boolean,
  label: string,
): Record<string, Set<string>> => {
  const newAnswers = { ...prev };
  const currentSet = new Set(newAnswers[questionKey] || []);

  if (multiSelect) {
    // Multi-select mode: toggle option
    if (currentSet.has(label)) {
      currentSet.delete(label);
    } else {
      currentSet.add(label);
    }
  } else {
    // Single-select mode: clear and set new option
    currentSet.clear();
    currentSet.add(label);
  }

  newAnswers[questionKey] = currentSet;
  return newAnswers;
};

export const formatAnswers = (
  questions: Question[],
  answers: Record<string, Set<string>>,
  customInputs: Record<string, string>,
): Record<string, string | string[]> => {
  const formattedAnswers: Record<string, string | string[]> = {};
  questions.forEach((q) => {
    const selectedSet = answers[q.question] || new Set<string>();
    const customText = customInputs[q.question] || '';

    // Filter out the "Other" marker, get actually selected options
    const selectedLabels = Array.from(selectedSet).filter(label => label !== OTHER_OPTION_MARKER);

    // If "Other" is selected and has custom input, add the custom input to answers
    if (selectedSet.has(OTHER_OPTION_MARKER) && customText.trim()) {
      selectedLabels.push(customText.trim());
    }

    if (selectedLabels.length > 0) {
      formattedAnswers[q.question] = q.multiSelect ? selectedLabels : selectedLabels[0]!;
    }
  });
  return formattedAnswers;
};
