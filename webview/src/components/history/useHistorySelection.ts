import { useCallback, useEffect, useState } from 'react';
import type { HistorySessionSummary } from '../../types';

export const useHistorySelection = (sessions: HistorySessionSummary[], onDeleteSessions: (sessionIds: string[]) => void) => {
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);

  const selectedCount = selectedSessionIds.size;
  const allVisibleSelected = sessions.length > 0 && sessions.every(session => selectedSessionIds.has(session.sessionId));

  useEffect(() => {
    setSelectedSessionIds(prev => {
      if (prev.size === 0) {
        return prev;
      }

      const visibleSessionIds = new Set(sessions.map(session => session.sessionId));
      const next = new Set(Array.from(prev).filter(sessionId => visibleSessionIds.has(sessionId)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  const enterSelectionMode = useCallback(() => {
    setIsSelectionMode(true);
  }, []);

  const exitSelectionMode = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedSessionIds(new Set());
    setIsDeletingSelected(false);
  }, []);

  const toggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedSessionIds(prev => {
      if (sessions.length > 0 && sessions.every(session => prev.has(session.sessionId))) {
        return new Set();
      }
      return new Set(sessions.map(session => session.sessionId));
    });
  }, [sessions]);

  const confirmDeleteSelected = useCallback(() => {
    if (selectedSessionIds.size === 0) {
      setIsDeletingSelected(false);
      return;
    }

    onDeleteSessions(Array.from(selectedSessionIds));
    exitSelectionMode();
  }, [selectedSessionIds, onDeleteSessions, exitSelectionMode]);

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
