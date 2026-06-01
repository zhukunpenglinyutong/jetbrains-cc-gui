import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ClaudeMessage, SubagentHistoryResponse } from '../types';

export const DEFAULT_STATUS = 'ready';
export type QueueDisplayState = 'NONE' | 'QUEUED' | 'PROCESSING' | 'COMPLETED';

export interface MessagesContextValue {
  messages: ClaudeMessage[];
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  subagentHistories: Record<string, SubagentHistoryResponse>;
  setSubagentHistories: React.Dispatch<React.SetStateAction<Record<string, SubagentHistoryResponse>>>;
  status: string;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  loading: boolean;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  loadingStartTime: number | null;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  queueDisplayState: QueueDisplayState;
  setQueueDisplayState: React.Dispatch<React.SetStateAction<QueueDisplayState>>;
  queueAheadCount: number;
  setQueueAheadCount: React.Dispatch<React.SetStateAction<number>>;
  isThinking: boolean;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  streamingActive: boolean;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;
}

const MessagesContext = createContext<MessagesContextValue | null>(null);

/**
 * Provides messages flow state (messages, subagent histories, loading, streaming).
 * Stage 1 of TASK-P1-01 (App.tsx God Component decomposition).
 *
 * Currently only App.tsx consumes this context. As subsequent stages migrate
 * downstream hooks (useWindowCallbacks, useMessageSender, useSessionManagement)
 * to read setters via useMessages() directly, prop drilling will collapse.
 */
export function MessagesProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<ClaudeMessage[]>([]);
  const [subagentHistories, setSubagentHistories] = useState<Record<string, SubagentHistoryResponse>>({});
  const [status, setStatus] = useState<string>(DEFAULT_STATUS);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingStartTime, setLoadingStartTime] = useState<number | null>(null);
  const [queueDisplayState, setQueueDisplayState] = useState<QueueDisplayState>('NONE');
  const [queueAheadCount, setQueueAheadCount] = useState<number>(0);
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [streamingActive, setStreamingActive] = useState<boolean>(false);

  const value = useMemo<MessagesContextValue>(
    () => ({
      messages,
      setMessages,
      subagentHistories,
      setSubagentHistories,
      status,
      setStatus,
      loading,
      setLoading,
      loadingStartTime,
      setLoadingStartTime,
      queueDisplayState,
      setQueueDisplayState,
      queueAheadCount,
      setQueueAheadCount,
      isThinking,
      setIsThinking,
      streamingActive,
      setStreamingActive,
    }),
    [messages, subagentHistories, status, loading, loadingStartTime, queueDisplayState, queueAheadCount, isThinking, streamingActive],
  );

  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

/**
 * Read messages flow state. Must be used within MessagesProvider.
 *
 * Note: this hook returns the full context value. Components that re-render
 * frequently and only need a subset (e.g. only `messages`) should consider
 * splitting into focused selector hooks if profiling shows pressure.
 */
export function useMessages(): MessagesContextValue {
  const ctx = useContext(MessagesContext);
  if (ctx === null) {
    throw new Error('useMessages must be used within a MessagesProvider');
  }
  return ctx;
}

export { MessagesContext };
