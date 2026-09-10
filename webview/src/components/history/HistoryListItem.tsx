import { memo, useCallback } from 'react';
import type { TFunction } from 'i18next';
import type { HistorySessionSummary } from '../../types';
import { formatTimeAgo } from './historyItemUtils';
import { HistorySelectionCheckbox } from './HistorySelectionCheckbox';
import { HistoryItemTitle } from './HistoryItemTitle';
import { HistoryItemActions } from './HistoryItemActions';
import { HistoryItemMeta } from './HistoryItemMeta';

// Re-exported from the extracted sibling so existing consumers
// (e.g. HistoryConfirmDialogs) keep their import paths.
export { formatTimeAgo, formatFileSize, highlightText, stopPropagationHandler } from './historyItemUtils';

export interface HistoryListItemProps {
  session: HistorySessionSummary;
  isEditing: boolean;
  isSelected: boolean;
  isSelectionMode: boolean;
  isCopied: boolean;
  isCopyFailed: boolean;
  isActiveSession: boolean;
  editingTitle: string;
  searchQuery: string;
  t: TFunction;
  onItemClick: (session: HistorySessionSummary, isEditing: boolean) => void;
  onSelectionToggle: (sessionId: string) => void;
  onEditStart: (sessionId: string, currentTitle: string) => void;
  onEditSave: (sessionId: string, title: string) => void;
  onEditCancel: () => void;
  onEditTitleChange: (value: string) => void;
  onExport: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  onFavorite: (sessionId: string) => void;
  onCopySessionId: (sessionId: string) => void;
  onConvertToCliSession: (sessionId: string) => void;
}

export const HistoryListItem = memo(({
  session,
  isEditing,
  isSelected,
  isSelectionMode,
  isCopied,
  isCopyFailed,
  isActiveSession,
  editingTitle,
  searchQuery,
  t,
  onItemClick,
  onSelectionToggle,
  onEditStart,
  onEditSave,
  onEditCancel,
  onEditTitleChange,
  onExport,
  onDelete,
  onFavorite,
  onCopySessionId,
  onConvertToCliSession,
}: HistoryListItemProps) => {
  const handleRowClick = useCallback(() => {
    onItemClick(session, isEditing);
  }, [onItemClick, session, isEditing]);

  return (
    <div
      className={`history-item ${isSelectionMode ? 'selection-mode' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={handleRowClick}
    >
      <div className="history-item-header">
        {isSelectionMode && (
          <HistorySelectionCheckbox
            sessionId={session.sessionId}
            sessionTitle={session.title}
            isSelected={isSelected}
            t={t}
            onSelectionToggle={onSelectionToggle}
          />
        )}
        <HistoryItemTitle
          session={session}
          isEditing={isEditing}
          editingTitle={editingTitle}
          searchQuery={searchQuery}
          t={t}
          onEditSave={onEditSave}
          onEditCancel={onEditCancel}
          onEditTitleChange={onEditTitleChange}
        />
        <div className="history-item-time">{formatTimeAgo(session.lastTimestamp, t)}</div>
        {!isEditing && !isSelectionMode && (
          <HistoryItemActions
            session={session}
            t={t}
            onEditStart={onEditStart}
            onExport={onExport}
            onDelete={onDelete}
            onFavorite={onFavorite}
          />
        )}
      </div>
      <HistoryItemMeta
        session={session}
        isCopied={isCopied}
        isCopyFailed={isCopyFailed}
        isActiveSession={isActiveSession}
        t={t}
        onCopySessionId={onCopySessionId}
        onConvertToCliSession={onConvertToCliSession}
      />
    </div>
  );
});

HistoryListItem.displayName = 'HistoryListItem';
