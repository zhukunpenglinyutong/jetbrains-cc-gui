import { useEffect, useState, type RefObject } from 'react';
import type { AskUserQuestionRequest, Question } from '../AskUserQuestionDialog';
import { isEditableEventTarget } from '../../utils/isEditableEventTarget';
import { OTHER_OPTION_MARKER, MAX_CUSTOM_INPUT_LENGTH } from './constants';
import { buildInitialAnswerState, formatAnswers, toggleAnswerSelection } from './answerState';

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

  useEffect(() => {
    if (isOpen && request) {
      const { initialAnswers, initialCustomInputs } = buildInitialAnswerState(request);
      setAnswers(initialAnswers);
      setCustomInputs(initialCustomInputs);
      setCurrentQuestionIndex(0);
      setIsCollapsed(false);
    }
  }, [isOpen, request?.requestId]);

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
  const isOtherSelected = currentAnswerSet.has(OTHER_OPTION_MARKER);

  const handleSubmitFinal = () => {
    if (!markSubmitted() || !request) return;

    onSubmit(request.requestId, formatAnswers(normalizedQuestions, answers, customInputs));
  };

  const handleOptionToggle = (label: string) => {
    if (!currentQuestion) return;

    setAnswers((prev) => toggleAnswerSelection(prev, currentQuestion.question, currentQuestion.multiSelect, label));

    // Auto-focus the input field when "Other" option is selected
    if (label === OTHER_OPTION_MARKER) {
      setTimeout(() => {
        customInputRef.current?.focus();
      }, 0);
    }
  };

  const handleCustomInputChange = (value: string) => {
    if (!currentQuestion) return;

    // Limit input length to prevent excessively long input
    const sanitizedValue = value.slice(0, MAX_CUSTOM_INPUT_LENGTH);
    setCustomInputs((prev) => ({
      ...prev,
      [currentQuestion.question]: sanitizedValue,
    }));
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
  // 2. Or "Other" is selected with valid custom input
  const hasRegularSelection = Array.from(currentAnswerSet).some(label => label !== OTHER_OPTION_MARKER);
  const hasValidCustomInput = isOtherSelected && currentCustomInput.trim().length > 0;
  const canProceed = hasRegularSelection || hasValidCustomInput;

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
