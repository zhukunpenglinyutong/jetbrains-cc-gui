interface SkillConfirmDialogProps {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Skill 确认弹窗
 * 用于删除等危险操作的二次确认
 */
export function SkillConfirmDialog({
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: SkillConfirmDialogProps) {
  // 阻止事件冒泡
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  return (
    <div className="skill-dialog-backdrop" onClick={handleBackdropClick}>
      <div className="skill-dialog confirm-dialog">
        {/* 标题栏 */}
        <div className="dialog-header">
          <h3>{title}</h3>
          <button className="close-btn" onClick={onCancel}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        {/* 内容 */}
        <div className="dialog-content">
          <div className="confirm-message">
            <span className="codicon codicon-warning warning-icon"></span>
            <p>{message}</p>
          </div>
        </div>

        {/* 底部按钮 */}
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
