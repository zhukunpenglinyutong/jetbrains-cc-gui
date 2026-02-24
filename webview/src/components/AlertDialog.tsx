import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export type AlertType = 'error' | 'warning' | 'info' | 'success';

interface AlertDialogProps {
  isOpen: boolean;
  type?: AlertType;
  title: string;
  message: string;
  confirmText?: string;
  onClose: () => void;
}

const AlertDialog = ({
  isOpen,
  type = 'info',
  title,
  message,
  confirmText,
  onClose,
}: AlertDialogProps) => {
  const { t } = useTranslation();
  const buttonText = confirmText || t('common.confirm');
  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape' || e.key === 'Enter') {
          onClose();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]); // Remove onClose from dependencies - it's stable from props

  if (!isOpen) {
    return null;
  }

  const getIconClass = () => {
    switch (type) {
      case 'error':
        return 'codicon-error';
      case 'warning':
        return 'codicon-warning';
      case 'success':
        return 'codicon-pass';
      default:
        return 'codicon-info';
    }
  };

  const getIconColor = () => {
    switch (type) {
      case 'error':
        return '#f48771';
      case 'warning':
        return '#cca700';
      case 'success':
        return '#89d185';
      default:
        return '#75beff';
    }
  };

  return (
    <div className="confirm-dialog-overlay" onClick={onClose}>
      <div className="confirm-dialog alert-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header" style={{ display: 'flex', alignItems: 'center' }}>
          <span
            className={`codicon ${getIconClass()}`}
            style={{ color: getIconColor(), marginRight: '8px', fontSize: '16px', lineHeight: 1 }}
          />
          <h3 className="confirm-dialog-title" style={{ margin: 0, lineHeight: 1.2 }}>{title}</h3>
        </div>
        <div className="confirm-dialog-body">
          <p className="confirm-dialog-message" style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
        </div>
        <div className="confirm-dialog-footer" style={{ justifyContent: 'center' }}>
          <button className="confirm-dialog-button confirm-button" onClick={onClose} autoFocus>
            {buttonText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AlertDialog;
