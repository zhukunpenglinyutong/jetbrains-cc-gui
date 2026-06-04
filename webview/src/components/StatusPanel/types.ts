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
  /** Callback when a file is successfully undone */
  onUndoFile?: (filePath: string) => void;
  /** Callback when all files are successfully discarded */
  onDiscardAll?: () => void;
  /** Callback when user clicks Keep All (accept changes as new baseline) */
  onKeepAll?: () => void;
}

export const statusClassMap: Record<TodoItem['status'], string> = {
  pending: 'status-pending',
  in_progress: 'status-in-progress',
  completed: 'status-completed',
};

// Icon type identifiers for SVG icons (replacing codicon class names)
export const statusIconTypeMap: Record<TodoItem['status'], string> = {
  pending: 'circle',
  in_progress: 'spinner',
  completed: 'check',
};

export const subagentStatusIconTypeMap: Record<SubagentInfo['status'], string> = {
  running: 'robot',
  completed: 'check-circle',
  error: 'x-circle',
};
