export type ClaudeRole = 'user' | 'assistant' | 'error' | 'task_notification' | 'notification' | string;

export type ToolInput = Record<string, unknown>;

export type ClaudeContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: ToolInput }
  | { type: 'image'; src?: string; mediaType?: string; alt?: string }
  | { type: 'attachment'; fileName?: string; mediaType?: string }
  | { type: 'task_notification'; icon: string; summary: string; status: string };

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
  [key: string]: unknown;
}

export type ClaudeContentOrResultBlock = ClaudeContentBlock | ToolResultBlock;

export interface ClaudeRawMessage {
  content?: string | ClaudeContentOrResultBlock[];
  message?: { content?: string | ClaudeContentOrResultBlock[] };
  type?: string;
  /** Origin indicates message source - used to filter synthetic messages */
  origin?: { kind: string };
  isMeta?: boolean;
  toolUseResult?: unknown;
  isCompactSummary?: boolean;
  [key: string]: unknown;
}

/** Represents a single message in the chat conversation. */
export interface ClaudeMessage {
  type: ClaudeRole;
  content?: string;
  raw?: ClaudeRawMessage | string;
  timestamp?: string;
  isStreaming?: boolean;
  isOptimistic?: boolean;
  /**
   * Runtime-only: numeric turn identifier for streaming assistant isolation.
   * Set by frontend during streaming to distinguish messages from different
   * conversation turns. Messages with different __turnId values should never
   * be merged. Undefined for history messages loaded from JSONL files.
   */
  __turnId?: number;
  [key: string]: unknown;
}

export interface TodoItem {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface HistorySessionSummary {
  sessionId: string;
  title: string;
  messageCount: number;
  lastTimestamp?: string;
  isFavorited?: boolean;
  favoritedAt?: number;
  provider?: string; // 'claude' or 'codex'
  fileSize?: number;
}

export interface HistoryData {
  success: boolean;
  error?: string;
  sessions?: HistorySessionSummary[];
  total?: number;
  favorites?: Record<string, { favoritedAt: number }>;
}

// File changes types
export type { FileChangeStatus, EditOperation, FileChangeSummary } from './fileChanges';

// Subagent types
export type { SubagentStatus, SubagentInfo, SubagentHistoryResponse } from './subagent';
