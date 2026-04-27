import { createContext, useContext } from 'react';
import type { SubagentHistoryResponse } from '../types';

// Context default values are only used when no matching Provider exists in the
// tree. In this app, <App> always renders the Providers with real state values.

interface SubagentHistoryContextValue {
  subagentHistories: Record<string, SubagentHistoryResponse>;
}

const SubagentHistoryContext = createContext<SubagentHistoryContextValue>({
  subagentHistories: {},
});

interface SessionIdContextValue {
  currentSessionId: string | null;
}

const SessionIdContext = createContext<SessionIdContextValue>({
  currentSessionId: null,
});

/**
 * Hook for reading subagent history data provided via SubagentHistoryContext.
 */
export function useSubagentHistory(): SubagentHistoryContextValue {
  return useContext(SubagentHistoryContext);
}

/**
 * Hook for reading the current session ID provided via SessionIdContext.
 */
export function useSessionId(): SessionIdContextValue {
  return useContext(SessionIdContext);
}

export { SubagentHistoryContext, SessionIdContext };
