import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HistorySessionSummary } from '../../types';

export const useHistorySelection = (sessions: HistorySessionSummary[], onDeleteSessions: (sessionIds: string[]) => void) => {
  const deletableSessions = useMemo(() => sessions.filter(session => !session.running), [sessions]);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);

  const selectedCount = deletableSessions.filter(session => selectedSessionIds.has(session.sessionId)).length;
  const allVisibleSelected = deletableSessions.length > 0 && deletableSessions.every(session => selectedSessionIds.has(session.sessionId));

  useEffect(() => {
    setSelectedSessionIds(prev => {
      if (prev.size === 0) {
        return prev;
      }

      const visibleSessionIds = new Set(deletableSessions.map(session => session.sessionId));
      const next = new Set(Array.from(prev).filter(sessionId => visibleSessionIds.has(sessionId)));
      return next.size === prev.size ? prev : next;
    });
  }, [deletableSessions]);

  const enterSelectionMode = useCallback(() => {
    setIsSelectionMode(true);
  }, []);

  const exitSelectionMode = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedSessionIds(new Set());
    setIsDeletingSelected(false);
  }, []);

  const toggleSessionSelection = useCallback((sessionId: string) => {
    if (!deletableSessions.some(session => session.sessionId === sessionId)) return;
    setSelectedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, [deletableSessions]);

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedSessionIds(prev => {
      if (deletableSessions.length > 0 && deletableSessions.every(session => prev.has(session.sessionId))) {
        return new Set();
      }
      return new Set(deletableSessions.map(session => session.sessionId));
    });
  }, [deletableSessions]);

  const confirmDeleteSelected = useCallback(() => {
    const ids = deletableSessions.filter(session => selectedSessionIds.has(session.sessionId)).map(session => session.sessionId);
    if (ids.length === 0) {
      setIsDeletingSelected(false);
      return;
    }

    onDeleteSessions(ids);
    exitSelectionMode();
  }, [selectedSessionIds, deletableSessions, onDeleteSessions, exitSelectionMode]);

  const startDeleteSelected = useCallback(() => {
    setIsDeletingSelected(true);
  }, []);

  const cancelDeleteSelected = useCallback(() => {
    setIsDeletingSelected(false);
  }, []);

  return {
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
  };
};
