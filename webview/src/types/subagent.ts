/**
 * Subagent status
 */
export type SubagentStatus = 'running' | 'completed' | 'error';

/**
 * Subagent information extracted from Task tool calls
 */
export interface SubagentInfo {
  /** Unique identifier (tool_use block id) */
  id: string;
  /** Subagent type (e.g., 'Explore', 'Plan', 'Bash') */
  type: string;
  /** Short description of the task */
  description: string;
  /** Full prompt content */
  prompt?: string;
  /** Execution status */
  status: SubagentStatus;
  /** Message index where this subagent was invoked */
  messageIndex: number;
}
