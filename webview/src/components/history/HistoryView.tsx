import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { CONVERTIBLE_ENTRYPOINTS } from './historyItemUtils';

// Deep search timeout (milliseconds)
const DEEP_SEARCH_TIMEOUT_MS = 30000;

// How long a batch conversion may stay in flight before the UI stops waiting for the
// backend's answer. The backend answers once per run, so exceeding this means the
// answer is never coming (a dropped bridge message, a webview that was hidden
// mid-run). The guard has to be released anyway, otherwise the toolbar button stays
// disabled until the window is reloaded.
export const BATCH_CONVERSION_TIMEOUT_MS = 30000;

const ROOT_STYLE: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
};

/**
 * Aggregated outcome of a single `convert_all_to_cli_sessions` command.
 * The backend converts every convertible session in one pass and reports once,
 * so the UI never has to correlate N per-session callbacks.
 */
export interface BatchConversionResult {
  status: 'completed' | 'already_running' | 'failed';
  total?: number;
  converted?: number;
  skipped?: number;
  failed?: number;
  error?: string;
}

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
  const [isBatchConverting, setIsBatchConverting] = useState(false); // Batch conversion in progress
  // The in-flight guard lives in a ref as well as state: the click handler runs from a
  // stable callback, so it must see the current value without being recreated on every
  // keystroke, while the ref also protects against a second click inside one tick.
  const isBatchConvertingRef = useRef(false);
  // Watchdog that releases the in-flight guard if the backend never answers. Held in a
  // ref so the answer handler can cancel it without being re-created.
  const batchWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The answer handler is installed once and must stay stable, so the values it reads
  // come from refs. Re-registering it on every language or provider change used to
  // unregister it (cleanup sets it to undefined) in the middle of a running batch: the
  // answer then arrived nowhere and left isBatchConvertingRef stuck at true, so the
  // button stayed dead until the window was reloaded.
  const tRef = useRef(t);
  tRef.current = t;
  const providerRef = useRef(currentProvider);
  providerRef.current = currentProvider;
  const deepSearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Deep search timeout timer
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // Copy status timeout timer
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null); // Track which session ID was copied
  const [copyFailedSessionId, setCopyFailedSessionId] = useState<string | null>(null); // Track which session ID copy failed

  const { sessions, allSessions, infoBar } = useHistorySessions(historyData, searchQuery, t);
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
      // The batch watchdog lives outside the answer handler's effect on purpose:
      // it belongs to a single run, not to the registration, so tying its lifetime to
      // that effect would cancel it on every re-render that happens to re-run it.
      if (batchWatchdogRef.current) {
        clearTimeout(batchWatchdogRef.current);
        batchWatchdogRef.current = null;
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

  // Sessions that the backend can rewrite to a CLI entry. Counted over `allSessions`,
  // not over the filtered `sessions`: readProjectSessionCandidates walks the entire
  // project index regardless of the search box, so a filter that hides every
  // convertible row must not shrink the number on the button or flip it to the
  // "nothing to convert" explanation. The active session is excluded: the SDK still
  // appends to its jsonl, so converting it would drop those messages onto the old inode.
  const convertibleSessions = useMemo(
    () => allSessions.filter(
      s => s.sessionId !== currentSessionId
        && s.entrypoint != null
        && CONVERTIBLE_ENTRYPOINTS.has(s.entrypoint)
    ),
    [allSessions, currentSessionId]
  );

  const clearBatchWatchdog = useCallback(() => {
    if (batchWatchdogRef.current) {
      clearTimeout(batchWatchdogRef.current);
      batchWatchdogRef.current = null;
    }
  }, []);

  const convertAllToCliSessions = useCallback(() => {
    // One command for the whole set: the backend walks the index itself. Sending one
    // message per session meant N round-trips, N toasts and N optimistic updates for
    // a single user action, and the last answer could still land after a newer click.
    if (isBatchConvertingRef.current) {
      return;
    }
    isBatchConvertingRef.current = true;
    setIsBatchConverting(true);

    // A rejected event is a synchronous failure, not a slow run: the command never
    // reached Java, so no answer is coming. Waiting out the watchdog would leave the
    // button disabled for 30s and then blame the conversion for a broken bridge, so this
    // exit releases the whole guard here and reports the actual cause instead.
    if (!sendBridgeEvent('convert_all_to_cli_sessions')) {
      clearBatchWatchdog();
      isBatchConvertingRef.current = false;
      setIsBatchConverting(false);
      window.addToast?.(tRef.current('history.convertAllBridgeUnavailable', {
        defaultValue: 'The conversion could not be started: the plugin is not responding. Try again in a moment.',
      }), 'error');
      return;
    }

    // Safety net for an answer that never arrives. Without it the only thing that can
    // release the guard is the answer itself, and its loss (unmounted view, dropped
    // bridge message) would leave the button permanently disabled.
    clearBatchWatchdog();
    batchWatchdogRef.current = setTimeout(() => {
      batchWatchdogRef.current = null;
      if (!isBatchConvertingRef.current) {
        return;
      }
      isBatchConvertingRef.current = false;
      setIsBatchConverting(false);
      window.addToast?.(tRef.current('history.convertAllTimeout', {
        defaultValue: 'The conversion took too long. The list has been refreshed, please check it in a moment.',
      }), 'error');
      // Re-sync from the index: the run may well have finished on the backend.
      const provider = providerRef.current;
      if (provider) {
        sendBridgeEvent('deep_search_history', provider);
      }
    }, BATCH_CONVERSION_TIMEOUT_MS);
  }, [clearBatchWatchdog]);

  // Named rather than inlined in the effect below so the whole result-handling flow can
  // be read as one unit; the effect is left with nothing but registration. Behaviour is
  // unchanged: one aggregated answer per command, guard released first in every branch.
  const handleBatchConversionResult = useCallback((json: string) => {
    const reloadHistory = () => {
      // The entrypoint badges are derived from the index on disk, so a reload (not a
      // local patch) is the only way to show the real post-conversion state.
      const provider = providerRef.current;
      if (provider) {
        sendBridgeEvent('deep_search_history', provider);
      }
    };

    // Release the guard first and in every branch: a leaked guard would leave the
    // toolbar button permanently disabled with no way to retry.
    clearBatchWatchdog();
    isBatchConvertingRef.current = false;
    setIsBatchConverting(false);

    let result: BatchConversionResult;
    try {
      result = JSON.parse(json) as BatchConversionResult;
    } catch (error) {
      console.error('[Frontend] Failed to parse batch conversion result:', error);
      window.addToast?.(tRef.current('history.convertFailed', { defaultValue: 'Conversion failed' }), 'error');
      return;
    }

    if (result.status === 'already_running') {
      // The backend rejected the click because a batch is still in flight; nothing
      // was touched, so this is information, not an error.
      window.addToast?.(tRef.current('history.convertAllAlreadyRunning', {
        defaultValue: 'A conversion is already running, please wait for it to finish',
      }), 'info');
      return;
    }

    if (result.status === 'failed') {
      window.addToast?.(
        result.error || tRef.current('history.convertFailed', { defaultValue: 'Conversion failed' }),
        'error',
      );
      return;
    }

    const converted = result.converted ?? 0;
    const failed = result.failed ?? 0;
    const total = result.total ?? 0;

    // Exactly one toast for the whole run — a per-session report would be unusable
    // for a 50-session conversion.
    if (failed > 0) {
      window.addToast?.(tRef.current('history.convertAllPartial', {
        count: converted,
        total,
        failed,
        defaultValue: `Converted ${converted} of ${total} session(s), ${failed} failed`,
      }), 'warning');
    } else {
      window.addToast?.(tRef.current('history.convertAllSuccess', {
        count: converted,
        defaultValue: `${converted} session(s) converted, now visible in CLI /resume`,
      }), 'success');
    }

    // Reload even on a partial result: some entrypoints did change on disk.
    reloadHistory();
  }, [clearBatchWatchdog]);

  // One aggregated answer per command. Registered once and never re-registered, so a
  // language or provider change cannot unregister it while a batch is in flight; the
  // values it needs are read from refs instead of closing over them. Cleanup runs on
  // unmount only, so a stale handler from a dead view still cannot react to a result.
  useEffect(() => {
    window.onBatchConversionResult = handleBatchConversionResult;

    return () => {
      window.onBatchConversionResult = undefined;
    };
  }, [handleBatchConversionResult]);

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
        isConvertingAll={isBatchConverting}
        convertibleCount={convertibleSessions.length}
        inputValue={inputValue}
        t={t}
        onEnterSelectionMode={enterSelectionMode}
        onExitSelectionMode={exitSelectionMode}
        onToggleSelectAllVisible={toggleSelectAllVisible}
        onStartDeleteSelected={startDeleteSelected}
        onDeepSearch={handleDeepSearch}
        onConvertAllToCliSessions={convertAllToCliSessions}
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
