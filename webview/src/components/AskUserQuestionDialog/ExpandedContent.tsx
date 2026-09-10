import { type RefObject } from 'react';
import type { Question } from '../AskUserQuestionDialog';
import DialogActions from './DialogActions';
import ProgressRow from './ProgressRow';
import QuestionSection from './QuestionSection';

interface ExpandedContentProps {
  current: number;
  total: number;
  remainingSeconds: number;
  isTimeWarning: boolean;
  question: Question;
  selectedLabels: Set<string>;
  customInput: string;
  customInputRef: RefObject<HTMLTextAreaElement | null>;
  onOptionToggle: (label: string) => void;
  onCustomInputChange: (value: string) => void;
  canProceed: boolean;
  onCancel: () => void;
  onBack: () => void;
  onNext: () => void;
}

const ExpandedContent = ({
  current,
  total,
  remainingSeconds,
  isTimeWarning,
  question,
  selectedLabels,
  customInput,
  customInputRef,
  onOptionToggle,
  onCustomInputChange,
  canProceed,
  onCancel,
  onBack,
  onNext,
}: ExpandedContentProps) => {
  return (
    <>
      <ProgressRow
        current={current}
        total={total}
        remainingSeconds={remainingSeconds}
        isTimeWarning={isTimeWarning}
      />

      {/* Question area */}
      <QuestionSection
        question={question}
        selectedLabels={selectedLabels}
        customInput={customInput}
        customInputRef={customInputRef}
        onOptionToggle={onOptionToggle}
        onCustomInputChange={onCustomInputChange}
      />

      {/* Action buttons */}
      <DialogActions
        showBack={current > 1}
        isLastQuestion={current === total}
        canProceed={canProceed}
        onCancel={onCancel}
        onBack={onBack}
        onNext={onNext}
      />
    </>
  );
};

export default ExpandedContent;
