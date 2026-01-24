import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileChangeSummary } from '../../types';
import FileIcon from './FileIcon';

interface UndoConfirmDialogProps {
  fileChange: FileChangeSummary | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const UndoConfirmDialog = memo(({ fileChange, onConfirm, onCancel }: UndoConfirmDialogProps) => {
  const { t } = useTranslation();

  if (!fileChange) return null;

  const status = String(fileChange.status || 'M');
  const statusClass = status === 'A' ? 'added' : 'modified';
  const isAdded = status === 'A';

  return (
    <div className="undo-confirm-overlay" onClick={onCancel}>
      <div className="undo-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="undo-confirm-header">
          <span className="codicon codicon-discard" />
          <h3>{t('statusPanel.undoConfirmTitle')}</h3>
        </div>
        <div className="undo-confirm-body">
          <div className="undo-file-info">
            <span className={`file-change-status status-${statusClass}`}>
              {status}
            </span>
            <FileIcon filePath={fileChange.filePath} />
            <span className="file-name">{fileChange.fileName}</span>
            <span className="file-stats">
              {fileChange.additions > 0 && <span className="additions">+{fileChange.additions}</span>}
              {fileChange.deletions > 0 && <span className="deletions">-{fileChange.deletions}</span>}
            </span>
          </div>
          <div className="undo-warning">
            <span className="warning-icon">⚠️</span>
            <div className="warning-text">
              <p>
                {isAdded
                  ? t('statusPanel.undoWillDelete')
                  : t('statusPanel.undoWillRestore')}
              </p>
              <p className="warning-note">{t('statusPanel.undoCannotUndo')}</p>
            </div>
          </div>
        </div>
        <div className="undo-confirm-footer">
          <button className="cancel-btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button className="confirm-btn danger" onClick={onConfirm}>
            {t('statusPanel.confirmUndo')}
          </button>
        </div>
      </div>
    </div>
  );
});

UndoConfirmDialog.displayName = 'UndoConfirmDialog';

export default UndoConfirmDialog;
