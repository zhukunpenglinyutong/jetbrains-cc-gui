import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { Question } from '../AskUserQuestionDialog';
import QuestionOptionRow from './QuestionOptionRow';
import { OTHER_OPTION_MARKER, MAX_CUSTOM_INPUT_LENGTH } from './constants';

interface QuestionSectionProps {
  question: Question;
  selectedLabels: Set<string>;
  customInput: string;
  customInputRef: RefObject<HTMLTextAreaElement | null>;
  onOptionToggle: (label: string) => void;
  onCustomInputChange: (value: string) => void;
}

const QuestionSection = ({
  question,
  selectedLabels,
  customInput,
  customInputRef,
  onOptionToggle,
  onCustomInputChange,
}: QuestionSectionProps) => {
  const { t } = useTranslation();
  const isOtherSelected = selectedLabels.has(OTHER_OPTION_MARKER);

  return (
    <div className="ask-user-question-dialog-question">
      <div className="question-header">
        <span className="question-tag">{question.header}</span>
      </div>
      <p className="question-text">{question.question}</p>

      {/* Options list */}
      <div className="question-options">
        {question.options.map((option) => (
          <QuestionOptionRow
            key={option.label}
            label={option.label}
            description={option.description}
            isSelected={selectedLabels.has(option.label)}
            multiSelect={question.multiSelect}
            onToggle={() => onOptionToggle(option.label)}
          />
        ))}

        {/* "Other" option - allows custom user input */}
        <QuestionOptionRow
          label={t('askUserQuestion.otherOption', '其他')}
          description={t('askUserQuestion.otherOptionDesc', '输入自定义答案')}
          isSelected={isOtherSelected}
          multiSelect={question.multiSelect}
          className="other-option"
          onToggle={() => onOptionToggle(OTHER_OPTION_MARKER)}
        />
      </div>

      {/* Custom input field - only shown when "Other" is selected */}
      {isOtherSelected && (
        <div className="custom-input-container">
          <textarea
            ref={customInputRef}
            className="custom-input"
            value={customInput}
            onChange={(e) => onCustomInputChange(e.target.value)}
            placeholder={t('askUserQuestion.customInputPlaceholder', '请输入您的答案...')}
            rows={3}
            maxLength={MAX_CUSTOM_INPUT_LENGTH}
          />
        </div>
      )}

      {/* Hint text */}
      {question.multiSelect && (
        <p className="question-hint">
          {t('askUserQuestion.multiSelectHint', '可以选择多个选项')}
        </p>
      )}
    </div>
  );
};

export default QuestionSection;
