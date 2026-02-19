import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryData, HistorySessionSummary } from '../../types';
import VirtualList from './VirtualList';
import { Claude, OpenAI } from '@lobehub/icons';
import { extractCommandMessageContent } from '../../utils/messageUtils';
import { sendBridgeEvent } from '../../utils/bridge';

// Deep search timeout (milliseconds)
const DEEP_SEARCH_TIMEOUT_MS = 30000;

interface HistoryViewProps {
  historyData: HistoryData | null;
  currentProvider?: string; // Current provider (claude or codex)
  onLoadSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void; // Delete session callback
  onExportSession: (sessionId: string, title: string) => void; // Export session callback
  onToggleFavorite: (sessionId: string) => void; // Toggle favorite callback
  onUpdateTitle: (sessionId: string, newTitle: string) => void; // Update title callback
}

const formatTimeAgo = (timestamp: string | undefined, t: (key: string) => string) => {
  if (!timestamp) {
    return '';
  }
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  const units: [number, string][] = [
    [31536000, t('history.timeAgo.yearsAgo')],
    [2592000, t('history.timeAgo.monthsAgo')],
    [86400, t('history.timeAgo.daysAgo')],
    [3600, t('history.timeAgo.hoursAgo')],
    [60, t('history.timeAgo.minutesAgo')],
  ];

  for (const [unitSeconds, label] of units) {
    const interval = Math.floor(seconds / unitSeconds);
    if (interval >= 1) {
      return `${interval} ${label}`;
    }
  }
  return `${Math.max(seconds, 1)} ${t('history.timeAgo.secondsAgo')}`;
};

