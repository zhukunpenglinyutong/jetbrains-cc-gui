import type { TodoItem, FileChangeSummary, SubagentInfo, SubagentHistoryResponse } from '../../types';

export type TabType = 'todo' | 'subagent' | 'files';

export interface StatusPanelProps {
  todos: TodoItem[];
  fileChanges: FileChangeSummary[];
  subagents: SubagentInfo[];
  subagentHistories?: Record<string, SubagentHistoryResponse>;
  currentSessionId?: string | null;
  /** Whether the panel is expanded */
  expanded?: boolean;
  /** Whether the conversation is currently streaming (active) */
  isStreaming?: boolean;
  /** Whether any session-level subagent scope is still pending */
  hasPendingSubagent?: boolean;
  /** Callback when file operations are successfully processed */
  onUndoFile?: (filePath: string, operations?: FileChangeSummary['operations']) => void;
  /** Callback when user clicks Keep All (accept changes as new baseline) */
  onKeepAll?: () => void;
  /** Register a pending diff/apply/reject request and return its request id */
  onRegisterFileChangeAction?: (fileChange: FileChangeSummary) => string;
  /** Clear a pending diff/apply/reject request when bridge dispatch fails */
  onClearFileChangeAction?: (requestId?: string) => void;
}

export const statusClassMap: Record<TodoItem['status'], string> = {
  pending: 'status-pending',
  in_progress: 'status-in-progress',
  completed: 'status-completed',
};

export const statusIconMap: Record<TodoItem['status'], string> = {
  pending: 'codicon-circle-outline',
  in_progress: 'codicon-loading',
  completed: 'codicon-check',
};

export const subagentStatusIconMap: Record<SubagentInfo['status'], string> = {
  running: 'codicon-loading',
  completed: 'codicon-check',
  error: 'codicon-error',
};
