import { useTranslation } from 'react-i18next';

interface FallbackDialogProps {
  title: string;
  message: string;
  onCancel: () => void;
}

const FallbackDialog = ({ title, message, onCancel }: FallbackDialogProps) => {
  const { t } = useTranslation();

  return (
    <div className="permission-dialog-overlay">
      <div className="ask-user-question-dialog">
        <h3 className="ask-user-question-dialog-title">
          {title}
        </h3>
        <p className="question-text">
          {message}
        </p>
        <div className="ask-user-question-dialog-actions">
          <button className="action-button secondary" onClick={onCancel}>
            {t('askUserQuestion.cancel', '取消')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default FallbackDialog;
