export type ClaudeRole = 'user' | 'assistant' | 'error' | string;

export type ToolInput = Record<string, unknown>;

export type ClaudeContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: ToolInput }
  | { type: 'image'; src?: string; mediaType?: string; alt?: string };

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
  [key: string]: unknown;
}

export interface ClaudeMessage {
  type: ClaudeRole;
  content?: string;
  raw?: ClaudeRawMessage | string;
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
}

export interface HistoryData {
  success: boolean;
  error?: string;
  sessions?: HistorySessionSummary[];
  total?: number;
}
