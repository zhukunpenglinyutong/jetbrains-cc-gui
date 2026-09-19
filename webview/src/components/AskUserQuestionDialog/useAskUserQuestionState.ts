import { useEffect, useState, type RefObject } from 'react';
import type { AskUserQuestionRequest, Question } from '../AskUserQuestionDialog';
import { isEditableEventTarget } from '../../utils/isEditableEventTarget';
import { OTHER_OPTION_MARKER, MAX_CUSTOM_INPUT_LENGTH } from './constants';
import { buildInitialAnswerState, formatAnswers, syncOtherSelection, toggleAnswerSelection } from './answerState';
import { clearDialogDraft, readDialogDraft, writeDialogDraft } from '../../utils/dialogStateStorage';

interface AskUserQuestionDraft {
  deadlineMs?: number;
  dialogToken?: string;
  answers?: Record<string, string[]>;
  customInputs?: Record<string, string>;
  currentQuestionIndex?: number;
  isCollapsed?: boolean;
}

interface UseAskUserQuestionStateParams {
  isOpen: boolean;
  request: AskUserQuestionRequest | null;
  normalizedQuestions: Question[];
  customInputRef: RefObject<HTMLTextAreaElement | null>;
  markSubmitted: () => boolean;
  onSubmit: (requestId: string, answers: Record<string, string | string[]>) => void;
  onCancel: () => void;
}

