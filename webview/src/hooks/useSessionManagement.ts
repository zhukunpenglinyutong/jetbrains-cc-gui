import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, HistoryData } from '../types';
import { sendBridgeEvent } from '../utils/bridge';

type ViewMode = 'chat' | 'history' | 'settings';

type ToastType = 'info' | 'success' | 'warning' | 'error';

const createSessionTransitionToken = () =>
  `transition-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

interface UseSessionManagementOptions {
  messages: ClaudeMessage[];
  loading: boolean;
  historyData: HistoryData | null;
  currentSessionId: string | null;
  setHistoryData: React.Dispatch<React.SetStateAction<HistoryData | null>>;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setCurrentView: (view: ViewMode) => void;
  setCurrentSessionId: (id: string | null) => void;
  setCustomSessionTitle: (title: string | null) => void;
  setUsagePercentage: (percent: number) => void;
  setUsageUsedTokens: (tokens: number | undefined) => void;
  setUsageMaxTokens: (tokens: number | undefined) => void;
  setStatus: (status: string) => void;
  setLoading: (loading: boolean) => void;
  setIsThinking: (thinking: boolean) => void;
  setStreamingActive: (active: boolean) => void;
  clearToasts: () => void;
  addToast: (message: string, type?: ToastType) => void;
  t: TFunction;
}

interface UseSessionManagementReturn {
  showNewSessionConfirm: boolean;
  showInterruptConfirm: boolean;
  suppressNextStatusToastRef: React.MutableRefObject<boolean>;
  createNewSession: () => void;
  forceCreateNewSession: () => void;
  handleConfirmNewSession: () => void;
  handleCancelNewSession: () => void;
  handleConfirmInterrupt: () => void;
  handleCancelInterrupt: () => void;
  loadHistorySession: (sessionId: string) => void;
  deleteHistorySession: (sessionId: string) => void;
  deleteHistorySessions: (sessionIds: string[]) => void;
  exportHistorySession: (sessionId: string, title: string) => void;
  toggleFavoriteSession: (sessionId: string) => void;
  updateHistoryTitle: (sessionId: string, newTitle: string) => void;
}

/**
 * Hook for managing session operations (create, load, delete, export, etc.)
 */
export function useSessionManagement({
  messages,
  loading,
  historyData,
  currentSessionId,
  setHistoryData,
  setMessages,
  setCurrentView,
  setCurrentSessionId,
  setCustomSessionTitle,
  setUsagePercentage,
  setUsageUsedTokens,
  setUsageMaxTokens,
  setStatus,
  setLoading: setLoadingState,
  setIsThinking,
  setStreamingActive,
  clearToasts,
  addToast,
  t,
}: UseSessionManagementOptions): UseSessionManagementReturn {
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [showInterruptConfirm, setShowInterruptConfirm] = useState(false);
  const pendingActionRef = useRef<'newSession' | null>(null);
  const suppressNextStatusToastRef = useRef(false);
  const transitionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyDataRef = useRef(historyData);
  historyDataRef.current = historyData;
  const showSessionDeletedToast = useCallback((afterSessionTransition = false) => {
    const toast = { message: t('history.sessionDeleted'), type: 'success' as const };
    if (afterSessionTransition) {
      window.__pendingSessionTransitionToast = toast;
      return;
    }
    addToast(toast.message, toast.type);
  }, [addToast, t]);

  const beginSessionTransition = useCallback((nextSessionId: string | null, nextTitle: string | null) => {
    window.__sessionTransitioning = true;
    window.__sessionTransitionToken = createSessionTransitionToken();
    // Use the single cleanup entry point exposed by useWindowCallbacks.
    // This clears both React state AND internal streaming refs in one shot.
    if (typeof (window as any).__resetTransientUiState === 'function') {
      (window as any).__resetTransientUiState();
    } else {
      // Fallback if useWindowCallbacks hasn't mounted yet (e.g. during SSR/tests)
      clearToasts();
      setStatus('');
      setLoadingState(false);
      setIsThinking(false);
      setStreamingActive(false);
    }
    setMessages([]);
    setCurrentSessionId(nextSessionId);
    setCustomSessionTitle(nextTitle);
    setUsagePercentage(0);
    setUsageUsedTokens(undefined);
    setUsageMaxTokens(undefined);

    // FIX: Safety timeout to auto-release the session transition guard.
    // If the backend's historyLoadComplete signal is lost (e.g., JCEF IPC failure
    // during webview reload, or a backend error that prevents the callback),
    // __sessionTransitioning would remain true permanently, silently dropping ALL
    // message callbacks (updateMessages, onContentDelta, onStreamStart, etc.).
    // This makes the webview appear "dead" while the backend continues working.
    if (transitionTimeoutRef.current !== null) {
      clearTimeout(transitionTimeoutRef.current);
    }
    const token = window.__sessionTransitionToken;
    transitionTimeoutRef.current = setTimeout(() => {
      transitionTimeoutRef.current = null;
      if (window.__sessionTransitioning && window.__sessionTransitionToken === token) {
        console.warn('[SessionManagement] Transition guard timed out — auto-releasing');
        window.__sessionTransitioning = false;
        window.__sessionTransitionToken = null;
      }
    }, 15_000); // 15 seconds — generous enough for slow history loads
  }, [clearToasts, setStatus, setLoadingState, setIsThinking, setStreamingActive, setMessages, setCurrentSessionId, setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, setUsageMaxTokens]);

  // Create new session
  const createNewSession = useCallback(() => {
    // [FIX] Prioritize loading check - if AI is responding, must interrupt first
    // This prevents creating new session without stopping the current conversation
    if (loading) {
      // If loading (AI is responding), show interrupt confirmation
      pendingActionRef.current = 'newSession';
      setShowInterruptConfirm(true);
    } else if (messages.length > 0) {
      // If there are messages but not loading, show new session confirmation
      pendingActionRef.current = 'newSession';
      setShowNewSessionConfirm(true);
    } else {
      // If empty and not loading, directly create new session
      beginSessionTransition(null, null);
      sendBridgeEvent('create_new_session');
    }
  }, [beginSessionTransition, messages.length, loading]);

  // Force create new session (no confirmation, used by /clear /new /reset commands)
  const forceCreateNewSession = useCallback(() => {
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }
    beginSessionTransition(null, null);
    sendBridgeEvent('create_new_session');
  }, [beginSessionTransition, loading]);

  // Confirm new session
  const handleConfirmNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
    // [FIX] Safety check: if loading started while dialog was open, send interrupt first
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }
    beginSessionTransition(null, null);
    sendBridgeEvent('create_new_session');
    pendingActionRef.current = null;
  }, [beginSessionTransition, loading]);

  // Cancel new session
  const handleCancelNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
    pendingActionRef.current = null;
  }, []);

  // Confirm interrupt
  const handleConfirmInterrupt = useCallback(() => {
    setShowInterruptConfirm(false);
    // Send interrupt signal and create new session
    sendBridgeEvent('interrupt_session');
    beginSessionTransition(null, null);
    sendBridgeEvent('create_new_session');
    pendingActionRef.current = null;
  }, [beginSessionTransition]);

  // Cancel interrupt
  const handleCancelInterrupt = useCallback(() => {
    setShowInterruptConfirm(false);
    pendingActionRef.current = null;
  }, []);

  // Load history session
  const loadHistorySession = useCallback((sessionId: string) => {
    // [FIX] Send interrupt signal if AI is responding
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }

    const session = historyDataRef.current?.sessions?.find(s => s.sessionId === sessionId);
    beginSessionTransition(sessionId, session?.title ?? null);
    sendBridgeEvent('load_session', sessionId);
    setCurrentView('chat');
  }, [beginSessionTransition, loading, setCurrentView]);

  // Delete history session
  const deleteHistorySession = useCallback((sessionId: string) => {
    // Send delete request to Java backend
    sendBridgeEvent('delete_session', sessionId);
    let startedSessionTransition = false;

    // Immediately update frontend state, remove session from history list
    if (historyData && historyData.sessions) {
      setHistoryData(prevHistoryData => {
        if (!prevHistoryData?.sessions) {
          return prevHistoryData;
        }

        const deletedSession = prevHistoryData.sessions.find(s => s.sessionId === sessionId);
        return {
          ...prevHistoryData,
          sessions: prevHistoryData.sessions.filter(s => s.sessionId !== sessionId),
          total: Math.max(0, (prevHistoryData.total || 0) - (deletedSession?.messageCount || 0))
        };
      });

      // If deleted session is current session, clear messages and reset state
      if (sessionId === currentSessionId) {
        // [FIX] Send interrupt signal if AI is responding
        if (loading) {
          sendBridgeEvent('interrupt_session');
        }
        beginSessionTransition(null, null);
        startedSessionTransition = true;
        // Set flag to suppress next updateStatus toast
        suppressNextStatusToastRef.current = true;
        sendBridgeEvent('create_new_session');
      }

    }
    showSessionDeletedToast(startedSessionTransition);
  }, [historyData, currentSessionId, loading, setHistoryData, setMessages, setCurrentSessionId, setCustomSessionTitle, setUsagePercentage, setUsageUsedTokens, showSessionDeletedToast]);

  // Batch delete history sessions
  const deleteHistorySessions = useCallback((sessionIds: string[]) => {
    const uniqueSessionIds = Array.from(new Set(sessionIds.filter(Boolean)));
    if (uniqueSessionIds.length === 0) {
      return;
    }

    sendBridgeEvent('delete_sessions', JSON.stringify(uniqueSessionIds));
    let startedSessionTransition = false;

    if (historyData && historyData.sessions) {
      const deletedSessionIds = new Set(uniqueSessionIds);
      setHistoryData(prevHistoryData => {
        if (!prevHistoryData?.sessions) {
          return prevHistoryData;
        }

        const deletedMessageCount = prevHistoryData.sessions.reduce((sum, session) => (
          deletedSessionIds.has(session.sessionId) ? sum + (session.messageCount || 0) : sum
        ), 0);

        return {
          ...prevHistoryData,
          sessions: prevHistoryData.sessions.filter(session => !deletedSessionIds.has(session.sessionId)),
          total: Math.max(0, (prevHistoryData.total || 0) - deletedMessageCount)
        };
      });

      if (currentSessionId && deletedSessionIds.has(currentSessionId)) {
        if (loading) {
          sendBridgeEvent('interrupt_session');
        }
        beginSessionTransition(null, null);
        startedSessionTransition = true;
        suppressNextStatusToastRef.current = true;
        sendBridgeEvent('create_new_session');
      }

    }
    showSessionDeletedToast(startedSessionTransition);
  }, [historyData, currentSessionId, loading, setHistoryData, beginSessionTransition, showSessionDeletedToast]);

  // Export history session
  const exportHistorySession = useCallback((sessionId: string, title: string) => {
    const exportData = JSON.stringify({ sessionId, title });
    sendBridgeEvent('export_session', exportData);
  }, []);

  // Toggle favorite status
  const toggleFavoriteSession = useCallback((sessionId: string) => {
    // Send favorite toggle request to backend
    sendBridgeEvent('toggle_favorite', sessionId);

    // Immediately update frontend state
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.map(session => {
        if (session.sessionId === sessionId) {
          const isFavorited = !session.isFavorited;
          return {
            ...session,
            isFavorited,
            favoritedAt: isFavorited ? Date.now() : undefined
          };
        }
        return session;
      });

      setHistoryData({
        ...historyData,
        sessions: updatedSessions
      });

      // Show toast
      const session = historyData.sessions.find(s => s.sessionId === sessionId);
      if (session?.isFavorited) {
        addToast(t('history.unfavorited'), 'success');
      } else {
        addToast(t('history.favorited'), 'success');
      }
    }
  }, [historyData, setHistoryData, addToast, t]);

  // Update session title
  const updateHistoryTitle = useCallback((sessionId: string, newTitle: string) => {
    // Send update title request to backend
    const updateData = JSON.stringify({ sessionId, customTitle: newTitle });
    sendBridgeEvent('update_title', updateData);

    // Immediately update frontend state
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.map(session => {
        if (session.sessionId === sessionId) {
          return {
            ...session,
            title: newTitle
          };
        }
        return session;
      });

      setHistoryData({
        ...historyData,
        sessions: updatedSessions
      });

      // Show success toast
      addToast(t('history.titleUpdated'), 'success');
    }
  }, [historyData, setHistoryData, addToast, t]);

  return {
    showNewSessionConfirm,
    showInterruptConfirm,
    suppressNextStatusToastRef,
    createNewSession,
    forceCreateNewSession,
    handleConfirmNewSession,
    handleCancelNewSession,
    handleConfirmInterrupt,
    handleCancelInterrupt,
    loadHistorySession,
    deleteHistorySession,
    deleteHistorySessions,
    exportHistorySession,
    toggleFavoriteSession,
    updateHistoryTitle,
  };
}
