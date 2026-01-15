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
  timestamp?: string;
  isStreaming?: boolean; // 🔧 流式传输：标记消息是否正在流式接收中
  isOptimistic?: boolean; // 🔧 乐观更新：标记消息是否为客户端乐观添加的消息（等待后端确认）
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
  provider?: string; // 'claude' 或 'codex'
}

export interface HistoryData {
  success: boolean;
  error?: string;
  sessions?: HistorySessionSummary[];
  total?: number;
  favorites?: Record<string, { favoritedAt: number }>;
}
