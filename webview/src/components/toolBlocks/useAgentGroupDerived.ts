import type { ClaudeContentBlock, ToolResultBlock, TaskEvent, SubagentHistoryResponse } from '../../types';
import { normalizeToolName } from '../../utils/toolConstants';
import {
  isAsyncAgentInput,
  parseAgentToolMeta,
  readToolUseStatus,
} from '../../utils/subagentResult';
import {
  useSubagentHistories,
  useGetToolResultRaw,
  useTaskEvent,
} from '../../contexts/SubagentContext';
import {
  resolveAgentHistory,
  resolveAgentIdentity,
  resolveAgentTerminalState,
} from './agentGroupDerivedHelpers';

export interface AgentGroupDerived {
  toolId: string | undefined;
  input: Record<string, unknown> | undefined;
  result: ToolResultBlock | null | undefined;
  toolName: string;
  isAsync: boolean;
  taskEvent: TaskEvent | undefined;
  agentToolMeta: { agentId?: string; totalDurationMs?: number; totalTokens?: number; totalToolUseCount?: number };
  agentType: string;
  summary: string;
  history: SubagentHistoryResponse | undefined;
  resolvedAgentId: string | undefined;
  resolvedAgentPath: string | undefined;
  isCompleted: boolean;
  isError: boolean;
}

export function useAgentGroupDerived(
  agentBlock: ClaudeContentBlock,
  messageIndex: number,
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined,
): AgentGroupDerived {
  const histories = useSubagentHistories();
  const getToolResultRaw = useGetToolResultRaw();

  const toolId = agentBlock.type === 'tool_use' ? agentBlock.id : undefined;
  const input = agentBlock.type === 'tool_use' ? (agentBlock.input as Record<string, unknown> | undefined) : undefined;
  const result = findToolResult(toolId, messageIndex);
  const hasTerminalResult = result !== undefined && result !== null;
  const toolName = agentBlock.type === 'tool_use' ? normalizeToolName(agentBlock.name ?? '') : '';

  // A background (run_in_background) Agent only gets a launch acknowledgment
  // tool_result; its real terminal status arrives later via task_notification,
  // so stay "running" until that event lands. Sync agents complete inline.
  // isAsyncAgentInput centralizes the strict === true check (and the snake/camel
  // guard) shared with useSubagents and TaskExecutionBlock. The launch ack text
  // and tool-use status are passed as fallbacks so an agent spawned without
  // run_in_background is still recognized as async.
  const isAsync = isAsyncAgentInput(input, toolName, result, readToolUseStatus(toolId ? getToolResultRaw(toolId) : null));
  const taskEvent = useTaskEvent(toolId);
  const agentToolMeta = parseAgentToolMeta(getToolResultRaw, toolId);
  const { agentType, summary, agentId, agentPath } = resolveAgentIdentity({
    toolName,
    input,
    result,
    agentBlock,
    agentToolMeta,
  });
  const { history, resolvedAgentId, resolvedAgentPath } = resolveAgentHistory(
    histories,
    toolId,
    agentId,
    agentPath,
  );
  const { isCompleted, isError } = resolveAgentTerminalState({
    isAsync,
    taskEvent,
    history,
    hasTerminalResult,
    result,
  });

  return {
    toolId,
    input,
    result,
    toolName,
    isAsync,
    taskEvent,
    agentToolMeta,
    agentType,
    summary,
    history,
    resolvedAgentId,
    resolvedAgentPath,
    isCompleted,
    isError,
  };
}
