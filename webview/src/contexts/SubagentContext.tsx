import { createContext, useCallback, useContext, useMemo, useRef } from 'react';
import type { ClaudeRawMessage, SubagentHistoryResponse } from '../types';

// SubagentHistoryContext holds a getter function instead of the full Record.
// This keeps the context value reference stable even when individual entries
// are updated, preventing unnecessary re-renders of TaskExecutionBlock instances
// that don't care about the changed key.
type GetSubagentHistoryFn = (key: string) => SubagentHistoryResponse | undefined;

const SubagentHistoryContext = createContext<GetSubagentHistoryFn>(() => undefined);

interface SessionIdContextValue {
  currentSessionId: string | null;
}

const SessionIdContext = createContext<SessionIdContextValue>({
  currentSessionId: null,
});

export type GetToolResultRawFn = (toolUseId: string) => ClaudeRawMessage | null;

const ToolResultRawContext = createContext<GetToolResultRawFn>(() => null);

/**
 * Hook for looking up a specific subagent's history by key (toolUseId or agentId).
 * Returns a stable getter function — the reference never changes, so consumers
 * won't re-render when *other* subagent histories are updated.
 */
export function useSubagentHistoryGetter(): GetSubagentHistoryFn {
  return useContext(SubagentHistoryContext);
}

/**
 * Hook for reading the current session ID provided via SessionIdContext.
 */
export function useSessionId(): string | null {
  return useContext(SessionIdContext).currentSessionId;
}

/**
 * Hook for looking up the raw message that contains a given tool result.
 */
export function useGetToolResultRaw(): GetToolResultRawFn {
  return useContext(ToolResultRawContext);
}

/**
 * Creates the context value objects used by App.tsx's Providers.
 * Returns stable references that survive re-renders.
 */
export function useSubagentContextValues(subagentHistories: Record<string, SubagentHistoryResponse>, currentSessionId: string | null) {
  const historiesRef = useRef(subagentHistories);
  historiesRef.current = subagentHistories;

  const getHistory = useCallback<GetSubagentHistoryFn>(
    (key: string) => historiesRef.current[key],
    [],
  );

  // getHistory has empty deps so its identity never changes — use it directly
  // as the context value without an unnecessary useMemo wrapper.
  const subagentHistoryCtxValue = getHistory;
  const sessionIdCtxValue = useMemo(() => ({ currentSessionId }), [currentSessionId]);

  return { subagentHistoryCtxValue, sessionIdCtxValue };
}

export { SubagentHistoryContext, SessionIdContext, ToolResultRawContext };
