import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HistoryData } from '../types';

export interface SessionContextValue {
  currentSessionId: string | null;
  setCurrentSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  customSessionTitle: string | null;
  setCustomSessionTitle: React.Dispatch<React.SetStateAction<string | null>>;
  historyData: HistoryData | null;
  setHistoryData: React.Dispatch<React.SetStateAction<HistoryData | null>>;
  /** Stale-closure guard: always reflects latest currentSessionId without triggering re-render. */
  currentSessionIdRef: React.RefObject<string | null>;
  /** Stale-closure guard: always reflects latest customSessionTitle without triggering re-render. */
  customSessionTitleRef: React.RefObject<string | null>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Provides session-scoped state (current session id, custom title, history snapshot)
 * plus refs that track latest values for use inside long-lived event handlers.
 *
 * Stage 2 of TASK-P1-01.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [customSessionTitle, setCustomSessionTitle] = useState<string | null>(null);
  const [historyData, setHistoryData] = useState<HistoryData | null>(null);

  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  useEffect(() => { currentSessionIdRef.current = currentSessionId; }, [currentSessionId]);

  const customSessionTitleRef = useRef<string | null>(customSessionTitle);
  useEffect(() => { customSessionTitleRef.current = customSessionTitle; }, [customSessionTitle]);

  const value = useMemo<SessionContextValue>(
    () => ({
      currentSessionId,
      setCurrentSessionId,
      customSessionTitle,
      setCustomSessionTitle,
      historyData,
      setHistoryData,
      currentSessionIdRef,
      customSessionTitleRef,
    }),
    [currentSessionId, customSessionTitle, historyData],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (ctx === null) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}

export { SessionContext };
