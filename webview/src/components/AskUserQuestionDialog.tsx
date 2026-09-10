import { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDialogCountdownTimeout } from '../hooks/useDialogCountdownTimeout';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';
import CollapsedHint from './AskUserQuestionDialog/CollapsedHint';
import DialogHeader from './AskUserQuestionDialog/DialogHeader';
import ExpandedContent from './AskUserQuestionDialog/ExpandedContent';
import FallbackDialog from './AskUserQuestionDialog/FallbackDialog';
import TimeoutWarningBanner from './AskUserQuestionDialog/TimeoutWarningBanner';
import { normalizeQuestions } from './AskUserQuestionDialog/answerState';
import { useAskUserQuestionState } from './AskUserQuestionDialog/useAskUserQuestionState';
import './AskUserQuestionDialog.css';

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionRequest {
  requestId: string;
  toolName: string;
  questions: Question[];
  provider?: 'claude' | 'codex';
}

interface AskUserQuestionDialogProps {
  isOpen: boolean;
  request: AskUserQuestionRequest | null;
  onSubmit: (requestId: string, answers: Record<string, string | string[]>) => void;
  onCancel: (requestId: string) => void;
  timeoutSeconds?: number;
}

const AskUserQuestionDialog = ({
  isOpen,
  request,
  onSubmit,
  onCancel,
  timeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}: AskUserQuestionDialogProps) => {
  const { t } = useTranslation();
  const customInputRef = useRef<HTMLTextAreaElement>(null);

  const handleTimeout = useCallback(() => {
    if (request) {
      onCancel(request.requestId);
    }
  }, [request, onCancel]);

  const { remainingSeconds, isTimeWarning, markSubmitted } = useDialogCountdownTimeout({
    isOpen,
    requestKey: request?.requestId,
    timeoutSeconds,
    onTimeout: handleTimeout,
  });

  const normalizedQuestions = normalizeQuestions(request?.questions);
  const isCodexRequest = request?.provider === 'codex' || request?.toolName === 'request_user_input';
  const dialogTitle = isCodexRequest
    ? t('askUserQuestion.codexTitle', 'Codex 有一些问题想问你')
    : t('askUserQuestion.title', 'Claude 有一些问题想问你');

  const handleCancel = useCallback(() => {
    if (request && markSubmitted()) {
      onCancel(request.requestId);
    }
  }, [request, markSubmitted, onCancel]);

  const {
    isCollapsed,
    setIsCollapsed,
    safeQuestionIndex,
    currentQuestion,
    currentAnswerSet,
    currentCustomInput,
    canProceed,
    handleOptionToggle,
    handleCustomInputChange,
    handleNext,
    handleBack,
  } = useAskUserQuestionState({
    isOpen,
    request,
    normalizedQuestions,
    customInputRef,
    markSubmitted,
    onSubmit,
    onCancel: handleCancel,
  });

  if (!isOpen || !request) {
    return null;
  }

  if (normalizedQuestions.length === 0) {
    return (
      <FallbackDialog
        title={dialogTitle}
        message={t('askUserQuestion.invalidFormat', '问题数据格式不支持，请取消后重试。')}
        onCancel={handleCancel}
      />
    );
  }

  // FIX: Additional defensive check to prevent currentQuestion being undefined in edge cases
  // This can happen during React concurrent rendering or state update timing issues
  if (!currentQuestion) {
    return (
      <FallbackDialog
        title={dialogTitle}
        message={t('askUserQuestion.loading', '正在加载问题...')}
        onCancel={handleCancel}
      />
    );
  }

  return (
    <div className={`permission-dialog-overlay ${isCollapsed ? 'collapsed-mode' : ''}`}>
      <div className={`ask-user-question-dialog ${isCollapsed ? 'collapsed' : 'expanded'} ${isTimeWarning ? 'time-warning' : ''}`}>
        {/* Header area - with collapse/expand button */}
        <DialogHeader
          title={dialogTitle}
          isCollapsed={isCollapsed}
          onToggle={() => setIsCollapsed(!isCollapsed)}
        />

        {/* Timeout warning notice */}
        {isTimeWarning && !isCollapsed && (
          <TimeoutWarningBanner remainingSeconds={remainingSeconds} />
        )}

        {/* Brief hint in collapsed state */}
        {isCollapsed ? (
          <CollapsedHint
            current={safeQuestionIndex + 1}
            total={normalizedQuestions.length}
            isTimeWarning={isTimeWarning}
            remainingSeconds={remainingSeconds}
            onExpand={() => setIsCollapsed(false)}
          />
        ) : (
          <ExpandedContent
            current={safeQuestionIndex + 1}
            total={normalizedQuestions.length}
            remainingSeconds={remainingSeconds}
            isTimeWarning={isTimeWarning}
            question={currentQuestion}
            selectedLabels={currentAnswerSet}
            customInput={currentCustomInput}
            customInputRef={customInputRef}
            onOptionToggle={handleOptionToggle}
            onCustomInputChange={handleCustomInputChange}
            canProceed={canProceed}
            onCancel={handleCancel}
            onBack={handleBack}
            onNext={handleNext}
          />
        )}
      </div>
    </div>
  );
};

export default AskUserQuestionDialog;
