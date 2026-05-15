import { memo, useCallback } from "react";
import type React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { FileChangeSummary } from "../../types";
import { openFile } from "../../utils/bridge";
import FileIcon from "./FileIcon";

interface FileChangesListProps {
  fileChanges: FileChangeSummary[];
  undoingFile: string | null;
  isDiscardingAll: boolean;
  onUndoClick: (fileChange: FileChangeSummary) => void;
  onShowDiff: (fileChange: FileChangeSummary) => void;
  onDiscardAllClick: () => void;
  onKeepAllClick: () => void;
  keepAllDisabled?: boolean;
  actionsDisabled?: boolean;
}

interface FileChangeRowProps {
  fileChange: FileChangeSummary;
  isUndoing: boolean;
  isDiscardingAll: boolean;
  onOpen: (fileChange: FileChangeSummary) => void;
  onShowDiff: (fileChange: FileChangeSummary) => void;
  onUndo: (fileChange: FileChangeSummary) => void;
  actionsDisabled: boolean;
  t: TFunction;
}

const FileChangeRow = memo(
  ({
    fileChange,
    isUndoing,
    isDiscardingAll,
    onOpen,
    onShowDiff,
    onUndo,
    actionsDisabled,
    t,
  }: FileChangeRowProps) => {
    const status = String(fileChange.status || "M");
    const statusClass = status === "A" ? "added" : "modified";
    const unsafeRollback = fileChange.operations.some(
      (operation) => operation.safeToRollback === false,
    );

    const handleOpen = useCallback(() => {
      onOpen(fileChange);
    }, [onOpen, fileChange]);

    const handleOpenKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLSpanElement>) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(fileChange);
        }
      },
      [onOpen, fileChange],
    );

    const handleShowDiff = useCallback(() => {
      onShowDiff(fileChange);
    }, [onShowDiff, fileChange]);

    const handleUndo = useCallback(() => {
      onUndo(fileChange);
    }, [onUndo, fileChange]);

    return (
      <div className="file-change-item">
        {/* Status indicator (A/M) */}
        <span className={`file-change-status status-${statusClass}`}>
          {status}
        </span>

        {/* File icon */}
        <FileIcon filePath={fileChange.filePath} />

        {/* File name — keyboard accessible since it acts as a button */}
        <span
          className="file-change-name"
          role="button"
          tabIndex={0}
          onClick={handleOpen}
          onKeyDown={handleOpenKeyDown}
          title={fileChange.filePath}
        >
          {fileChange.fileName}
        </span>

        {/* Stats */}
        {(fileChange.additions > 0 || fileChange.deletions > 0) && (
          <span className="file-change-stats">
            {fileChange.additions > 0 && (
              <span className="additions">+{fileChange.additions}</span>
            )}
            {fileChange.deletions > 0 && (
              <span className="deletions">-{fileChange.deletions}</span>
            )}
          </span>
        )}

        {/* Actions */}
        <div className="file-change-actions">
          <button
            className="file-change-action-btn diff-btn"
            onClick={handleShowDiff}
            title={t("statusPanel.showDiff")}
            disabled={actionsDisabled || isDiscardingAll || unsafeRollback}
          >
            <span className="codicon codicon-diff" />
          </button>
          <button
            className="file-change-action-btn undo-btn"
            onClick={handleUndo}
            title={t("statusPanel.undoChanges")}
            disabled={actionsDisabled || isDiscardingAll || isUndoing || unsafeRollback}
          >
            {isUndoing ? (
              <span className="codicon codicon-loading codicon-modifier-spin" />
            ) : (
              <span className="codicon codicon-discard" />
            )}
          </button>
        </div>
      </div>
    );
  },
);

FileChangeRow.displayName = "FileChangeRow";

const FileChangesList = memo(
  ({
    fileChanges,
    undoingFile,
    isDiscardingAll,
    onUndoClick,
    onShowDiff,
    onDiscardAllClick,
    onKeepAllClick,
    keepAllDisabled = false,
    actionsDisabled = false,
  }: FileChangesListProps) => {
    const { t } = useTranslation();

    const handleOpenFile = useCallback((fileChange: FileChangeSummary) => {
      openFile(fileChange.filePath, fileChange.lineStart, fileChange.lineEnd);
    }, []);

    if (fileChanges.length === 0) {
      return (
        <div className="status-panel-empty">
          {t("statusPanel.noFileChanges")}
        </div>
      );
    }

    return (
      <div className="file-changes-container">
        {/* Batch action buttons */}
        <div className="file-changes-actions-bar">
          <button
            className="file-changes-action-btn discard-all-btn"
            onClick={onDiscardAllClick}
            disabled={actionsDisabled || isDiscardingAll}
            title={t("statusPanel.discardAll")}
          >
            {isDiscardingAll ? (
              <span className="codicon codicon-loading codicon-modifier-spin" />
            ) : (
              <span className="codicon codicon-trash" />
            )}
            <span>{t("statusPanel.discardAll")}</span>
          </button>
          <button
            className="file-changes-action-btn keep-all-btn"
            onClick={onKeepAllClick}
            disabled={keepAllDisabled}
            title={t("statusPanel.keepAll")}
          >
            <span className="codicon codicon-check-all" />
            <span>{t("statusPanel.keepAll")}</span>
          </button>
        </div>

        {/* File list */}
        <div className="file-changes-list">
          {fileChanges.map((fileChange) => (
            <FileChangeRow
              key={fileChange.filePath}
              fileChange={fileChange}
              isUndoing={undoingFile === fileChange.filePath}
              isDiscardingAll={isDiscardingAll}
              actionsDisabled={actionsDisabled}
              onOpen={handleOpenFile}
              onShowDiff={onShowDiff}
              onUndo={onUndoClick}
              t={t}
            />
          ))}
        </div>
      </div>
    );
  },
);

FileChangesList.displayName = "FileChangesList";

export default FileChangesList;
