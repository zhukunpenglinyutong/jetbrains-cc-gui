import { useCallback, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, HistoryData } from '../types';
import { sendBridgeEvent } from '../utils/bridge';

type ViewMode = 'chat' | 'history' | 'settings';

type ToastType = 'info' | 'success' | 'warning' | 'error';

interface UseSessionManagementOptions {
  messages: ClaudeMessage[];
  loading: boolean;
  historyData: HistoryData | null;
  currentSessionId: string | null;
  setHistoryData: (data: HistoryData | null) => void;
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setCurrentView: (view: ViewMode) => void;
  setCurrentSessionId: (id: string | null) => void;
  setUsagePercentage: (percent: number) => void;
  setUsageUsedTokens: (tokens: number | undefined) => void;
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
  setUsagePercentage,
  setUsageUsedTokens,
  addToast,
  t,
}: UseSessionManagementOptions): UseSessionManagementReturn {
  const [showNewSessionConfirm, setShowNewSessionConfirm] = useState(false);
  const [showInterruptConfirm, setShowInterruptConfirm] = useState(false);
  const pendingActionRef = useRef<'newSession' | null>(null);
  const suppressNextStatusToastRef = useRef(false);

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
      sendBridgeEvent('create_new_session');
    }
  }, [messages.length, loading]);

  // Force create new session (no confirmation, used by /clear /new /reset commands)
  const forceCreateNewSession = useCallback(() => {
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }
    // 设置过渡标志，防止后端旧会话回调通过 updateMessages 写回旧消息
    window.__sessionTransitioning = true;
    setMessages([]);
    sendBridgeEvent('create_new_session');
  }, [setMessages, loading]);

  // Confirm new session
  const handleConfirmNewSession = useCallback(() => {
    setShowNewSessionConfirm(false);
    // [FIX] Safety check: if loading started while dialog was open, send interrupt first
    if (loading) {
      sendBridgeEvent('interrupt_session');
    }
    // Clear current messages and create new session
    setMessages([]);
    sendBridgeEvent('create_new_session');
    pendingActionRef.current = null;
  }, [setMessages, loading]);

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
    setMessages([]);
    sendBridgeEvent('create_new_session');
    pendingActionRef.current = null;
  }, [setMessages]);

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
    sendBridgeEvent('load_session', sessionId);
    setCurrentSessionId(sessionId);
    setCurrentView('chat');
  }, [loading, setCurrentSessionId, setCurrentView]);

  // Delete history session
  const deleteHistorySession = useCallback((sessionId: string) => {
    // Send delete request to Java backend
    sendBridgeEvent('delete_session', sessionId);

    // Immediately update frontend state, remove session from history list
    if (historyData && historyData.sessions) {
      const updatedSessions = historyData.sessions.filter(s => s.sessionId !== sessionId);
      const deletedSession = historyData.sessions.find(s => s.sessionId === sessionId);
      const updatedTotal = (historyData.total || 0) - (deletedSession?.messageCount || 0);

      setHistoryData({
        ...historyData,
        sessions: updatedSessions,
        total: updatedTotal
      });

      // If deleted session is current session, clear messages and reset state
      if (sessionId === currentSessionId) {
        // [FIX] Send interrupt signal if AI is responding
        if (loading) {
          sendBridgeEvent('interrupt_session');
        }
        setMessages([]);
        setCurrentSessionId(null);
        setUsagePercentage(0);
        setUsageUsedTokens(0);
        // Set flag to suppress next updateStatus toast
        suppressNextStatusToastRef.current = true;
        sendBridgeEvent('create_new_session');
      }

      // Show success toast
      addToast(t('history.sessionDeleted'), 'success');
    }
  }, [historyData, currentSessionId, loading, setHistoryData, setMessages, setCurrentSessionId, setUsagePercentage, setUsageUsedTokens, addToast, t]);

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
    exportHistorySession,
    toggleFavoriteSession,
    updateHistoryTitle,
  };
}
