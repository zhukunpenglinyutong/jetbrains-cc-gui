import { useEffect, useId, type ReactNode } from 'react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmDisabled?: boolean;
  danger?: boolean;
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
  confirmDisabled = false,
  danger = false,
}: ConfirmDialogProps) => {
  const titleId = useId();

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
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-header">
          <h3 id={titleId} className="confirm-dialog-title">{title}</h3>
        </div>
        <div className="confirm-dialog-body">
          <p className="confirm-dialog-message">{message}</p>
          {children}
        </div>
        <div className="confirm-dialog-footer">
          <button className="confirm-dialog-button cancel-button" onClick={onCancel} autoFocus={danger}>
            {cancelText}
          </button>
          <button className="confirm-dialog-button confirm-button" onClick={onConfirm} disabled={confirmDisabled} autoFocus={!danger}
            style={danger ? { background: 'var(--color-error, #c34b4b)', borderColor: 'var(--color-error, #c34b4b)' } : undefined}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmDialog;
