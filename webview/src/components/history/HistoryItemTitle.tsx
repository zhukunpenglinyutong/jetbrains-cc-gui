import { useCallback } from 'react';
import type { TFunction } from 'i18next';
import type { HistorySessionSummary } from '../../types';
import { extractCommandMessageContent } from '../../utils/messageUtils';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';
import { highlightText, stopPropagationHandler } from './historyItemUtils';

// Module-level style constant (avoid breaking memoization)
const PROVIDER_BADGE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  marginRight: '8px',
  verticalAlign: 'middle',
};

export interface HistoryItemTitleProps {
  session: HistorySessionSummary;
  isEditing: boolean;
  editingTitle: string;
  searchQuery: string;
  t: TFunction;
  onEditSave: (sessionId: string, title: string) => void;
  onEditCancel: () => void;
  onEditTitleChange: (value: string) => void;
}

export const HistoryItemTitle = ({
  session,
  isEditing,
  editingTitle,
  searchQuery,
  t,
  onEditSave,
  onEditCancel,
  onEditTitleChange,
}: HistoryItemTitleProps) => {
  const handleEditSave = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onEditSave(session.sessionId, editingTitle);
  }, [onEditSave, session.sessionId, editingTitle]);

  const handleEditCancel = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onEditCancel();
  }, [onEditCancel]);

  const handleEditChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onEditTitleChange(e.target.value);
  }, [onEditTitleChange]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleEditSave(e);
    } else if (e.key === 'Escape') {
      handleEditCancel(e);
    }
  }, [handleEditSave, handleEditCancel]);

  return (
    <div className="history-item-title">
      {/* Provider Logo */}
      {session.provider && (
        <span
          className="history-provider-badge"
          style={PROVIDER_BADGE_STYLE}
          title={session.provider === 'claude' ? 'Claude' : 'Codex'}
        >
          <ProviderModelIcon providerId={session.provider} size={20} colored />
        </span>
      )}
      {isEditing ? (
        <div className="history-title-edit-mode" onClick={stopPropagationHandler}>
          <input
            type="text"
            className="history-title-input"
            value={editingTitle}
            onChange={handleEditChange}
            maxLength={50}
            autoFocus
            onKeyDown={handleEditKeyDown}
          />
          <button
            className="history-title-save-btn"
            onClick={handleEditSave}
            title={t('history.saveTitleButton')}
          >
            <span className="codicon codicon-check"></span>
          </button>
          <button
            className="history-title-cancel-btn"
            onClick={handleEditCancel}
            title={t('history.cancelEditButton')}
          >
            <span className="codicon codicon-close"></span>
          </button>
        </div>
      ) : (
        highlightText(extractCommandMessageContent(session.title), searchQuery)
      )}
    </div>
  );
};
