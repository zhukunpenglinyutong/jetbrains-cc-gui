import { useTranslation } from 'react-i18next';

interface DialogActionsProps {
  showBack: boolean;
  isLastQuestion: boolean;
  canProceed: boolean;
  onCancel: () => void;
  onBack: () => void;
  onNext: () => void;
}

const DialogActions = ({
  showBack,
  isLastQuestion,
  canProceed,
  onCancel,
  onBack,
  onNext,
}: DialogActionsProps) => {
  const { t } = useTranslation();

  return (
    <div className="ask-user-question-dialog-actions">
      <button
        className="action-button secondary"
        onClick={onCancel}
      >
        {t('askUserQuestion.cancel', '取消')}
      </button>

      <div className="action-buttons-right">
        {showBack && (
          <button
            className="action-button secondary"
            onClick={onBack}
          >
            {t('askUserQuestion.back', '上一步')}
          </button>
        )}

        <button
          className={`action-button primary ${!canProceed ? 'disabled' : ''}`}
          onClick={onNext}
          disabled={!canProceed}
        >
          {isLastQuestion
            ? t('askUserQuestion.submit', '提交')
            : t('askUserQuestion.next', '下一步')}
        </button>
      </div>
    </div>
  );
};

export default DialogActions;