const HistoryView = ({ historyData, currentProvider, onLoadSession, onDeleteSession, onExportSession, onToggleFavorite, onUpdateTitle }: HistoryViewProps) => {
  const { t } = useTranslation();
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight || 600);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null); // Session ID pending deletion
  const [inputValue, setInputValue] = useState(''); // Immediate value of search input
  const [searchQuery, setSearchQuery] = useState(''); // Actual search keyword (debounced)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null); // Session ID being edited
  const [editingTitle, setEditingTitle] = useState(''); // Title content being edited
  const [isDeepSearching, setIsDeepSearching] = useState(false); // Deep search in-progress state
  const deepSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Deep search timeout timer

  // Clean up deep search timeout timer
  useEffect(() => {
    return () => {
      if (deepSearchTimeoutRef.current) {
        clearTimeout(deepSearchTimeoutRef.current);
        deepSearchTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleResize = () => setViewportHeight(window.innerHeight || 600);
    window.addEventListener('resize', handleResize, { passive: true });
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Debounce: update search keyword 300ms after input stops
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchQuery(inputValue);
    }, 300);

    return () => clearTimeout(timer);
  }, [inputValue]);

  // When historyData updates, stop deep search state and clean up timeout timer
  // Uses functional update to avoid isDeepSearching dependency while cleaning up the corresponding timeout
  useEffect(() => {
    if (historyData) {
      setIsDeepSearching(prev => {
        if (prev && deepSearchTimeoutRef.current) {
          clearTimeout(deepSearchTimeoutRef.current);
          deepSearchTimeoutRef.current = null;
        }
        return false;
      });
    }
  }, [historyData]);

  // Sort and filter sessions: favorited on top (by favorite time descending), unfavorited below (original order)
  const sessions = useMemo(() => {
    const rawSessions = historyData?.sessions ?? [];

    // Search filter (case-insensitive)
    const filteredSessions = searchQuery.trim()
      ? rawSessions.filter(s =>
          s.title?.toLowerCase().includes(searchQuery.toLowerCase())
        )
      : rawSessions;

    // Separate favorited and unfavorited sessions
    const favorited = filteredSessions.filter(s => s.isFavorited);
    const unfavorited = filteredSessions.filter(s => !s.isFavorited);

    // Sort favorited sessions by favorite time descending
    favorited.sort((a, b) => (b.favoritedAt || 0) - (a.favoritedAt || 0));

    // Merge: favorited first, unfavorited after
    return [...favorited, ...unfavorited];
  }, [historyData?.sessions, searchQuery]);

  const infoBar = useMemo(() => {
    if (!historyData) {
      return '';
    }
    const sessionCount = sessions.length;
    const messageCount = historyData.total ?? 0;
    return t('history.totalSessions', { count: sessionCount, total: messageCount });
  }, [historyData, sessions.length, t]);

  if (!historyData) {
    return (
      <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#858585' }}>
          <div style={{
            width: '48px',
            height: '48px',
            margin: '0 auto 16px',
            border: '4px solid rgba(133, 133, 133, 0.2)',
            borderTop: '4px solid #858585',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }}></div>
          <div>{t('history.loading')}</div>
        </div>
      </div>
    );
  }

  if (!historyData.success) {
    return (
      <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#858585' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
          <div>{historyData.error ?? t('history.loadFailed')}</div>
        </div>
      </div>
    );
  }

  // Render empty state (no search results or no sessions)
  const renderEmptyState = () => {
    // If search returned no results
    if (searchQuery.trim() && sessions.length === 0) {
      return (
        <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <div style={{ textAlign: 'center', color: '#858585' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔍</div>
            <div>{t('history.noSearchResults')}</div>
            <div style={{ fontSize: '12px', marginTop: '8px' }}>尝试其他搜索关键词</div>
          </div>
        </div>
      );
    }

    // If there are no sessions at all
    if (!searchQuery.trim() && sessions.length === 0) {
      return (
        <div className="messages-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <div style={{ textAlign: 'center', color: '#858585' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>📭</div>
            <div>{t('history.noSessions')}</div>
            <div style={{ fontSize: '12px', marginTop: '8px' }}>{t('history.noSessionsDesc')}</div>
          </div>
        </div>
      );
    }

    return null;
  };

  // Handle delete button click (stop event bubbling to avoid triggering session load)
  const handleDeleteClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation(); // Prevent click event from bubbling to parent
    setDeletingSessionId(sessionId); // Show confirmation dialog
  };

  // Handle export button click (stop event bubbling to avoid triggering session load)
  const handleExportClick = (e: React.MouseEvent, sessionId: string, title: string) => {
    e.stopPropagation(); // Prevent click event from bubbling to parent
    onExportSession(sessionId, title);
  };

  // Handle favorite button click (stop event bubbling to avoid triggering session load)
  const handleFavoriteClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation(); // Prevent click event from bubbling to parent
    onToggleFavorite(sessionId);
  };

  // Confirm deletion
  const confirmDelete = () => {
    if (deletingSessionId) {
      onDeleteSession(deletingSessionId);
      setDeletingSessionId(null);
    }
  };

  // Cancel deletion
  const cancelDelete = () => {
    setDeletingSessionId(null);
  };

  // Handle edit button click
  const handleEditClick = (e: React.MouseEvent, sessionId: string, currentTitle: string) => {
    e.stopPropagation(); // Prevent click event from bubbling to parent
    setEditingSessionId(sessionId);
    setEditingTitle(currentTitle);
  };

  // Save the edited title
  const handleSaveTitle = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    const trimmedTitle = editingTitle.trim();

    if (!trimmedTitle) {
      return; // Title cannot be empty
    }

    if (trimmedTitle.length > 50) {
      // Exceeds 50 characters, show error alert
      alert(t('history.titleTooLong'));
      return;
    }

    // Call callback to update the title
    onUpdateTitle(sessionId, trimmedTitle);

    // Exit edit mode
    setEditingSessionId(null);
    setEditingTitle('');
  };

  // Cancel editing
  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(null);
    setEditingTitle('');
  };

  // Deep search: clear cache and reload history
  const handleDeepSearch = () => {
    if (isDeepSearching) return;

    setIsDeepSearching(true);
    sendBridgeEvent('deep_search_history', currentProvider || 'claude');

    // Clear previous timeout if it exists
    if (deepSearchTimeoutRef.current) {
      clearTimeout(deepSearchTimeoutRef.current);
    }

    // Set timeout to auto-recover state (prevent infinite loading on errors)
    deepSearchTimeoutRef.current = setTimeout(() => {
      setIsDeepSearching(false);
      deepSearchTimeoutRef.current = null;
    }, DEEP_SEARCH_TIMEOUT_MS);
  };

  // Highlight matching text
  const highlightText = (text: string, query: string) => {
    if (!query.trim()) {
      return <span>{text}</span>;
    }

    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const index = lowerText.indexOf(lowerQuery);

    if (index === -1) {
      return <span>{text}</span>;
    }

    const before = text.slice(0, index);
    const match = text.slice(index, index + query.length);
    const after = text.slice(index + query.length);

    return (
      <span>
        {before}
        <mark style={{ backgroundColor: '#ffd700', color: '#000', padding: '0 2px' }}>{match}</mark>
        {after}
      </span>
    );
  };

  const renderHistoryItem = (session: HistorySessionSummary) => {
    const isEditing = editingSessionId === session.sessionId;

    return (
      <div key={session.sessionId} className="history-item" onClick={() => !isEditing && onLoadSession(session.sessionId)}>
        <div className="history-item-header">
          <div className="history-item-title">
            {/* Provider Logo */}
            {session.provider && (
              <span
                className="history-provider-badge"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  marginRight: '8px',
                  verticalAlign: 'middle'
                }}
                title={session.provider === 'claude' ? 'Claude' : 'Codex'}
              >
                {session.provider === 'codex' ? (
                  <OpenAI.Avatar size={20} />
                ) : (
                  <Claude.Color size={20} />
                )}
              </span>
            )}
            {isEditing ? (
              // Edit mode: show input and save/cancel buttons
              <div className="history-title-edit-mode" onClick={(e) => e.stopPropagation()}>
                <input
                  type="text"
                  className="history-title-input"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  maxLength={50}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleSaveTitle(e as any, session.sessionId);
                    } else if (e.key === 'Escape') {
                      handleCancelEdit(e as any);
                    }
                  }}
                />
                <button
                  className="history-title-save-btn"
                  onClick={(e) => handleSaveTitle(e, session.sessionId)}
                  title={t('history.saveTitleButton')}
                >
                  <span className="codicon codicon-check"></span>
                </button>
                <button
                  className="history-title-cancel-btn"
                  onClick={(e) => handleCancelEdit(e)}
                  title={t('history.cancelEditButton')}
                >
                  <span className="codicon codicon-close"></span>
                </button>
              </div>
            ) : (
              // Normal mode: show title (with highlight), extract <command-message> content
              highlightText(extractCommandMessageContent(session.title), searchQuery)
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="history-item-time">{formatTimeAgo(session.lastTimestamp, t)}</div>
            {!isEditing && (
              <>
                {/* Edit button */}
                <button
                  className="history-edit-btn"
                  onClick={(e) => handleEditClick(e, session.sessionId, session.title)}
                  title={t('history.editTitle')}
                  aria-label={t('history.editTitle')}
                >
                  <span className="codicon codicon-edit"></span>
                </button>
                {/* Favorite button */}
                <button
                  className={`history-favorite-btn ${session.isFavorited ? 'favorited' : ''}`}
                  onClick={(e) => handleFavoriteClick(e, session.sessionId)}
                  title={session.isFavorited ? t('history.unfavoriteSession') : t('history.favoriteSession')}
                  aria-label={session.isFavorited ? t('history.unfavoriteSession') : t('history.favoriteSession')}
                >
                  <span className={session.isFavorited ? 'codicon codicon-star-full' : 'codicon codicon-star-empty'}></span>
                </button>
                {/* Export button */}
                <button
                  className="history-export-btn"
                  onClick={(e) => handleExportClick(e, session.sessionId, session.title)}
                  title={t('history.exportSession')}
                  aria-label={t('history.exportSession')}
                >
                  <span className="codicon codicon-arrow-down"></span>
                </button>
                {/* Delete button */}
                <button
                  className="history-delete-btn"
                  onClick={(e) => handleDeleteClick(e, session.sessionId)}
                  title={t('history.deleteSession')}
                  aria-label={t('history.deleteSession')}
                >
                  <span className="codicon codicon-trash"></span>
                </button>
              </>
            )}
          </div>
        </div>
        <div className="history-item-meta">
          <span>{t('history.messageCount', { count: session.messageCount })}</span>
          <span style={{ fontFamily: 'var(--idea-editor-font-family, monospace)', color: '#666' }}>{session.sessionId.slice(0, 8)}</span>
        </div>
      </div>
    );
  };

  const listHeight = Math.max(240, viewportHeight - 118);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="history-header">
        <div className="history-info">{infoBar}</div>
        {/* Deep search button */}
        <button
          className={`history-deep-search-btn ${isDeepSearching ? 'searching' : ''}`}
          onClick={handleDeepSearch}
          disabled={isDeepSearching}
          title={t('history.deepSearchTooltip')}
        >
          <span className={`codicon ${isDeepSearching ? 'codicon-sync codicon-modifier-spin' : 'codicon-refresh'}`}></span>
        </button>
        {/* Search box */}
        <div className="history-search-container">
          <input
            type="text"
            className="history-search-input"
            placeholder={t('history.searchPlaceholder')}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
          />
          <span
            className="codicon codicon-search history-search-icon"
          ></span>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {sessions.length > 0 ? (
          <VirtualList
            items={sessions}
            itemHeight={78}
            height={listHeight}
            renderItem={renderHistoryItem}
            getItemKey={(session) => session.sessionId}
            className="messages-container"
          />
        ) : (
          renderEmptyState()
        )}
      </div>

      {/* Delete confirmation dialog */}
      {deletingSessionId && (
        <div className="modal-overlay" onClick={cancelDelete}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>{t('history.confirmDelete')}</h3>
            <p>{t('history.deleteMessage')}</p>
            <div className="modal-actions">
              <button className="modal-btn modal-btn-cancel" onClick={cancelDelete}>
                {t('common.cancel')}
              </button>
              <button className="modal-btn modal-btn-danger" onClick={confirmDelete}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryView;

