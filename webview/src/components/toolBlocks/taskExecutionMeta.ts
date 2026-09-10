import type { SubagentHistoryResponse, TaskEvent, ToolInput, ToolResultBlock } from '../../types';
import { normalizeToolName } from '../../utils/toolConstants';
import {
  extractResultText,
  isAsyncAgentInput,
  parseAgentToolMeta,
  parseSpawnAgentMeta,
  readToolUseStatus,
  type SpawnAgentMeta,
} from '../../utils/subagentResult';
import type { GetToolResultRawFn } from '../../contexts/SubagentContext';

/** Agent-tool usage metadata parsed from the raw tool_use_result. */
export interface AgentToolMeta {
  agentId?: string;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
}

export interface TaskToolMeta {
  spawnMeta: SpawnAgentMeta;
  agentToolMeta: AgentToolMeta;
  agentId?: string;
  agentPath?: string;
}

/** Parse spawn_agent / Agent-tool launch metadata for the tool_use block. */
export function parseTaskToolMeta(args: {
  isSpawnAgent: boolean;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;
  toolId?: string;
}): TaskToolMeta {
  const { isSpawnAgent, input, result, getToolResultRaw, toolId } = args;
  const spawnMeta = isSpawnAgent && input
    ? parseSpawnAgentMeta(input as Record<string, unknown>, result)
    : {};
  const agentToolMeta = !isSpawnAgent && input ? parseAgentToolMeta(getToolResultRaw, toolId) : {};
  return {
    spawnMeta,
    agentToolMeta,
    agentId: spawnMeta.agentId ?? agentToolMeta.agentId,
    agentPath: spawnMeta.agentPath,
  };
}

function shortenAgentId(agentId?: string): string | undefined {
  if (!agentId) return undefined;
  return agentId.length > 8 ? `${agentId.slice(0, 8)}…` : agentId;
}

export interface TaskIdentityMeta {
  identityLabel?: string;
  modelSummary: string;
  shortAgentId?: string;
  historyDescription?: string;
}

/** Resolve the display identity (label, model summary, short id) from parsed meta. */
export function resolveTaskIdentity(args: {
  isSpawnAgent: boolean;
  description: unknown;
  subagentType: unknown;
  spawnMeta: SpawnAgentMeta;
  agentId?: string;
}): TaskIdentityMeta {
  const { isSpawnAgent, description, subagentType, spawnMeta, agentId } = args;
  const identityLabel = spawnMeta.identityLabel
    ?? (typeof subagentType === 'string' && subagentType ? subagentType : undefined);
  const modelSummary = [spawnMeta.model, spawnMeta.reasoningEffort].filter(Boolean).join(' ');
  const historyDescription = isSpawnAgent
    ? spawnMeta.description
    : typeof description === 'string' ? description : undefined;
  return {
    identityLabel,
    modelSummary,
    shortAgentId: shortenAgentId(agentId),
    historyDescription,
  };
}

export interface TaskInputMeta extends TaskIdentityMeta {
  normalizedName: string;
  isSpawnAgent: boolean;
  isAgentTool: boolean;
  spawnMeta: SpawnAgentMeta;
  agentToolMeta: AgentToolMeta;
  agentId?: string;
  agentPath?: string;
  descriptionText?: string;
  promptText?: string;
  rest: ToolInput;
}

/** Derive the tool/input-level metadata shared by the card render and effects. */
export function resolveTaskInputMeta(args: {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
  getToolResultRaw: GetToolResultRawFn;
}): TaskInputMeta {
  const { name, input, result, toolId, getToolResultRaw } = args;
  const normalizedName = input ? normalizeToolName(name ?? '') : '';
  const isSpawnAgent = normalizedName === 'spawn_agent';
  const isAgentTool = normalizedName === 'agent' || normalizedName === 'task' || normalizedName === 'spawn_agent';
  const {
    description,
    prompt,
    subagent_type: subagentType,
    model: _model,
    reasoning_effort: _reasoningEffort,
    reasoningEffort: _reasoningEffortCamel,
    nickname: _nickname,
    name: _inputName,
    agent_id: _agentId,
    agentId: _agentIdCamel,
    agent_path: _agentPath,
    agentPath: _agentPathCamel,
    ...rest
  } = input ?? ({} as ToolInput);
  const { spawnMeta, agentToolMeta, agentId, agentPath } = parseTaskToolMeta({
    isSpawnAgent,
    input,
    result,
    getToolResultRaw,
    toolId,
  });
  const identity = resolveTaskIdentity({ isSpawnAgent, description, subagentType, spawnMeta, agentId });
  return {
    normalizedName,
    isSpawnAgent,
    isAgentTool,
    spawnMeta,
    agentToolMeta,
    agentId,
    agentPath,
    ...identity,
    descriptionText: typeof description === 'string' ? description : undefined,
    promptText: typeof prompt === 'string' ? prompt : undefined,
    rest,
  };
}

