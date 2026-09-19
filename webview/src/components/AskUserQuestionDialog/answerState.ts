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

/**
 * Keep the "Other" marker in sync with the custom text box.
 *
 * The box and the marker used to be independent, so text typed while a
 * predefined option was selected was silently dropped at submit time, and
 * clearing the box left a selected "Other" that could never satisfy
 * `canProceed`. Typing now selects "Other" (on a single-select question that
 * replaces the picked option, which is the only value that question can carry),
 * and emptying the box detaches it again.
 */
export const syncOtherSelection = (
  prev: Record<string, Set<string>>,
  questionKey: string,
  multiSelect: boolean,
  hasText: boolean,
): Record<string, Set<string>> => {
  const currentSet = prev[questionKey] || new Set<string>();
  const markerSelected = currentSet.has(OTHER_OPTION_MARKER);
  if (hasText && !markerSelected) {
    return toggleAnswerSelection(prev, questionKey, multiSelect, OTHER_OPTION_MARKER);
  }
  if (!hasText && markerSelected) {
    // An "Other" answer without text answers nothing, so emptying the box
    // releases the marker in both modes. toggleAnswerSelection only ever
    // selects on a single-select question, hence the explicit removal there;
    // multi-select toggles the marker off, so the row does not stay checked
    // over an empty box (which looked selected yet blocked canProceed).
    if (multiSelect) {
      return toggleAnswerSelection(prev, questionKey, true, OTHER_OPTION_MARKER);
    }
    return { ...prev, [questionKey]: new Set<string>() };
  }
  return prev;
};

export const formatAnswers = (
  questions: Question[],
  answers: Record<string, Set<string>>,
  customInputs: Record<string, string>,
): Record<string, string | string[]> => {
  const formattedAnswers: Record<string, string | string[]> = {};
  questions.forEach((q) => {
    const selectedSet = answers[q.question] || new Set<string>();
    const customText = (customInputs[q.question] || '').trim();

    // Filter out the "Other" marker, get actually selected options
    const selectedLabels = Array.from(selectedSet).filter(label => label !== OTHER_OPTION_MARKER);

    // A typed custom answer always travels with the answer, whether or not the
    // "Other" row still carries the marker (a restored draft can disagree).
    // Single-select questions carry exactly one value, and the custom answer
    // wins there — the same precedence the DSH answer encoding expects, where
    // `custom` overrides the selected choice.
    if (customText) {
      formattedAnswers[q.question] = q.multiSelect ? [...selectedLabels, customText] : customText;
      return;
    }

    if (selectedLabels.length > 0) {
      formattedAnswers[q.question] = q.multiSelect ? selectedLabels : selectedLabels[0]!;
    }
  });
  return formattedAnswers;
};
