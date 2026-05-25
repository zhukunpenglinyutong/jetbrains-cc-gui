import { useEffect, type ReactNode } from 'react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /**
   * Optional extra content rendered inside the dialog body, beneath the message
   * and above the footer. Used by AppDialogs to inject a "don't ask again"
   * checkbox for the new-session confirm dialog. Other call sites leave this
   * undefined and the dialog renders exactly as before.
   */
  children?: ReactNode;
}

const ConfirmDialog = ({
  isOpen,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onCancel,
  children,
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
  }, [isOpen]); // Remove onCancel from dependencies - it's stable from props

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
          {children}
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
