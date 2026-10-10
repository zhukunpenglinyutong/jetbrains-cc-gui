import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileChangeSummary } from '../../types';
import { undoFileChanges, sendBridgeEvent } from '../../utils/bridge';
import { getFileName } from '../../utils/helpers';
import TodoList from './TodoList';
import SubagentList from './SubagentList';
import FileChangesList from './FileChangesList';
import UndoConfirmDialog from './UndoConfirmDialog';
import DiscardAllDialog from './DiscardAllDialog';
import type { TabType, StatusPanelProps } from './types';
import './StatusPanel.less';

const StatusPanel = ({ todos, fileChanges, subagents, subagentHistories, currentSessionId, currentProvider, expanded = true, isStreaming = false, onUndoFile, onDiscardAll, onKeepAll }: StatusPanelProps) => {
  const { t } = useTranslation();
  const [openPopover, setOpenPopover] = useState<TabType | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Undo related state
  const [undoingFiles, setUndoingFiles] = useState<Set<string>>(new Set());
  const [confirmUndoFile, setConfirmUndoFile] = useState<FileChangeSummary | null>(null);
  const pendingUndo = useRef(new Map<string, { sessionId?: string | null; provider: string; file: FileChangeSummary }>());
  const pendingDiscard = useRef<{ sessionId?: string | null; provider: string; files: FileChangeSummary[] } | null>(null);

  // Discard All confirmation state
  const [confirmDiscardAll, setConfirmDiscardAll] = useState(false);
  const [isDiscardingAll, setIsDiscardingAll] = useState(false);

  const hasTodos = todos.length > 0;
  const hasFileChanges = fileChanges.length > 0;
  const hasSubagents = subagents.length > 0;

  // Calculate todo stats
  const { completedCount, totalCount, hasInProgressTodo } = useMemo(() => {
    const completed = todos.filter((todo) => todo.status === 'completed').length;
    const inProgress = todos.some((todo) => todo.status === 'in_progress');
    return { completedCount: completed, totalCount: todos.length, hasInProgressTodo: inProgress };
  }, [todos]);

  // Calculate subagent stats
  const { subagentCompletedCount, subagentTotalCount, hasRunningSubagent } = useMemo(() => {
    const completed = subagents.filter((s) => s.status === 'completed').length;
    const running = subagents.some((s) => s.status === 'running');
    return { subagentCompletedCount: completed, subagentTotalCount: subagents.length, hasRunningSubagent: running };
  }, [subagents]);

  // Calculate total file changes stats
  const { totalAdditions, totalDeletions } = useMemo(() => {
    return fileChanges.reduce(
      (acc, file) => ({
        totalAdditions: acc.totalAdditions + file.additions,
        totalDeletions: acc.totalDeletions + file.deletions,
      }),
      { totalAdditions: 0, totalDeletions: 0 }
    );
  }, [fileChanges]);

  // Close popover when collapsed — render-time adjustment (self-bounding
  // condition, so no prev-prop tracking is needed).
  if (!expanded && openPopover !== null) {
    setOpenPopover(null);
  }

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setOpenPopover(null);
      }
    };

    if (openPopover) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [openPopover]);

  const handleTabClick = useCallback((tab: TabType) => {
    setOpenPopover((prev) => (prev === tab ? null : tab));
  }, []);

  useLayoutEffect(() => {
    const panel = popoverRef.current;
    if (!openPopover || !panel) return;
    const fitToWindow = () => {
      const rect = panel.getBoundingClientRect();
      const headerBottom = document.querySelector('.header')?.getBoundingClientRect().bottom ?? 0;
      const above = Math.max(0, rect.top - headerBottom - 8);
      const below = Math.max(0, window.innerHeight - rect.bottom - 8);
      const opensAbove = above >= 240 || above >= below;
      panel.style.setProperty('--status-panel-available-height', `${opensAbove ? above : below}px`);
      panel.style.setProperty('--status-panel-popover-top', opensAbove ? 'auto' : '100%');
      panel.style.setProperty('--status-panel-popover-bottom', opensAbove ? '100%' : 'auto');
      panel.style.setProperty('--status-panel-popover-margin-top', opensAbove ? '0' : '4px');
    };
    fitToWindow();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fitToWindow);
    if (panel.parentElement) observer?.observe(panel.parentElement);
    // Input resizing moves the panel without changing its own dimensions.
    const input = panel.parentElement?.querySelector('.input-area');
    if (input) observer?.observe(input);
    window.addEventListener('resize', fitToWindow);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fitToWindow); };
  }, [openPopover]);

  // Undo handlers
  const handleUndoClick = useCallback((fileChange: FileChangeSummary) => {
    setConfirmUndoFile(fileChange);
  }, []);

  const handleConfirmUndo = useCallback(() => {
    if (!confirmUndoFile) return;

    const { filePath, operations } = confirmUndoFile;

    pendingUndo.current.set(filePath, { sessionId: currentSessionId, provider: currentProvider, file: confirmUndoFile });
    setUndoingFiles(new Set(pendingUndo.current.keys()));
    setConfirmUndoFile(null);

    if (undoFileChanges(filePath, confirmUndoFile.status, operations) === false) {
      pendingUndo.current.delete(filePath);
      setUndoingFiles(new Set(pendingUndo.current.keys()));
      window.addToast?.(t('chat.bridgeUnavailable'), 'error');
    }
  }, [confirmUndoFile, currentSessionId, currentProvider, t]);

  const handleCancelUndo = useCallback(() => {
    setConfirmUndoFile(null);
  }, []);

  // Discard All handlers
  const handleDiscardAllClick = useCallback(() => {
    setConfirmDiscardAll(true);
  }, []);

  const handleConfirmDiscardAll = useCallback(() => {
    if (fileChanges.length === 0) return;

    setIsDiscardingAll(true);
    pendingDiscard.current = { sessionId: currentSessionId, provider: currentProvider, files: fileChanges };
    setConfirmDiscardAll(false);

    const files = fileChanges.map((fc) => ({
      filePath: fc.filePath,
      status: fc.status,
      operations: fc.operations,
    }));

    if (sendBridgeEvent('undo_all_file_changes', JSON.stringify({ files })) === false) {
      pendingDiscard.current = null;
      setIsDiscardingAll(false);
      window.addToast?.(t('chat.bridgeUnavailable'), 'error');
    }
  }, [fileChanges, currentSessionId, currentProvider, t]);

  const handleCancelDiscardAll = useCallback(() => {
    setConfirmDiscardAll(false);
  }, []);

  // Keep All handler
  const handleKeepAllClick = useCallback(() => {
    onKeepAll?.();
    window.addToast?.(t('statusPanel.keepAllSuccess'), 'success');
  }, [onKeepAll, t]);

  // Register undo result callback
  useEffect(() => {
    const handleUndoResult = (resultJson: string) => {
      try {
        const result = JSON.parse(resultJson);
        const receiptOrigin = Object.prototype.hasOwnProperty.call(result, 'sessionId')
          ? { sessionId: result.sessionId as string | null, provider: result.provider as string } : undefined;
        const candidate = pendingUndo.current.get(result.filePath);
        // A Diff receipt from another chat cannot release this path's current undo.
        const pending = !receiptOrigin || candidate?.sessionId === receiptOrigin.sessionId && candidate.provider === receiptOrigin.provider
          ? candidate : undefined;
        if (pending) {
          pendingUndo.current.delete(result.filePath);
          setUndoingFiles(new Set(pendingUndo.current.keys()));
        }
        const origin = receiptOrigin ?? (pending && (pending.sessionId !== currentSessionId || pending.provider !== currentProvider)
          ? { sessionId: pending.sessionId ?? null, provider: pending.provider } : undefined);
        const targetsCurrent = !origin || origin.sessionId === (currentSessionId ?? null) && origin.provider === currentProvider;

        if (result.success) {
          const keys = receiptOrigin ? result.ledgerKeys
            : pending?.file.operations.flatMap(op => op.ledgerKey ? [op.ledgerKey] : []);
          if (origin) onUndoFile?.(result.filePath, keys, origin);
          else if (keys?.length) onUndoFile?.(result.filePath, keys);
          else onUndoFile?.(result.filePath);
          if (!targetsCurrent) return;
          window.addToast?.(
            t('statusPanel.undoSuccess', { fileName: getFileName(result.filePath) }),
            'success'
          );
        } else if (targetsCurrent) {
          window.addToast?.(
            t('statusPanel.undoFailed', { error: result.error || 'Unknown error' }),
            'error'
          );
        }
      } catch {
        // JSON parse failed, reset state silently
        pendingUndo.current.clear();
        setUndoingFiles(new Set());
      }
    };

    window.onUndoFileResult = handleUndoResult;
    return () => {
      delete window.onUndoFileResult;
    };
  }, [onUndoFile, t, currentSessionId, currentProvider]);

  // Register batch undo result callback
  useEffect(() => {
    const handleUndoAllResult = (resultJson: string) => {
      try {
        const result = JSON.parse(resultJson);
        setIsDiscardingAll(false);
        const pending = pendingDiscard.current;
        pendingDiscard.current = null;
        const origin = pending && (pending.sessionId !== currentSessionId || pending.provider !== currentProvider)
          ? { sessionId: pending.sessionId ?? null, provider: pending.provider } : undefined;
        const reviewFile = (filePath: string) => {
          const keys = pending?.files.find(file => file.filePath === filePath)?.operations.flatMap(op => op.ledgerKey ? [op.ledgerKey] : []);
          if (origin) onUndoFile?.(filePath, keys, origin);
          else if (keys?.length) onUndoFile?.(filePath, keys);
          else onUndoFile?.(filePath);
        };

        if (result.success) {
          if (pending && (pending.provider === 'codex' || origin)) pending.files.forEach(file => reviewFile(file.filePath));
          else onDiscardAll?.();
          if (origin) return;
          window.addToast?.(t('statusPanel.discardAllSuccess'), 'success');
        } else {
          for (const filePath of result.successfulFiles ?? []) reviewFile(filePath);
          if (origin) return;
          window.addToast?.(
            t('statusPanel.discardAllFailed', { error: result.error || 'Unknown error' }),
            'error'
          );
        }
      } catch {
        // JSON parse failed, reset state silently
        setIsDiscardingAll(false);
      }
    };

    window.onUndoAllFileResult = handleUndoAllResult;
    return () => {
      delete window.onUndoAllFileResult;
    };
  }, [onDiscardAll, onUndoFile, t, currentSessionId, currentProvider]);

  if (!expanded) {
    return null;
  }

  const renderPopoverContent = () => {
    switch (openPopover) {
      case 'todo':
        return <TodoList todos={todos} isStreaming={isStreaming} />;
      case 'subagent':
        return <SubagentList subagents={subagents} histories={subagentHistories} currentSessionId={currentSessionId} currentProvider={currentProvider} isStreaming={isStreaming} />;
      case 'files':
        return (
          <FileChangesList
            fileChanges={fileChanges}
            undoingFiles={undoingFiles}
            isDiscardingAll={isDiscardingAll}
            onUndoClick={handleUndoClick}
            onDiscardAllClick={handleDiscardAllClick}
            onKeepAllClick={handleKeepAllClick}
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
          className={`status-panel-tab ${openPopover === 'todo' ? 'active' : ''}`}
          onClick={() => handleTabClick('todo')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleTabClick('todo');
            }
          }}
        >
          <span className="codicon codicon-checklist" />
          <span className="tab-label">
            {t(currentProvider === 'codex' ? 'statusPanel.todoTab' : 'statusPanel.tasksTab')}
          </span>
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
          className={`status-panel-tab ${openPopover === 'subagent' ? 'active' : ''}`}
          onClick={() => handleTabClick('subagent')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleTabClick('subagent');
            }
          }}
        >
          <span className="codicon codicon-hubot" />
          <span className="tab-label">{t('statusPanel.subagentTab')}</span>
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
          className={`status-panel-tab ${openPopover === 'files' ? 'active' : ''}`}
          onClick={() => handleTabClick('files')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleTabClick('files');
            }
          }}
        >
          <span className="codicon codicon-edit" />
          <span className="tab-label">{t('statusPanel.editsTab')}</span>
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
        <div className="status-panel-popover">
          {renderPopoverContent()}
        </div>
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
