import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { FileChangeSummary } from "../../types";
import {
  showEditableDiff,
  undoFileChanges,
  sendToJava,
} from "../../utils/bridge";
import { getFileName } from "../../utils/helpers";
import TodoList from "./TodoList";
import SubagentList from "./SubagentList";
import FileChangesList from "./FileChangesList";
import UndoConfirmDialog from "./UndoConfirmDialog";
import DiscardAllDialog from "./DiscardAllDialog";
import type { TabType, StatusPanelProps } from "./types";
import {
  getFilesToDiscardAfterUndoAll,
  getSucceededFilesFromUndoAllResult,
  getUndoAllFailureMessage,
  toBridgeOperations,
} from "./fileChangeActions";
import "./StatusPanel.less";

const StatusPanel = ({
  todos,
  fileChanges,
  subagents,
  subagentHistories,
  currentSessionId,
  expanded = true,
  isStreaming = false,
  hasPendingSubagent = false,
  onUndoFile,
  onKeepAll,
  onRegisterFileChangeAction,
  onClearFileChangeAction,
}: StatusPanelProps) => {
  const { t } = useTranslation();
  const [openPopover, setOpenPopover] = useState<TabType | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Undo related state
  const [undoingFile, setUndoingFile] = useState<string | null>(null);
  const [confirmUndoFile, setConfirmUndoFile] =
    useState<FileChangeSummary | null>(null);

  // Discard All confirmation state
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [isDiscardingAll, setIsDiscardingAll] = useState(false);
  const discardAllRequestFilesRef = useRef<string[]>([]);
  const undoRequestByFilePathRef = useRef(new Map<string, FileChangeSummary>());
  const discardAllRequestByFilePathRef = useRef(
    new Map<string, FileChangeSummary>(),
  );

  const hasTodos = todos.length > 0;
  const hasFileChanges = fileChanges.length > 0;
  const hasSubagents = subagents.length > 0;
  const keepAllDisabled = isStreaming || hasPendingSubagent;
  const fileActionsDisabled = isStreaming || hasPendingSubagent;

  // Calculate todo stats
  const { completedCount, totalCount, hasInProgressTodo } = useMemo(() => {
    const completed = todos.filter(
      (todo) => todo.status === "completed",
    ).length;
    const inProgress = todos.some((todo) => todo.status === "in_progress");
    return {
      completedCount: completed,
      totalCount: todos.length,
      hasInProgressTodo: inProgress,
    };
  }, [todos]);

  // Calculate subagent stats
  const { subagentCompletedCount, subagentTotalCount, hasRunningSubagent } =
    useMemo(() => {
      const completed = subagents.filter(
        (s) => s.status === "completed" || s.status === "error",
      ).length;
      const running = subagents.some((s) => s.status === "running");
      return {
        subagentCompletedCount: completed,
        subagentTotalCount: subagents.length,
        hasRunningSubagent: running,
      };
    }, [subagents]);

  // Calculate total file changes stats
  const { totalAdditions, totalDeletions } = useMemo(() => {
    return fileChanges.reduce(
      (acc, file) => ({
        totalAdditions: acc.totalAdditions + file.additions,
        totalDeletions: acc.totalDeletions + file.deletions,
      }),
      { totalAdditions: 0, totalDeletions: 0 },
    );
  }, [fileChanges]);

  // Close popover when collapsed
  useEffect(() => {
    if (!expanded) {
      setOpenPopover(null);
    }
  }, [expanded]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
      ) {
        setOpenPopover(null);
      }
    };

    if (openPopover) {
      document.addEventListener("mousedown", handleClickOutside);
      return () =>
        document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [openPopover]);

  const handleTabClick = useCallback((tab: TabType) => {
    setOpenPopover((prev) => (prev === tab ? null : tab));
  }, []);

  // Undo handlers
  const handleUndoClick = useCallback((fileChange: FileChangeSummary) => {
    if (fileActionsDisabled) return;
    setConfirmUndoFile(fileChange);
  }, [fileActionsDisabled]);

  const handleConfirmUndo = useCallback(() => {
    if (!confirmUndoFile) return;
    if (fileActionsDisabled) {
      setConfirmUndoFile(null);
      return;
    }

    const { filePath, operations } = confirmUndoFile;
    const safeStatus = confirmUndoFile.status === "A" ? "A" : "M";

    setUndoingFile(filePath);
    undoRequestByFilePathRef.current.set(filePath, confirmUndoFile);
    setConfirmUndoFile(null);

    undoFileChanges(filePath, safeStatus, toBridgeOperations(operations));
  }, [confirmUndoFile, fileActionsDisabled]);

  const handleCancelUndo = useCallback(() => {
    setConfirmUndoFile(null);
  }, []);

  // Discard All handlers
  const handleDiscardAllClick = useCallback(() => {
    if (fileActionsDisabled) return;
    setConfirmDiscardAll(true);
  }, [fileActionsDisabled]);

  const handleConfirmDiscardAll = useCallback(() => {
    if (fileChanges.length === 0) return;
    if (fileActionsDisabled) {
      setConfirmDiscardAll(false);
      return;
    }

    setIsDiscardingAll(true);
    setConfirmDiscardAll(false);

    const files = fileChanges.map((fc) => ({
      filePath: fc.filePath,
      status: fc.status === "A" ? "A" : "M",
      operations: toBridgeOperations(fc.operations),
    }));
    discardAllRequestFilesRef.current = files.map((file) => file.filePath);
    discardAllRequestByFilePathRef.current = new Map(
      fileChanges.map((fileChange) => [fileChange.filePath, fileChange]),
    );

    sendToJava("undo_all_file_changes", { files });
  }, [fileChanges, fileActionsDisabled]);

  const handleCancelDiscardAll = useCallback(() => {
    setConfirmDiscardAll(false);
  }, []);

  const handleShowDiff = useCallback(
    (fileChange: FileChangeSummary) => {
      if (fileActionsDisabled) return;
      const status = fileChange.status === "A" ? "A" : "M";
      const requestId = onRegisterFileChangeAction?.(fileChange);
      const dispatched = showEditableDiff(
        fileChange.filePath,
        toBridgeOperations(fileChange.operations),
        status,
        requestId,
      );
      if (!dispatched) {
        onClearFileChangeAction?.(requestId);
      }
    },
    [fileActionsDisabled, onRegisterFileChangeAction, onClearFileChangeAction],
  );

  // Keep All handler
  const handleKeepAllClick = useCallback(() => {
    if (keepAllDisabled) return;
    onKeepAll?.();
    window.addToast?.(t("statusPanel.keepAllSuccess"), "success");
  }, [keepAllDisabled, onKeepAll, t]);

  // Register undo result callback
  useEffect(() => {
    const handleUndoResult = (resultJson: string) => {
      try {
        const result = JSON.parse(resultJson);
        setUndoingFile(null);

        if (result.success) {
          const completedFilePath = result.requestFilePath || result.filePath;
          const requested = undoRequestByFilePathRef.current.get(
            completedFilePath,
          );
          undoRequestByFilePathRef.current.delete(completedFilePath);
          onUndoFile?.(completedFilePath, requested?.operations);
          window.addToast?.(
            t("statusPanel.undoSuccess", {
              fileName: getFileName(completedFilePath),
            }),
            "success",
          );
        } else {
          const completedFilePath = result.requestFilePath || result.filePath;
          undoRequestByFilePathRef.current.delete(completedFilePath);
          window.addToast?.(
            t("statusPanel.undoFailed", {
              error: result.error || "Unknown error",
            }),
            "error",
          );
        }
      } catch (error) {
        console.error("Failed to handle undo file result", error);
        setUndoingFile(null);
      }
    };

    window.onUndoFileResult = handleUndoResult;
    return () => {
      delete window.onUndoFileResult;
    };
  }, [onUndoFile, t]);

  // Register batch undo result callback
  useEffect(() => {
    const handleUndoAllResult = (resultJson: string) => {
      try {
        const result = JSON.parse(resultJson);
        setIsDiscardingAll(false);

        const succeededFiles = getSucceededFilesFromUndoAllResult(result);

        if (result.success) {
          getFilesToDiscardAfterUndoAll(
            result,
            discardAllRequestFilesRef.current,
          ).forEach((filePath) => {
            const requested =
              discardAllRequestByFilePathRef.current.get(filePath);
            onUndoFile?.(filePath, requested?.operations);
          });
          discardAllRequestFilesRef.current = [];
          discardAllRequestByFilePathRef.current.clear();
          window.addToast?.(t("statusPanel.discardAllSuccess"), "success");
        } else if (result.partial && succeededFiles.length > 0) {
          succeededFiles.forEach((filePath) => {
            const requested =
              discardAllRequestByFilePathRef.current.get(filePath);
            onUndoFile?.(filePath, requested?.operations);
          });
          discardAllRequestFilesRef.current = [];
          discardAllRequestByFilePathRef.current.clear();
          window.addToast?.(
            t("statusPanel.discardAllFailed", {
              error: getUndoAllFailureMessage(
                result,
                "Some files could not be discarded",
              ),
            }),
            "error",
          );
        } else {
          discardAllRequestByFilePathRef.current.clear();
          window.addToast?.(
            t("statusPanel.discardAllFailed", {
              error: getUndoAllFailureMessage(result, "Unknown error"),
            }),
            "error",
          );
        }
      } catch (error) {
        console.error("Failed to handle undo all file result", error);
        setIsDiscardingAll(false);
      }
    };

    window.onUndoAllFileResult = handleUndoAllResult;
    return () => {
      delete window.onUndoAllFileResult;
    };
  }, [onUndoFile, t]);

  if (!expanded) {
    return null;
  }

  const renderPopoverContent = () => {
    switch (openPopover) {
      case "todo":
        return <TodoList todos={todos} />;
      case "subagent":
        return (
          <SubagentList
            subagents={subagents}
            histories={subagentHistories}
            currentSessionId={currentSessionId}
            isStreaming={isStreaming}
          />
        );
      case "files":
        return (
          <FileChangesList
            fileChanges={fileChanges}
            undoingFile={undoingFile}
            isDiscardingAll={isDiscardingAll}
            onUndoClick={handleUndoClick}
            onShowDiff={handleShowDiff}
            onDiscardAllClick={handleDiscardAllClick}
            onKeepAllClick={handleKeepAllClick}
            keepAllDisabled={keepAllDisabled}
            actionsDisabled={fileActionsDisabled}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="status-panel" ref={popoverRef}>
      {/* Tab Header */}
      <div className="status-panel-tabs">
        {/* Todo Tab */}
        <div
          className={`status-panel-tab ${openPopover === "todo" ? "active" : ""}`}
          onClick={() => handleTabClick("todo")}
        >
          <span className="codicon codicon-checklist" />
          <span className="tab-label">{t("statusPanel.tasksTab")}</span>
          {hasTodos && (
            <span className="tab-progress">
              {completedCount}/{totalCount}
            </span>
          )}
          {isStreaming && hasInProgressTodo && (
            <span className="codicon codicon-loading status-panel-tab-loading" />
          )}
        </div>

        {/* Subagent Tab */}
        <div
          className={`status-panel-tab ${openPopover === "subagent" ? "active" : ""}`}
          onClick={() => handleTabClick("subagent")}
        >
          <span className="codicon codicon-hubot" />
          <span className="tab-label">{t("statusPanel.subagentTab")}</span>
          {hasSubagents && (
            <span className="tab-progress">
              {subagentCompletedCount}/{subagentTotalCount}
            </span>
          )}
          {isStreaming && hasRunningSubagent && (
            <span className="codicon codicon-loading status-panel-tab-loading" />
          )}
        </div>

        {/* File Changes Tab */}
        <div
          className={`status-panel-tab ${openPopover === "files" ? "active" : ""}`}
          onClick={() => handleTabClick("files")}
        >
          <span className="codicon codicon-edit" />
          <span className="tab-label">{t("statusPanel.editsTab")}</span>
          {hasFileChanges && (
            <span className="tab-stats">
              <span className="stat-additions">+{totalAdditions}</span>
              <span className="stat-deletions">-{totalDeletions}</span>
            </span>
          )}
        </div>
      </div>

      {/* Popover Content */}
      {openPopover && (
        <div className="status-panel-popover">{renderPopoverContent()}</div>
      )}

      {/* Dialogs */}
      <UndoConfirmDialog
        fileChange={confirmUndoFile}
        onConfirm={handleConfirmUndo}
        onCancel={handleCancelUndo}
      />
      <DiscardAllDialog
        visible={confirmDiscardAll}
        onConfirm={handleConfirmDiscardAll}
        onCancel={handleCancelDiscardAll}
      />
    </div>
  );
};

export default StatusPanel;