export const useAskUserQuestionState = ({
  isOpen,
  request,
  normalizedQuestions,
  customInputRef,
  markSubmitted,
  onSubmit,
  onCancel,
}: UseAskUserQuestionStateParams) => {
  const [answers, setAnswers] = useState<Record<string, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({});
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [hydratedRequestKey, setHydratedRequestKey] = useState<string | null>(null);

  // Hydrate draft state exactly once per request via render-time adjustment:
  // the key is derived during render and the previous-key state tracks which
  // request has already been hydrated (no effect chain, no extra commit).
  const requestKey = isOpen && request ? request.dialogToken ?? request.requestId : null;
  if (hydratedRequestKey !== requestKey) {
    setHydratedRequestKey(requestKey);
    if (requestKey !== null && request) {
      const { initialAnswers, initialCustomInputs } = buildInitialAnswerState(request);
      const draft = readDialogDraft<AskUserQuestionDraft>('askUserQuestion', request.requestId, request.deadlineMs, request.dialogToken);
      if (draft?.answers) {
        for (const [question, labels] of Object.entries(draft.answers)) {
          if (Array.isArray(labels)) {
            initialAnswers[question] = new Set(labels.filter((label): label is string => typeof label === 'string'));
          }
        }
      }
      if (draft?.customInputs && typeof draft.customInputs === 'object') {
        for (const [question, value] of Object.entries(draft.customInputs)) {
          if (typeof value === 'string') {
            initialCustomInputs[question] = value.slice(0, MAX_CUSTOM_INPUT_LENGTH);
          }
        }
      }
      setAnswers(initialAnswers);
      setCustomInputs(initialCustomInputs);
      setCurrentQuestionIndex(
        typeof draft?.currentQuestionIndex === 'number' && Number.isInteger(draft.currentQuestionIndex)
          ? Math.max(0, draft.currentQuestionIndex)
          : 0,
      );
      setIsCollapsed(draft?.isCollapsed === true);
    }
  }

  useEffect(() => {
    const requestId = request?.requestId;
    const deadlineMs = request?.deadlineMs;
    if (!isOpen || requestId === undefined) {
      return;
    }
    const serializedAnswers: Record<string, string[]> = {};
    for (const [question, labels] of Object.entries(answers)) {
      serializedAnswers[question] = Array.from(labels);
    }
    writeDialogDraft('askUserQuestion', requestId, {
      deadlineMs,
      dialogToken: request?.dialogToken,
      answers: serializedAnswers,
      customInputs,
      currentQuestionIndex,
      isCollapsed,
    });
  }, [
    answers,
    customInputs,
    currentQuestionIndex,
    isCollapsed,
    isOpen,
    request?.requestId,
    request?.dialogToken,
    request?.deadlineMs,
  ]);

  // Keyboard event handling - separate effect to avoid frequent listener registration/removal
  useEffect(() => {
    if (!isOpen || !request) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) {
        return;
      }

      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, request, onCancel]);

  // FIX: Ensure currentQuestionIndex does not go out of bounds
  // When request changes cause normalizedQuestions length to decrease,
  // currentQuestionIndex may still hold the old value (since useEffect state updates are async)
  const safeQuestionIndex = Math.max(0, Math.min(currentQuestionIndex, normalizedQuestions.length - 1));
  const currentQuestion = normalizedQuestions[safeQuestionIndex];
  const isLastQuestion = safeQuestionIndex === normalizedQuestions.length - 1;
  const currentAnswerSet = (currentQuestion && answers[currentQuestion.question]) || new Set<string>();
  const currentCustomInput = (currentQuestion && customInputs[currentQuestion.question]) || '';

  const handleSubmitFinal = () => {
    if (!markSubmitted() || !request) return;

    onSubmit(request.requestId, formatAnswers(normalizedQuestions, answers, customInputs));
    clearDialogDraft('askUserQuestion', request.requestId, request.dialogToken);
  };

  const handleOptionToggle = (label: string) => {
    if (!currentQuestion) return;

    const questionKey = currentQuestion.question;
    setAnswers((prev) => toggleAnswerSelection(prev, questionKey, currentQuestion.multiSelect, label));

    // Single-select questions carry one value: picking a predefined option
    // retires the typed answer, so the box never keeps text that would be
    // silently left out of the submission.
    if (!currentQuestion.multiSelect && label !== OTHER_OPTION_MARKER) {
      setCustomInputs((prev) => (prev[questionKey] ? { ...prev, [questionKey]: '' } : prev));
    }

    // Auto-focus the input field when "Other" option is selected. The box is
    // always mounted now, so it can take focus in the same tick.
    if (label === OTHER_OPTION_MARKER) {
      customInputRef.current?.focus();
    }
  };

  const handleCustomInputChange = (value: string) => {
    if (!currentQuestion) return;

    // Limit input length to prevent excessively long input
    const sanitizedValue = value.slice(0, MAX_CUSTOM_INPUT_LENGTH);
    const questionKey = currentQuestion.question;
    setCustomInputs((prev) => ({
      ...prev,
      [questionKey]: sanitizedValue,
    }));
    // Typing is an answer: attach the "Other" marker so the text is submitted.
    setAnswers((prev) =>
      syncOtherSelection(prev, questionKey, currentQuestion.multiSelect, sanitizedValue.trim().length > 0),
    );
  };

  const handleNext = () => {
    if (isLastQuestion) {
      handleSubmitFinal();
    } else {
      setCurrentQuestionIndex((prev) => prev + 1);
    }
  };

  const handleBack = () => {
    if (safeQuestionIndex > 0) {
      setCurrentQuestionIndex((prev) => Math.max(0, prev - 1));
    }
  };

  // Check if we can proceed:
  // 1. A regular option (not "Other") is selected
  // 2. Or a custom answer has been typed (the box is a valid answer on its own,
  //    even for a question that offers options)
  const hasRegularSelection = Array.from(currentAnswerSet).some(label => label !== OTHER_OPTION_MARKER);
  const hasCustomText = currentCustomInput.trim().length > 0;
  const canProceed = hasRegularSelection || hasCustomText;

  return {
    isCollapsed,
    setIsCollapsed,
    safeQuestionIndex,
    currentQuestion,
    isLastQuestion,
    currentAnswerSet,
    currentCustomInput,
    canProceed,
    handleOptionToggle,
    handleCustomInputChange,
    handleNext,
    handleBack,
  };
};
