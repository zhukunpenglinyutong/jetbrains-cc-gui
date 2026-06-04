import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { BackIcon, SearchIcon, PlusIcon, LayoutIcon, HistoryIcon, SettingsIcon, CheckIcon, CloseIcon, EditIcon } from '../Icons';

export interface ChatHeaderProps {
  currentView: 'chat' | 'history' | 'settings';
  sessionTitle: string;
  t: TFunction;
  onBack: () => void;
  onNewSession: () => void;
  onNewTab: () => void;
  onHistory: () => void;
  onSettings: () => void;
  /**
   * Opens the in-conversation search panel. Only rendered when provided.
   * Wired up by App.tsx via UIStateContext.setSearchOpen.
   */
  onOpenSearch?: () => void;
  onTitleChange?: (newTitle: string) => void;
  titleEditable?: boolean;
}

export function ChatHeader({
  currentView,
  sessionTitle,
  t,
  onBack,
  onNewSession,
  onNewTab,
  onHistory,
  onSettings,
  onOpenSearch,
  onTitleChange,
  titleEditable = false,
}: ChatHeaderProps): React.ReactElement | null {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!titleEditable) {
      setEditing(false);
    }
  }, [titleEditable]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    if (!titleEditable || !onTitleChange) return;
    setEditValue(sessionTitle);
    setEditing(true);
  }, [titleEditable, onTitleChange, sessionTitle]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim().slice(0, 50);
    if (trimmed && trimmed !== sessionTitle && onTitleChange) {
      onTitleChange(trimmed);
    }
  }, [editValue, sessionTitle, onTitleChange]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }, [commitEdit, cancelEdit]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    // If focus moves to save/cancel button inside edit container, let that button handle it
    const editContainer = e.currentTarget.closest('.session-title-edit-mode');
    if (editContainer && editContainer.contains(e.relatedTarget as Node)) {
      return;
    }
    commitEdit();
  }, [commitEdit]);

  if (currentView === 'settings') {
    return null;
  }

  return (
    <div className="header">
      <div className="header-left">
        {currentView === 'history' ? (
          <button className="back-button" onClick={onBack} data-tooltip={t('common.back')}>
            <BackIcon size={16} /> {t('common.back')}
          </button>
        ) : editing ? (
          <div className="session-title-edit-mode" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              type="text"
              className="session-title-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              maxLength={50}
              spellCheck={false}
              aria-label="Session title"
            />
            <button className="session-title-save-btn" onClick={commitEdit} aria-label="Save title">
              <CheckIcon size={14} />
            </button>
            <button className="session-title-cancel-btn" onClick={cancelEdit} aria-label="Cancel editing">
              <CloseIcon size={14} />
            </button>
          </div>
        ) : (
          <div className="session-title-wrapper">
            <div className="session-title">
              {sessionTitle}
            </div>
            {titleEditable && (
              <button className="session-title-edit-btn" onClick={startEditing} aria-label="Edit session title">
                <EditIcon size={14} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="header-right">
        {currentView === 'chat' && (
          <>
            {onOpenSearch && (
              <button
                className="icon-button"
                onClick={onOpenSearch}
                data-tooltip={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
                aria-label={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
              >
                <SearchIcon size={16} />
              </button>
            )}
            <button className="icon-button" onClick={onNewSession} data-tooltip={t('common.newSession')}>
              <PlusIcon size={16} />
            </button>
            <button
              className="icon-button"
              onClick={onNewTab}
              data-tooltip={t('common.newTab')}
            >
              <LayoutIcon size={16} />
            </button>
            <button
              className="icon-button"
              onClick={onHistory}
              data-tooltip={t('common.history')}
            >
              <HistoryIcon size={16} />
            </button>
            <button
              className="icon-button"
              onClick={onSettings}
              data-tooltip={t('common.settings')}
            >
              <SettingsIcon size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
