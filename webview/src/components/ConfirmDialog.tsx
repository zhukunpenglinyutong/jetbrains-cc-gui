import { useEffect } from 'react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmDialog = ({
  isOpen,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => {
  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onCancel();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onCancel]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-dialog-header">
          <h3 className="confirm-dialog-title">{title}</h3>
        </div>
        <div className="confirm-dialog-body">
          <p className="confirm-dialog-message">{message}</p>
        </div>
        <div className="confirm-dialog-footer">
          <button className="confirm-dialog-button cancel-button" onClick={onCancel}>
            {cancelText}
          </button>
          <button className="confirm-dialog-button confirm-button" onClick={onConfirm} autoFocus>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
