import { useCallback } from 'react';
import type { TFunction } from 'i18next';
import type { HistorySessionSummary } from '../../types';

export interface HistoryItemActionsProps {
  session: HistorySessionSummary;
  t: TFunction;
  onEditStart: (sessionId: string, currentTitle: string) => void;
  onExport: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  onFavorite: (sessionId: string) => void;
}

export const HistoryItemActions = ({
  session,
  t,
  onEditStart,
  onExport,
  onDelete,
  onFavorite,
}: HistoryItemActionsProps) => {
  const handleEditStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEditStart(session.sessionId, session.title);
  }, [onEditStart, session.sessionId, session.title]);

  const handleExport = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onExport(session.sessionId, session.title);
  }, [onExport, session.sessionId, session.title]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(session.sessionId);
  }, [onDelete, session.sessionId]);

  const handleFavorite = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onFavorite(session.sessionId);
  }, [onFavorite, session.sessionId]);

  return (
    <div className={`history-action-buttons ${session.isFavorited ? 'has-favorite' : ''}`}>
      <button
        className="history-edit-btn"
        onClick={handleEditStart}
        title={t('history.editTitle')}
        aria-label={t('history.editTitle')}
      >
        <span className="codicon codicon-edit"></span>
      </button>
      <button
        className="history-export-btn"
        onClick={handleExport}
        title={t('history.exportSession')}
        aria-label={t('history.exportSession')}
      >
        <span className="codicon codicon-arrow-down"></span>
      </button>
      <button
        className="history-delete-btn"
        onClick={handleDelete}
        title={t('history.deleteSession')}
        aria-label={t('history.deleteSession')}
      >
        <span className="codicon codicon-trash"></span>
      </button>
      <button
        className={`history-favorite-btn ${session.isFavorited ? 'favorited' : ''}`}
        onClick={handleFavorite}
        title={session.isFavorited ? t('history.unfavoriteSession') : t('history.favoriteSession')}
        aria-label={session.isFavorited ? t('history.unfavoriteSession') : t('history.favoriteSession')}
      >
        <span className={session.isFavorited ? 'codicon codicon-star-full' : 'codicon codicon-star-empty'}></span>
      </button>
    </div>
  );
};
