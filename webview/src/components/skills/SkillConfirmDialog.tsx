interface SkillConfirmDialogProps {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Skill confirmation dialog
 * Used for secondary confirmation of dangerous operations such as deletion
 */
export function SkillConfirmDialog({
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: SkillConfirmDialogProps) {
  // Prevent event bubbling
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  return (
    <div className="skill-dialog-backdrop" onClick={handleBackdropClick}>
      <div className="skill-dialog confirm-dialog">
        {/* Title bar */}
        <div className="dialog-header">
          <h3>{title}</h3>
          <button className="close-btn" onClick={onCancel}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        {/* Content */}
        <div className="dialog-content">
          <div className="confirm-message">
            <span className="codicon codicon-warning warning-icon"></span>
            <p>{message}</p>
          </div>
        </div>

        {/* Footer buttons */}
        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onCancel}>
            {cancelText}
          </button>
          <button className="btn-danger" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
