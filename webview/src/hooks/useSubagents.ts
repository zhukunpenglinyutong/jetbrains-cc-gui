import { useMemo } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, ClaudeContentBlock, ToolResultBlock, SubagentHistoryResponse, SubagentInfo, SubagentStatus, TaskEvent, TaskEventMap } from '../types';
import { normalizeToolInput } from '../utils/toolInputNormalization';
import { normalizeToolName } from '../utils/toolConstants';
import {
  extractAgentResultText,
  isAsyncAgentInput,
  isSpawnAgentArgumentFailureNoise,
  parseSpawnAgentMeta,
  readToolUseStatus,
  isSubagentHistoryCurrent,
} from '../utils/subagentResult';
import { useTaskEvents } from '../contexts/SubagentContext';

type GetToolResultRawFn = (toolUseId: string) => ClaudeRawMessage | null;

interface UseSubagentsParams {
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
  getToolResultRaw: GetToolResultRawFn;
  subagentHistories?: Record<string, SubagentHistoryResponse>;
}

/**
 * Determine subagent status.
 *
 * Async agents (Agent/Task tool invoked with run_in_background:true) only
 * receive a launch acknowledgment tool_result, not a completion signal. The
 * terminal status arrives later via a task_notification event, so while no
 * event has landed the agent is still running.
 *
 * Sync agents (task/agent without run_in_background) run inline: a tool_result
 * means the agent is done.
 */
function determineStatus(
  result: ToolResultBlock | null,
  isAsync: boolean,
  taskEvent: TaskEvent | undefined,
): SubagentStatus {
  if (isAsync) {
    if (taskEvent) {
      return taskEvent.status === 'failed' || taskEvent.status === 'stopped' ? 'error' : 'completed';
    }
    // A failed launch (validation error before the background task was
    // registered) returns an is_error tool_result and never emits a
    // task_notification - surface it as an error instead of staying stuck on
    // "running" forever.
    if (result?.is_error) {
      return 'error';
    }
    return 'running';
  }
  if (!result) {
    return 'running';
  }
  if (result.is_error) {
    return 'error';
  }
  return 'completed';
}

