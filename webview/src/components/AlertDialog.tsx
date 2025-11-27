import { useEffect } from 'react';

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
  confirmText = '确定',
  onClose,
}: AlertDialogProps) => {
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
  }, [isOpen, onClose]);

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
        <div className="confirm-dialog-header">
          <span
            className={`codicon ${getIconClass()}`}
            style={{ color: getIconColor(), marginRight: '8px', fontSize: '16px' }}
          />
          <h3 className="confirm-dialog-title">{title}</h3>
        </div>
        <div className="confirm-dialog-body">
          <p className="confirm-dialog-message" style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
        </div>
        <div className="confirm-dialog-footer" style={{ justifyContent: 'center' }}>
          <button className="confirm-dialog-button confirm-button" onClick={onClose} autoFocus>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AlertDialog;
