import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileChangeSummary } from '../../types';
import { openFile, showEditableDiff } from '../../utils/bridge';
import FileIcon from './FileIcon';

interface FileChangesListProps {
  fileChanges: FileChangeSummary[];
  undoingFile: string | null;
  isDiscardingAll: boolean;
  onUndoClick: (fileChange: FileChangeSummary) => void;
  onDiscardAllClick: () => void;
  onKeepAllClick: () => void;
}

const FileChangesList = memo(({
  fileChanges,
  undoingFile,
  isDiscardingAll,
  onUndoClick,
  onDiscardAllClick,
  onKeepAllClick,
}: FileChangesListProps) => {
  const { t } = useTranslation();

  const handleFileClick = useCallback((filePath: string) => {
    openFile(filePath);
  }, []);

  const handleShowDiff = useCallback((fileChange: FileChangeSummary) => {
    const operations = fileChange.operations.map((op) => ({
      oldString: op.oldString,
      newString: op.newString,
      replaceAll: op.replaceAll,
    }));
    // Use editable diff view for selective accept/reject of changes
    const status = fileChange.status === 'A' ? 'A' : 'M';
    showEditableDiff(fileChange.filePath, operations, status);
  }, []);

  if (fileChanges.length === 0) {
    return <div className="status-panel-empty">{t('statusPanel.noFileChanges')}</div>;
  }

  return (
    <div className="file-changes-container">
      {/* Batch action buttons */}
      <div className="file-changes-actions-bar">
        <button
          className="file-changes-action-btn discard-all-btn"
          onClick={onDiscardAllClick}
          disabled={isDiscardingAll}
          title={t('statusPanel.discardAll')}
        >
          {isDiscardingAll ? (
            <span className="codicon codicon-loading codicon-modifier-spin" />
          ) : (
            <span className="codicon codicon-trash" />
          )}
          <span>{t('statusPanel.discardAll')}</span>
        </button>
        <button
          className="file-changes-action-btn keep-all-btn"
          onClick={onKeepAllClick}
          title={t('statusPanel.keepAll')}
        >
          <span className="codicon codicon-check-all" />
          <span>{t('statusPanel.keepAll')}</span>
        </button>
      </div>

      {/* File list */}
      <div className="file-changes-list">
        {fileChanges.map((fileChange) => {
          const status = String(fileChange.status || 'M');
          const statusClass = status === 'A' ? 'added' : 'modified';

          return (
            <div key={fileChange.filePath} className="file-change-item">
              {/* Status indicator (A/M) */}
              <span className={`file-change-status status-${statusClass}`}>
                {status}
              </span>

              {/* File icon */}
              <FileIcon filePath={fileChange.filePath} />

              {/* File name */}
              <span
                className="file-change-name"
                onClick={() => handleFileClick(fileChange.filePath)}
                title={fileChange.filePath}
              >
                {fileChange.fileName}
              </span>

              {/* Stats */}
              {(fileChange.additions > 0 || fileChange.deletions > 0) && (
                <span className="file-change-stats">
                  {fileChange.additions > 0 && <span className="additions">+{fileChange.additions}</span>}
                  {fileChange.deletions > 0 && <span className="deletions">-{fileChange.deletions}</span>}
                </span>
              )}

              {/* Actions */}
              <div className="file-change-actions">
                <button
                  className="file-change-action-btn"
                  onClick={() => handleShowDiff(fileChange)}
                  title={t('statusPanel.showDiff')}
                >
                  <span className="codicon codicon-diff" />
                </button>
                <button
                  className="file-change-action-btn undo-btn"
                  onClick={() => onUndoClick(fileChange)}
                  title={t('statusPanel.undoChanges')}
                  disabled={undoingFile === fileChange.filePath}
                >
                  {undoingFile === fileChange.filePath ? (
                    <span className="codicon codicon-loading codicon-modifier-spin" />
                  ) : (
                    <span className="codicon codicon-discard" />
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

FileChangesList.displayName = 'FileChangesList';

export default FileChangesList;
