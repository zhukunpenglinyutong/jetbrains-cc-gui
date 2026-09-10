import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HistoryData, HistorySessionSummary } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import { copyToClipboard } from '../../utils/copyUtils';
import { HistoryListItem } from './HistoryListItem';
import { HistoryHeader } from './HistoryHeader';
import { HistorySessionList } from './HistorySessionList';
import { HistoryConfirmDialogs } from './HistoryConfirmDialogs';
import { HistoryLoadingState, HistoryErrorState } from './HistoryStatusView';
import { useHistorySessions } from './useHistorySessions';
import { useHistorySelection } from './useHistorySelection';

// Deep search timeout (milliseconds)
const DEEP_SEARCH_TIMEOUT_MS = 30000;

const ROOT_STYLE: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
};

interface HistoryViewProps {
  historyData: HistoryData | null;
  currentProvider?: string; // Current provider (claude or codex)
  currentSessionId?: string | null; // Active session ID; its row must not offer conversion
  onLoadSession: (sessionId: string, provider?: string, model?: string, agent?: string) => void;
  onDeleteSession: (sessionId: string) => void; // Delete session callback
  onDeleteSessions: (sessionIds: string[]) => void; // Batch delete sessions callback
  onExportSession: (sessionId: string, title: string) => void; // Export session callback
  onToggleFavorite: (sessionId: string) => void; // Toggle favorite callback
  onUpdateTitle: (sessionId: string, newTitle: string) => void; // Update title callback
  onConvertToCliSession: (sessionId: string) => void; // Convert sidechain session to CLI session callback
}

