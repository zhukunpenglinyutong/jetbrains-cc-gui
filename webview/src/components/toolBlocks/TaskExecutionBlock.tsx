import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { normalizeToolName } from '../../utils/toolConstants';
import { sendBridgeEvent } from '../../utils/bridge';
import {
  extractResultText,
  hasSubagentTranscript,
  isAsyncAgentInput,
  parseAgentToolMeta,
  parseSpawnAgentMeta,
  readToolUseStatus,
} from '../../utils/subagentResult';
import {
  useSubagentHistories,
  useSessionId,
  useSessionProvider,
  useGetToolResultRaw,
  useTaskEvent,
} from '../../contexts/SubagentContext';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';

const MONO_FONT_STYLE: React.CSSProperties = {
  fontFamily: "var(--cc-gui-code-font-family, var(--idea-editor-font-family, 'JetBrains Mono', 'Consolas', monospace))",
};
const NORMAL_WEIGHT_STYLE: React.CSSProperties = { fontWeight: 'normal' };

interface TaskExecutionBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  toolId?: string;
  isStreaming?: boolean;
}

function shortenAgentId(agentId?: string): string | undefined {
  if (!agentId) return undefined;
  return agentId.length > 8 ? `${agentId.slice(0, 8)}…` : agentId;
}

const TaskExecutionBlock = memo(function TaskExecutionBlock({ name, input, result, toolId }: TaskExecutionBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const histories = useSubagentHistories();
  const currentSessionId = useSessionId();
  const currentProvider = useSessionProvider();
  const getToolResultRaw = useGetToolResultRaw();
  const taskEvent = useTaskEvent(toolId);

  // Compute derived values up front, guarding input, so both useEffects below
  // run before the !input early return (React rules-of-hooks). input is always
  // defined for tool_use blocks in practice; the guard keeps hook order stable.
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
  const spawnMeta = isSpawnAgent && input
    ? parseSpawnAgentMeta(input as Record<string, unknown>, result)
    : {};
  const agentToolMeta = !isSpawnAgent && input ? parseAgentToolMeta(getToolResultRaw, toolId) : {};
  const agentId = spawnMeta.agentId ?? agentToolMeta.agentId;
  const agentPath = spawnMeta.agentPath;
  const identityLabel = spawnMeta.identityLabel
    ?? (typeof subagentType === 'string' && subagentType ? subagentType : undefined);
  const modelSummary = [spawnMeta.model, spawnMeta.reasoningEffort].filter(Boolean).join(' ');
  const shortAgentId = shortenAgentId(agentId);
  const historyDescription = isSpawnAgent
    ? spawnMeta.description
    : typeof description === 'string' ? description : undefined;

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
  const taskFailed = taskEvent?.status === 'failed' || taskEvent?.status === 'stopped';
  // Async completion has two authoritative sources: the live task_notification,
  // and (after reload/polling) a sidechain transcript that ends in
  // assistant/end_turn. A settled main turn alone proves only that the launch
  // turn ended; the background sidechain may still be running.
  const history = (toolId ? histories[toolId] : undefined) ?? (agentId ? histories[agentId] : undefined);
  const resolvedAgentId = history?.agentId ?? agentId;
  const resolvedAgentPath = history?.agentPath ?? agentPath;
  const historyFailed = history?.status === 'error';
  const isCompleted = isAsync
    ? (taskEvent ? !taskFailed : history?.completed === true)
    : hasTerminalResult;
  const isError = isAsync
    ? (taskEvent ? taskFailed : historyFailed || result?.is_error === true)
    : hasTerminalResult && result?.is_error === true;

  // For background agents the task_notification carries the authoritative usage
  // and summary (the launch ack has none); prefer it over toolUseResult. Sync
  // agents keep reading toolUseResult as before.
  const detailAgentId = (isAsync ? taskEvent?.agentId : undefined) ?? resolvedAgentId;
  const detailDurationMs = (isAsync ? taskEvent?.totalDurationMs : undefined) ?? agentToolMeta.totalDurationMs;
  const detailTokens = (isAsync ? taskEvent?.totalTokens : undefined) ?? agentToolMeta.totalTokens;
  const detailToolUseCount = (isAsync ? taskEvent?.totalToolUseCount : undefined) ?? agentToolMeta.totalToolUseCount;
  const detailResultText = (isAsync ? taskEvent?.summary : undefined) ?? extractResultText(result);

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

  if (!input) {
    return null;
  }

  return (
    <div className="task-container">
      <div
        className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="task-title-section">
          <span className="codicon codicon-tools tool-title-icon" />

          <span className="tool-title-text">
            {name ?? t('tools.task')}
          </span>
          {identityLabel && (
            <span className="tool-title-summary">{identityLabel}</span>
          )}
          {modelSummary && (
            <span className="tool-title-summary">· {modelSummary}</span>
          )}
          {shortAgentId && (
            <span className="tool-title-summary" style={MONO_FONT_STYLE}>
              · {shortAgentId}
            </span>
          )}

          {!isSpawnAgent && typeof description === 'string' && (
            <span className="task-summary-text tool-title-summary" title={description} style={NORMAL_WEIGHT_STYLE}>
              {description}
            </span>
          )}
        </div>

        <div className="task-header-right">
          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
        </div>
      </div>

      {expanded && (
        <div className="task-details">
          <div className="task-content-wrapper">
            {spawnMeta.nickname && (
              <div className="task-field">
                <div className="task-field-label">nickname</div>
                <div className="task-field-content">{spawnMeta.nickname}</div>
              </div>
            )}

            {spawnMeta.model && (
              <div className="task-field">
                <div className="task-field-label">model</div>
                <div className="task-field-content">{spawnMeta.model}</div>
              </div>
            )}

            {spawnMeta.reasoningEffort && (
              <div className="task-field">
                <div className="task-field-label">reasoning_effort</div>
                <div className="task-field-content">{spawnMeta.reasoningEffort}</div>
              </div>
            )}

            {spawnMeta.agentId && (
              <div className="task-field">
                <div className="task-field-label">agent_id</div>
                <div className="task-field-content">{spawnMeta.agentId}</div>
              </div>
            )}

            {isAgentTool && (
              <SubagentProcessDetails
                agentId={detailAgentId}
                totalDurationMs={detailDurationMs}
                totalTokens={detailTokens}
                totalToolUseCount={detailToolUseCount}
                resultText={detailResultText}
                prompt={!isSpawnAgent && typeof prompt === 'string' ? prompt : undefined}
                history={history}
                canLoad={Boolean(currentSessionId)}
              />
            )}

            {!isSpawnAgent && typeof prompt === 'string' && (
              <div className="task-field">
                <div className="task-field-label">
                  <span className="codicon codicon-comment" />
                  {t('tools.promptLabel')}
                </div>
                <div className="task-field-content">{prompt}</div>
              </div>
            )}

            {Object.entries(rest)
              .filter(([key]) => !isSpawnAgent || !['message', 'items', 'task_name', 'taskName'].includes(key))
              .map(([key, value]) => (
              <div key={key} className="task-field">
                <div className="task-field-label">{key}</div>
                <div className="task-field-content">
                  {typeof value === 'object' && value !== null
                    ? JSON.stringify(value, null, 2)
                    : String(value)}
                </div>
              </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
});

export default TaskExecutionBlock;
