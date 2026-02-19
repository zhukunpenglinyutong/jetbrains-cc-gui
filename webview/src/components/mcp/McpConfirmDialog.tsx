interface McpConfirmDialogProps {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * MCP Confirm Dialog
 */
export function McpConfirmDialog({
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: McpConfirmDialogProps) {
  // Close on overlay click
  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  return (
    <div className="dialog-overlay" onClick={handleOverlayClick}>
      <div className="dialog mcp-confirm-dialog">
        <div className="dialog-header">
          <h3>{title}</h3>
          <button className="close-btn" onClick={onCancel}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        <div className="dialog-body">
          <div className="confirm-content">
            <span className="codicon codicon-warning confirm-icon"></span>
            <p className="confirm-message">{message}</p>
          </div>
        </div>

        <div className="dialog-footer">
          <div className="footer-actions" style={{ marginLeft: 'auto' }}>
            <button className="btn btn-secondary" onClick={onCancel}>
              {cancelText}
            </button>
            <button className="btn btn-danger" onClick={onConfirm}>
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