const HistoryView = ({ historyData, currentProvider, currentSessionId, onLoadSession, onDeleteSession, onDeleteSessions, onExportSession, onToggleFavorite, onUpdateTitle, onConvertToCliSession }: HistoryViewProps) => {
  const { t } = useTranslation();
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight || 600);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null); // Session ID pending deletion
  const [convertingSessionId, setConvertingSessionId] = useState<string | null>(null); // Session ID pending conversion
  const [inputValue, setInputValue] = useState(''); // Immediate value of search input
  const [searchQuery, setSearchQuery] = useState(''); // Actual search keyword (debounced)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null); // Session ID being edited
  const [editingTitle, setEditingTitle] = useState(''); // Title content being edited
  const [isDeepSearching, setIsDeepSearching] = useState(false); // Deep search in-progress state
  const deepSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Deep search timeout timer
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Copy status timeout timer
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null); // Track which session ID was copied
  const [copyFailedSessionId, setCopyFailedSessionId] = useState<string | null>(null); // Track which session ID copy failed

  const { sessions, infoBar } = useHistorySessions(historyData, searchQuery, t);
  const {
    isSelectionMode,
    selectedSessionIds,
    selectedCount,
    allVisibleSelected,
    isDeletingSelected,
    enterSelectionMode,
    exitSelectionMode,
    toggleSessionSelection,
    toggleSelectAllVisible,
    confirmDeleteSelected,
    startDeleteSelected,
    cancelDeleteSelected,
  } = useHistorySelection(sessions, onDeleteSessions);

  // Clean up all timeout timers on unmount
  useEffect(() => {
    return () => {
      if (deepSearchTimeoutRef.current) {
        clearTimeout(deepSearchTimeoutRef.current);
        deepSearchTimeoutRef.current = null;
      }
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
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

  // When history data content updates, stop deep search state and clean up timeout timer.
  // Depend on stable content fields so an existing history list refresh also clears the spinner.
  useEffect(() => {
    if (historyData) {
      clearTimeout(deepSearchTimeoutRef.current ?? undefined);
      deepSearchTimeoutRef.current = null;
      setIsDeepSearching(false);
    }
  }, [historyData?.success, historyData?.total, historyData?.sessions]);

  const handleDeleteRequest = useCallback((sessionId: string) => {
    setDeletingSessionId(sessionId);
  }, []);

  const handleExportRequest = useCallback((sessionId: string, title: string) => {
    onExportSession(sessionId, title);
  }, [onExportSession]);

  const handleFavoriteRequest = useCallback((sessionId: string) => {
    onToggleFavorite(sessionId);
  }, [onToggleFavorite]);

  const confirmDelete = useCallback(() => {
    if (deletingSessionId) {
      onDeleteSession(deletingSessionId);
      setDeletingSessionId(null);
    }
  }, [deletingSessionId, onDeleteSession]);

  const cancelDelete = useCallback(() => {
    setDeletingSessionId(null);
  }, []);

  const handleEditStart = useCallback((sessionId: string, currentTitle: string) => {
    setEditingSessionId(sessionId);
    setEditingTitle(currentTitle);
  }, []);

  const handleEditSave = useCallback((sessionId: string, title: string) => {
    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      return; // Title cannot be empty
    }

    if (trimmedTitle.length > 50) {
      return;
    }

    onUpdateTitle(sessionId, trimmedTitle);
    setEditingSessionId(null);
    setEditingTitle('');
  }, [onUpdateTitle]);

  const handleEditCancel = useCallback(() => {
    setEditingSessionId(null);
    setEditingTitle('');
  }, []);

  const handleCopySessionId = useCallback(async (sessionId: string) => {
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    const success = await copyToClipboard(sessionId);
    if (success) {
      setCopiedSessionId(sessionId);
      setCopyFailedSessionId(null);
    } else {
      setCopyFailedSessionId(sessionId);
      setCopiedSessionId(null);
    }
    copyTimeoutRef.current = setTimeout(() => {
      setCopiedSessionId(null);
      setCopyFailedSessionId(null);
      copyTimeoutRef.current = null;
    }, 2000);
  }, []);

  const handleItemClick = useCallback((session: HistorySessionSummary, isEditing: boolean) => {
    if (isSelectionMode) {
      toggleSessionSelection(session.sessionId);
      return;
    }
    if (!isEditing) {
      onLoadSession(session.sessionId, session.provider, session.model, session.agent);
    }
  }, [isSelectionMode, toggleSessionSelection, onLoadSession]);

  const handleDeepSearch = useCallback(() => {
    if (isDeepSearching) return;

    sendBridgeEvent('deep_search_history', currentProvider || 'claude');

    clearTimeout(deepSearchTimeoutRef.current ?? undefined);

    deepSearchTimeoutRef.current = setTimeout(() => {
      setIsDeepSearching(false);
      deepSearchTimeoutRef.current = null;
    }, DEEP_SEARCH_TIMEOUT_MS);

    setIsDeepSearching(true);
  }, [isDeepSearching, currentProvider]);

  const handleConvertRequest = useCallback((sessionId: string) => {
    setConvertingSessionId(sessionId);
  }, []);

  const confirmConvert = useCallback(() => {
    if (convertingSessionId) {
      onConvertToCliSession(convertingSessionId);
      setConvertingSessionId(null);
    }
  }, [convertingSessionId, onConvertToCliSession]);

  const cancelConvert = useCallback(() => {
    setConvertingSessionId(null);
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  if (!historyData) {
    return <HistoryLoadingState t={t} />;
  }

  if (!historyData.success) {
    return <HistoryErrorState error={historyData.error} t={t} />;
  }

  const renderHistoryItem = (session: HistorySessionSummary) => (
    <HistoryListItem
      key={`${session.sessionId}-${session.lastTimestamp ?? '0'}`}
      session={session}
      isEditing={editingSessionId === session.sessionId}
      isSelected={selectedSessionIds.has(session.sessionId)}
      isSelectionMode={isSelectionMode}
      isCopied={copiedSessionId === session.sessionId}
      isCopyFailed={copyFailedSessionId === session.sessionId}
      isActiveSession={currentSessionId === session.sessionId}
      editingTitle={editingSessionId === session.sessionId ? editingTitle : ''}
      searchQuery={searchQuery}
      t={t}
      onItemClick={handleItemClick}
      onSelectionToggle={toggleSessionSelection}
      onEditStart={handleEditStart}
      onEditSave={handleEditSave}
      onEditCancel={handleEditCancel}
      onEditTitleChange={setEditingTitle}
      onExport={handleExportRequest}
      onDelete={handleDeleteRequest}
      onFavorite={handleFavoriteRequest}
      onCopySessionId={handleCopySessionId}
      onConvertToCliSession={handleConvertRequest}
    />
  );

  const listHeight = Math.max(240, viewportHeight - 118);

  return (
    <div style={ROOT_STYLE}>
      <HistoryHeader
        isSelectionMode={isSelectionMode}
        selectedCount={selectedCount}
        infoBar={infoBar}
        allVisibleSelected={allVisibleSelected}
        visibleCount={sessions.length}
        isDeepSearching={isDeepSearching}
        inputValue={inputValue}
        t={t}
        onEnterSelectionMode={enterSelectionMode}
        onExitSelectionMode={exitSelectionMode}
        onToggleSelectAllVisible={toggleSelectAllVisible}
        onStartDeleteSelected={startDeleteSelected}
        onDeepSearch={handleDeepSearch}
        onInputChange={handleInputChange}
      />
      <HistorySessionList
        sessions={sessions}
        height={listHeight}
        renderItem={renderHistoryItem}
        searchQuery={searchQuery}
        t={t}
      />
      <HistoryConfirmDialogs
        deletingSessionId={deletingSessionId}
        convertingSessionId={convertingSessionId}
        isDeletingSelected={isDeletingSelected}
        selectedCount={selectedCount}
        t={t}
        onCancelDelete={cancelDelete}
        onConfirmDelete={confirmDelete}
        onCancelConvert={cancelConvert}
        onConfirmConvert={confirmConvert}
        onCancelDeleteSelected={cancelDeleteSelected}
        onConfirmDeleteSelected={confirmDeleteSelected}
      />
    </div>
  );
};

export default HistoryView;