function extractResultMetadata(
  result: ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  toolUseId: string,
  taskEvent: TaskEvent | undefined,
  toolName?: string,
): Partial<SubagentInfo> {
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  const record = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;

  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const toolStats = record?.toolStats && typeof record.toolStats === 'object' && !Array.isArray(record.toolStats)
    ? Object.fromEntries(
      Object.entries(record.toolStats as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
    )
    : undefined;

  // task_notification wins over toolUseResult: for async agents the launch
  // tool_result carries no usage, so the event is the only source of truth.
  return {
    agentId: taskEvent?.agentId ?? getString(record?.agentId),
    totalDurationMs: taskEvent?.totalDurationMs ?? getNumber(record?.totalDurationMs),
    totalTokens: taskEvent?.totalTokens ?? getNumber(record?.totalTokens),
    totalToolUseCount: taskEvent?.totalToolUseCount ?? getNumber(record?.totalToolUseCount),
    toolStats,
    resultText: taskEvent?.summary ?? extractAgentResultText(result, toolName),
  };
}

export function extractSubagentsFromMessages(
  messages: ClaudeMessage[],
  getContentBlocks: (message: ClaudeMessage) => ClaudeContentBlock[],
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null,
  getToolResultRaw: GetToolResultRawFn,
  taskEvents: TaskEventMap = {},
): SubagentInfo[] {
  const subagents: SubagentInfo[] = [];
  const nativeStates = new Map<string, { status?: string; resultText?: string; agentPath?: string; messageIndex?: number; nativeTaskId?: string }>();
  const followups = new Set(messages.flatMap(message => getContentBlocks(message)
    .filter(block => block.type === 'tool_use' && normalizeToolName(block.name ?? '') === 'followup_task')
    .map(block => block.type === 'tool_use' ? block.id : undefined)));

  messages.forEach((message, messageIndex) => {
    if (message.type !== 'assistant') return;

    const blocks = getContentBlocks(message);

    blocks.forEach((block) => {
      if (block.type !== 'tool_use') return;

      const toolName = normalizeToolName(block.name ?? '');
      const rawInput = block.input as Record<string, unknown> | undefined;
      if (!rawInput) return;
      const nativeType = message.raw && typeof message.raw === 'object' ? message.raw.codexItemType : undefined;
      if (nativeType === 'collabAgentToolCall' || nativeType === 'collab_agent_tool_call') {
        const states = rawInput.agentsStates;
        if (states && typeof states === 'object' && !Array.isArray(states)) {
          for (const [agentId, state] of Object.entries(states)) {
            if (state && typeof state === 'object' && typeof state.status === 'string') nativeStates.set(agentId, {
              ...nativeStates.get(agentId), status: state.status,
              resultText: typeof state.message === 'string' ? state.message : undefined,
            });
          }
        }
      }
      if (nativeType === 'subAgentActivity' || nativeType === 'SubAgentActivity' || nativeType === 'sub_agent_activity') {
        const agentId = rawInput.agentThreadId ?? rawInput.agent_thread_id;
        if (typeof agentId === 'string') {
          const previous = nativeStates.get(agentId);
          const callId = rawInput.toolUseId ?? block.id;
          const restartsTask = rawInput.kind === 'interacted' && typeof callId === 'string' && followups.has(callId);
          // Interacted also means a queued message to an idle agent; it carries no running hint.
          const status = rawInput.kind === 'completed' ? 'completed' : rawInput.kind === 'interrupted' ? 'interrupted'
            : restartsTask ? 'pendingInit' : rawInput.kind === 'started' ? 'running' : previous?.status;
          const agentPath = rawInput.agentPath ?? rawInput.agent_path;
          nativeStates.set(agentId, { ...previous, status,
            ...(restartsTask ? { nativeTaskId: callId as string, resultText: undefined } : {}),
            ...(typeof agentPath === 'string' ? { agentPath } : {}),
            messageIndex: previous?.messageIndex ?? messageIndex,
          });
        }
      }

      // Only process task/agent-style subagent tool calls.
      if (toolName !== 'task' && toolName !== 'agent' && toolName !== 'spawn_agent') return;

      const input = normalizeToolInput(block.name, rawInput) as Record<string, unknown> | undefined;
      if (!input) return;

      const id = String(block.id ?? `task-${messageIndex}-${subagents.length}`);
      const toolUseId = block.id ?? '';
      const result = findToolResult(toolUseId, messageIndex);
      if (toolName === 'spawn_agent' && isSpawnAgentArgumentFailureNoise(rawInput, result)) return;

      const taskEvent = taskEvents[toolUseId];
      // isAsync is read via the shared isAsyncAgentInput helper so the
      // StatusPanel list and the inline Agent cards stay in lockstep. The
      // launch ack text and tool-use status are passed as fallbacks so a
      // background agent whose input lacks run_in_background is still kept
      // "running" until its terminal event lands, instead of being marked
      // completed the instant the ack arrives.
      const toolUseStatus = readToolUseStatus(getToolResultRaw(toolUseId));
      const isAsync = isAsyncAgentInput(input, toolName, result, toolUseStatus);
      const status = determineStatus(result, isAsync, taskEvent);
      const resultMetadata = extractResultMetadata(result, getToolResultRaw, toolUseId, taskEvent, toolName);
      const spawnMeta = toolName === 'spawn_agent' ? parseSpawnAgentMeta(rawInput, result) : {};
      // Codex message may be opaque transport data. Only expose explicit,
      // human-readable spawn metadata in the StatusPanel.
      const subagentType = toolName === 'spawn_agent'
        ? spawnMeta.identityLabel ?? ''
        : String((input.subagent_type as string) ?? (input.subagentType as string) ?? 'Unknown');
      const description = toolName === 'spawn_agent'
        ? spawnMeta.description ?? ''
        : String((input.description as string) ?? '');
      const prompt = toolName === 'spawn_agent'
        ? spawnMeta.prompt
        : String((input.prompt as string) ?? '');

      const receivers = toolName === 'spawn_agent' && Array.isArray(rawInput.receiverThreadIds)
        ? [...new Set(rawInput.receiverThreadIds.filter((value): value is string => typeof value === 'string' && value.length > 0))] : [];
      const agentIds = receivers.length > 0 ? receivers : [spawnMeta.agentId];
      agentIds.forEach(agentId => subagents.push({
        id: agentIds.length > 1 ? `${id}--${agentId}` : id,
        ...(agentIds.length > 1 ? { toolUseId: id } : {}),
        type: subagentType,
        description,
        prompt,
        status,
        isAsync,
        messageIndex,
        ...resultMetadata,
        ...(agentId && { agentId }),
        ...(spawnMeta.agentPath && { agentPath: spawnMeta.agentPath }),
      }));
    });
  });

  const paths = new Map<string, string[]>();
  for (const [agentId, state] of nativeStates) {
    if (state.agentPath) {
      paths.set(state.agentPath, [...(paths.get(state.agentPath) ?? []), agentId]);
      const shortPath = state.agentPath.split('/').filter(Boolean).at(-1);
      if (shortPath && shortPath !== state.agentPath) paths.set(shortPath, [...(paths.get(shortPath) ?? []), agentId]);
    }
  }
  const linked = subagents.map(subagent => {
    const candidates = subagent.agentPath ? paths.get(subagent.agentPath) : undefined;
    const agentId = subagent.agentId ?? (candidates?.length === 1 ? candidates[0] : undefined);
    return agentId ? { ...subagent, agentId } : subagent;
  });
  for (const [agentId, state] of nativeStates) {
    // A history page may start after spawn. Activity still identifies a real child.
    if (state.agentPath && !linked.some(agent => agent.agentId === agentId)) linked.push({
      id: agentId, agentId, agentPath: state.agentPath, type: state.agentPath.split('/').filter(Boolean).at(-1) ?? '',
      description: '', status: 'running', isAsync: true, messageIndex: state.messageIndex ?? 0,
    });
  }
  return linked.map(subagent => {
    const state = subagent.agentId ? nativeStates.get(subagent.agentId) : undefined;
    const status = state?.status === 'completed' ? 'completed'
      : ['errored', 'interrupted', 'shutdown'].includes(state?.status ?? '') ? 'error'
      : ['running', 'pendingInit'].includes(state?.status ?? '') ? 'running' : subagent.status;
    return { ...subagent, status,
      ...(state?.agentPath ? { agentPath: state.agentPath, type: subagent.type || state.agentPath.split('/').filter(Boolean).at(-1) || '' } : {}),
      ...(state?.resultText ? { resultText: state.resultText } : {}),
      ...(state?.nativeTaskId ? { nativeTaskId: state.nativeTaskId } : {}),
    };
  });
}

export function applySubagentHistoryCompletion(
  subagents: SubagentInfo[],
  subagentHistories: Record<string, SubagentHistoryResponse>,
): SubagentInfo[] {
  return subagents.map((subagent) => {
    if (!subagent.isAsync || subagent.status !== 'running') return subagent;
    const history = subagentHistories[subagent.id]
      ?? (subagent.agentId ? subagentHistories[subagent.agentId] : undefined);
    const currentHistory = isSubagentHistoryCurrent(history, subagent.nativeTaskId);
    const priorTerminalTurnId = currentHistory ? history?.nativeTaskPreviousTurnId
      : history?.success === true && (history.completed || history.status === 'completed' || history.status === 'error')
        ? history.latestTurnId : undefined;
    // A running child may consume followup in its current turn; only exclude a proven ended one.
    const currentSubagent = subagent.nativeTaskId
      ? { ...subagent, nativeTaskPreviousTurnId: priorTerminalTurnId ?? undefined } : subagent;
    if (!currentHistory) return currentSubagent;
    // Only an authoritatively-observed failure (the backend read the sidechain
    // and saw the turn abort) may flip the agent to error. Resolution/read
    // failures come back with success === false and must keep polling.
    if (history?.status === 'error' && history.success === true) {
      return { ...currentSubagent, status: 'error' as const };
    }
    return history?.completed ? { ...currentSubagent, status: 'completed' as const } : currentSubagent;
  });
}

/**
 * Hook to extract subagent information from Task tool calls.
 */
export function useSubagents({
  messages,
  getContentBlocks,
  findToolResult,
  getToolResultRaw,
  subagentHistories = {},
}: UseSubagentsParams): SubagentInfo[] {
  const taskEvents = useTaskEvents();
  return useMemo(() => {
    const extracted = extractSubagentsFromMessages(
      messages,
      getContentBlocks,
      findToolResult,
      getToolResultRaw,
      taskEvents,
    );
    return applySubagentHistoryCompletion(extracted, subagentHistories);
  }, [messages, getContentBlocks, findToolResult, getToolResultRaw, taskEvents, subagentHistories]);
}
