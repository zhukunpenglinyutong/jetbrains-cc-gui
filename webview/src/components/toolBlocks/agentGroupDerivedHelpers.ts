import type { ClaudeContentBlock, ToolResultBlock, TaskEvent, SubagentHistoryResponse } from '../../types';
import { parseSpawnAgentMeta } from '../../utils/subagentResult';

// Constants extracted from magic numbers
const MAX_SUMMARY_LENGTH = 120;

function getAgentSummary(block: ClaudeContentBlock): string {
  if (block.type !== 'tool_use') return '';
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return '';
  const desc = input.description ?? input.prompt;
  return typeof desc === 'string' ? desc.slice(0, MAX_SUMMARY_LENGTH) : '';
}

function getAgentType(block: ClaudeContentBlock): string {
  if (block.type !== 'tool_use') return '';
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return '';
  const t = input.subagent_type ?? input.subagentType;
  return typeof t === 'string' ? t : '';
}

export interface AgentIdentity {
  agentType: string;
  summary: string;
  agentId: string | undefined;
  agentPath: string | undefined;
}

/**
 * Resolve display identity + ids from the launch metadata. Codex spawn_agent
 * blocks parse identity from the tool_result JSON; regular Agent/Task blocks
 * read it from the tool_use input.
 */
export function resolveAgentIdentity(args: {
  toolName: string;
  input: Record<string, unknown> | undefined;
  result: ToolResultBlock | null | undefined;
  agentBlock: ClaudeContentBlock;
  agentToolMeta: { agentId?: string };
}): AgentIdentity {
  const { toolName, input, result, agentBlock, agentToolMeta } = args;
  const spawnMeta = toolName === 'spawn_agent' ? parseSpawnAgentMeta(input ?? {}, result) : {};
  const agentType = toolName === 'spawn_agent' ? spawnMeta.identityLabel ?? '' : getAgentType(agentBlock);
  const summary = toolName === 'spawn_agent'
    ? spawnMeta.description?.slice(0, MAX_SUMMARY_LENGTH) ?? ''
    : getAgentSummary(agentBlock);
  const agentId = spawnMeta.agentId
    ?? agentToolMeta.agentId
    ?? (input?.agent_id as string | undefined)
    ?? (input?.agentId as string | undefined);
  return { agentType, summary, agentId, agentPath: spawnMeta.agentPath };
}

/** Look up the sidechain history by toolUseId first, then by resolved agent id. */
export function resolveAgentHistory(
  histories: Record<string, SubagentHistoryResponse>,
  toolId: string | undefined,
  agentId: string | undefined,
  agentPath: string | undefined,
): {
  history: SubagentHistoryResponse | undefined;
  resolvedAgentId: string | undefined;
  resolvedAgentPath: string | undefined;
} {
  const history = (toolId ? histories[toolId] : undefined) ?? (agentId ? histories[agentId] : undefined);
  return {
    history,
    resolvedAgentId: history?.agentId ?? agentId,
    resolvedAgentPath: history?.agentPath ?? agentPath,
  };
}

// A settled main turn is only the launch boundary for a background Agent. Use
// the live task_notification or a terminal sidechain end_turn as completion.
// A failed launch (validation error before the task was registered) returns an
// is_error tool_result and never emits a task_notification, so treat that as
// an error instead of staying stuck on "running".
export function resolveAgentTerminalState(args: {
  isAsync: boolean;
  taskEvent: TaskEvent | undefined;
  history: SubagentHistoryResponse | undefined;
  hasTerminalResult: boolean;
  result: ToolResultBlock | null | undefined;
}): { isCompleted: boolean; isError: boolean } {
  const { isAsync, taskEvent, history, hasTerminalResult, result } = args;
  if (!isAsync) {
    return {
      isCompleted: hasTerminalResult,
      isError: hasTerminalResult && result?.is_error === true,
    };
  }
  const taskFailed = taskEvent?.status === 'failed' || taskEvent?.status === 'stopped';
  if (taskEvent) {
    return { isCompleted: !taskFailed, isError: taskFailed };
  }
  const historyFailed = history?.status === 'error';
  return {
    isCompleted: history?.completed === true,
    isError: historyFailed || result?.is_error === true,
  };
}