export interface TaskOutcome {
  isCompleted: boolean;
  isError: boolean;
}

/** Resolve terminal status from the authoritative sources for async vs sync agents. */
export function resolveTaskOutcome(args: {
  isAsync: boolean;
  taskEvent?: TaskEvent;
  history?: SubagentHistoryResponse;
  result?: ToolResultBlock | null;
  hasTerminalResult: boolean;
}): TaskOutcome {
  const { isAsync, taskEvent, history, result, hasTerminalResult } = args;
  const taskFailed = taskEvent?.status === 'failed' || taskEvent?.status === 'stopped';
  const historyFailed = history?.status === 'error';
  // Async completion has two authoritative sources: the live task_notification,
  // and (after reload/polling) a sidechain transcript that ends in
  // assistant/end_turn. A settled main turn alone proves only that the launch
  // turn ended; the background sidechain may still be running.
  const isCompleted = isAsync
    ? (taskEvent ? !taskFailed : history?.completed === true)
    : hasTerminalResult;
  const isError = isAsync
    ? (taskEvent ? taskFailed : historyFailed || result?.is_error === true)
    : hasTerminalResult && result?.is_error === true;
  return { isCompleted, isError };
}

export interface TaskStatusResolution extends TaskOutcome {
  isAsync: boolean;
  history?: SubagentHistoryResponse;
  resolvedAgentId?: string;
  resolvedAgentPath?: string;
}

/** Resolve the async/sync terminal status and resolved agent identity. */
export function resolveTaskStatus(args: {
  input?: ToolInput;
  normalizedName: string;
  result?: ToolResultBlock | null;
  toolId?: string;
  getToolResultRaw: GetToolResultRawFn;
  taskEvent?: TaskEvent;
  histories: Record<string, SubagentHistoryResponse>;
  agentId?: string;
  agentPath?: string;
}): TaskStatusResolution {
  const {
    input,
    normalizedName,
    result,
    toolId,
    getToolResultRaw,
    taskEvent,
    histories,
    agentId,
    agentPath,
  } = args;
  // A background (run_in_background) Agent only gets a launch acknowledgment
  // tool_result; its real terminal status arrives later via a task_notification
  // event, so the card must stay "running" until that event lands and must not
  // flip to completed on the launch ack alone. Sync agents run inline, so a
  // tool_result means done. A failed launch (validation error before the task
  // was registered) returns an is_error tool_result and never emits a
  // task_notification, so treat that as an error instead of staying stuck.
  // isAsyncAgentInput centralizes the strict === true check shared with
  // useSubagents and AgentGroupBlock. The launch ack text and tool-use status
  // are passed as fallbacks so an agent spawned without run_in_background is
  // still recognized as async.
  const isAsync = input
    ? isAsyncAgentInput(input, normalizedName, result, readToolUseStatus(toolId ? getToolResultRaw(toolId) : null))
    : false;
  const hasTerminalResult = result !== undefined && result !== null;
  const history = (toolId ? histories[toolId] : undefined) ?? (agentId ? histories[agentId] : undefined);
  const { isCompleted, isError } = resolveTaskOutcome({
    isAsync,
    taskEvent,
    history,
    result,
    hasTerminalResult,
  });
  return {
    isAsync,
    history,
    resolvedAgentId: history?.agentId ?? agentId,
    resolvedAgentPath: history?.agentPath ?? agentPath,
    isCompleted,
    isError,
  };
}

export interface TaskDetailResolution {
  detailAgentId?: string;
  detailDurationMs?: number;
  detailTokens?: number;
  detailToolUseCount?: number;
  detailResultText?: string;
}

/** Resolve the detail panel fields (id, usage, summary) for async vs sync agents. */
export function resolveTaskDetails(args: {
  isAsync: boolean;
  taskEvent?: TaskEvent;
  resolvedAgentId?: string;
  agentToolMeta: AgentToolMeta;
  result?: ToolResultBlock | null;
}): TaskDetailResolution {
  const { isAsync, taskEvent, resolvedAgentId, agentToolMeta, result } = args;
  // For background agents the task_notification carries the authoritative usage
  // and summary (the launch ack has none); prefer it over toolUseResult. Sync
  // agents keep reading toolUseResult as before.
  return {
    detailAgentId: (isAsync ? taskEvent?.agentId : undefined) ?? resolvedAgentId,
    detailDurationMs: (isAsync ? taskEvent?.totalDurationMs : undefined) ?? agentToolMeta.totalDurationMs,
    detailTokens: (isAsync ? taskEvent?.totalTokens : undefined) ?? agentToolMeta.totalTokens,
    detailToolUseCount: (isAsync ? taskEvent?.totalToolUseCount : undefined) ?? agentToolMeta.totalToolUseCount,
    detailResultText: (isAsync ? taskEvent?.summary : undefined) ?? extractResultText(result),
  };
}
