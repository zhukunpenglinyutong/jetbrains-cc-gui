import { useEffect } from 'react';
import type { SubagentHistoryResponse, ToolInput, ToolResultBlock } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import { hasSubagentTranscript, type SpawnAgentMeta } from '../../utils/subagentResult';
import {
  useSubagentHistories,
  useSessionId,
  useSessionProvider,
  useGetToolResultRaw,
  useTaskEvent,
} from '../../contexts/SubagentContext';
import { resolveTaskDetails, resolveTaskInputMeta, resolveTaskStatus } from './taskExecutionMeta';

export interface TaskExecutionState {
  isSpawnAgent: boolean;
  isAgentTool: boolean;
  spawnMeta: SpawnAgentMeta;
  identityLabel?: string;
  modelSummary: string;
  shortAgentId?: string;
  descriptionText?: string;
  promptText?: string;
  rest: ToolInput;
  isCompleted: boolean;
  isError: boolean;
  history?: SubagentHistoryResponse;
  detailAgentId?: string;
  detailDurationMs?: number;
  detailTokens?: number;
  detailToolUseCount?: number;
  detailResultText?: string;
  canLoad: boolean;
}

interface UseTaskExecutionStateArgs {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
  expanded: boolean;
}

export function useTaskExecutionState({ name, input, result, toolId, expanded }: UseTaskExecutionStateArgs): TaskExecutionState {
  const histories = useSubagentHistories();
  const currentSessionId = useSessionId();
  const currentProvider = useSessionProvider();
  const getToolResultRaw = useGetToolResultRaw();
  const taskEvent = useTaskEvent(toolId);

  // Compute derived values up front, guarding input, so both useEffects below
  // run before the !input early return (React rules-of-hooks). input is always
  // defined for tool_use blocks in practice; the guard keeps hook order stable.
  const meta = resolveTaskInputMeta({ name, input, result, toolId, getToolResultRaw });
  const { isSpawnAgent, isAgentTool, spawnMeta, identityLabel, modelSummary, shortAgentId } = meta;
  const { historyDescription, descriptionText, promptText, rest } = meta;
  const status = resolveTaskStatus({
    input,
    normalizedName: meta.normalizedName,
    result,
    toolId,
    getToolResultRaw,
    taskEvent,
    histories,
    agentId: meta.agentId,
    agentPath: meta.agentPath,
  });
  const { history, resolvedAgentId, resolvedAgentPath, isCompleted, isError } = status;
  const details = resolveTaskDetails({
    isAsync: status.isAsync,
    taskEvent,
    resolvedAgentId,
    agentToolMeta: meta.agentToolMeta,
    result,
  });

  useEffect(() => {
    if (!input || !expanded || !isAgentTool || !currentSessionId || !toolId || hasSubagentTranscript(history)) return;
    sendBridgeEvent('load_subagent_session', JSON.stringify({
      sessionId: currentSessionId,
      provider: currentProvider,
      agentId: resolvedAgentId,
      agentPath: resolvedAgentPath,
      description: historyDescription,
      toolUseId: toolId,
    }));
  }, [input, currentProvider, currentSessionId, expanded, history, historyDescription, isAgentTool, resolvedAgentId, resolvedAgentPath, toolId]);

  // Poll while an expanded async Agent is unresolved, including after a main
  // turn settles. This lets a reloaded session observe the sidechain's terminal
  // end_turn without relying on the live-only task_notification event. Stop once
  // the agent reaches a terminal state (completed or error) so a failed
  // background agent does not leak an interval forever.
  const shouldPollHistory = expanded
    && isAgentTool
    && Boolean(currentSessionId)
    && Boolean(toolId)
    && !isCompleted
    && !isError;

  useEffect(() => {
    if (!input || !shouldPollHistory || !currentSessionId || !toolId) return;
    const timer = window.setInterval(() => {
      sendBridgeEvent('load_subagent_session', JSON.stringify({
        sessionId: currentSessionId,
        provider: currentProvider,
        agentId: resolvedAgentId,
        agentPath: resolvedAgentPath,
        description: historyDescription,
        toolUseId: toolId,
      }));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [input, currentProvider, currentSessionId, historyDescription, resolvedAgentId, resolvedAgentPath, shouldPollHistory, toolId]);

  return {
    isSpawnAgent,
    isAgentTool,
    spawnMeta,
    identityLabel,
    modelSummary,
    shortAgentId,
    descriptionText,
    promptText,
    rest,
    isCompleted,
    isError,
    history,
    detailAgentId: details.detailAgentId,
    detailDurationMs: details.detailDurationMs,
    detailTokens: details.detailTokens,
    detailToolUseCount: details.detailToolUseCount,
    detailResultText: details.detailResultText,
    canLoad: Boolean(currentSessionId),
  };
}
