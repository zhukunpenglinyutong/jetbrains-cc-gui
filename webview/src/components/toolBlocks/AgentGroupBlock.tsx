import { memo, useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';
import { normalizeToolName } from '../../utils/toolConstants';
import { sendBridgeEvent } from '../../utils/bridge';
import { getPersistedExpanded, setPersistedExpanded } from '../../utils/expandedState';
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
import { ContentBlockRenderer } from '../MessageItem/ContentBlockRenderer';

// Constants extracted from magic numbers
const MAX_SUMMARY_LENGTH = 120;
const SUBAGENT_POLL_INTERVAL_MS = 2_000;

interface AgentGroupBlockProps {
  agentBlock: ClaudeContentBlock;
  followingBlocks: ClaudeContentBlock[];
  messageIndex: number;
  isStreaming: boolean;
  isLastMessage: boolean;
  isThinking: boolean;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

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

const AgentGroupBlock = memo(function AgentGroupBlock({
  agentBlock,
  followingBlocks,
  messageIndex,
  isStreaming,
  isLastMessage,
  isThinking,
  findToolResult,
}: AgentGroupBlockProps) {
  const { t } = useTranslation();
  const histories = useSubagentHistories();
  const currentSessionId = useSessionId();
  const currentProvider = useSessionProvider();
  const getToolResultRaw = useGetToolResultRaw();

  const toolId = agentBlock.type === 'tool_use' ? agentBlock.id : undefined;
  const stateKey = `agent-group-${toolId ?? messageIndex}`;
  const [expanded, setExpandedRaw] = useState(() => getPersistedExpanded(stateKey));
  const setExpanded = useCallback((updater: (prev: boolean) => boolean) => {
    setExpandedRaw((prev) => {
      const next = updater(prev);
      setPersistedExpanded(stateKey, next);
      return next;
    });
  }, [stateKey]);

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
  const taskFailed = taskEvent?.status === 'failed' || taskEvent?.status === 'stopped';

  const agentToolMeta = parseAgentToolMeta(getToolResultRaw, toolId);
  const spawnMeta = toolName === 'spawn_agent'
    ? parseSpawnAgentMeta(input ?? {}, result)
    : {};
  const agentType = toolName === 'spawn_agent'
    ? spawnMeta.identityLabel ?? ''
    : getAgentType(agentBlock);
  const summary = toolName === 'spawn_agent'
    ? spawnMeta.description?.slice(0, MAX_SUMMARY_LENGTH) ?? ''
    : getAgentSummary(agentBlock);
  const agentId = spawnMeta.agentId
    ?? agentToolMeta.agentId
    ?? (input?.agent_id as string | undefined)
    ?? (input?.agentId as string | undefined);
  const agentPath = spawnMeta.agentPath;
  const history = (toolId ? histories[toolId] : undefined) ?? (agentId ? histories[agentId] : undefined);
  const resolvedAgentId = history?.agentId ?? agentId;
  const resolvedAgentPath = history?.agentPath ?? agentPath;
  const historyFailed = history?.status === 'error';
  // A settled main turn is only the launch boundary for a background Agent. Use
  // the live task_notification or a terminal sidechain end_turn as completion.
  // A failed launch (validation error before the task was registered) returns an
  // is_error tool_result and never emits a task_notification, so treat that as
  // an error instead of staying stuck on "running".
  const isCompleted = isAsync
    ? (taskEvent ? !taskFailed : history?.completed === true)
    : hasTerminalResult;
  const isError = isAsync
    ? (taskEvent ? taskFailed : historyFailed || result?.is_error === true)
    : hasTerminalResult && result?.is_error === true;

  const noopToggleThinking = useCallback(() => {}, []);

  // Use ref to store timer ID and avoid unnecessary timer restarts
  const pollingTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!expanded || !currentSessionId || !toolId || hasSubagentTranscript(history)) return;
    sendBridgeEvent('load_subagent_session', JSON.stringify({
      sessionId: currentSessionId,
      provider: currentProvider,
      agentId: resolvedAgentId,
      agentPath: resolvedAgentPath,
      description: typeof summary === 'string' ? summary : undefined,
      toolUseId: toolId,
    }));
  }, [currentProvider, currentSessionId, summary, expanded, history, resolvedAgentId, resolvedAgentPath, toolId]);

  useEffect(() => {
    // Clear existing timer when dependencies change or conditions no longer met
    if (!expanded || !currentSessionId || !toolId || isCompleted || isError) {
      if (pollingTimerRef.current !== null) {
        window.clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
      return;
    }

    // Only start a new timer if one doesn't exist
    if (pollingTimerRef.current === null) {
      pollingTimerRef.current = window.setInterval(() => {
        sendBridgeEvent('load_subagent_session', JSON.stringify({
          sessionId: currentSessionId,
          provider: currentProvider,
          agentId: resolvedAgentId,
          agentPath: resolvedAgentPath,
          description: typeof summary === 'string' ? summary : undefined,
          toolUseId: toolId,
        }));
      }, SUBAGENT_POLL_INTERVAL_MS);
    }

    return () => {
      if (pollingTimerRef.current !== null) {
        window.clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };
  }, [currentProvider, currentSessionId, summary, expanded, isCompleted, isError, resolvedAgentId, resolvedAgentPath, toolId]);

  return (
    <div className="task-container agent-group-container">
      <div
        className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
        role="button"
        aria-expanded={expanded}
        aria-label={t('tools.agentGroupToggle', 'Toggle agent group details')}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((prev) => !prev);
          }
        }}
      >
        <div className="task-title-section">
          <span className="codicon codicon-type-hierarchy tool-title-icon" />
          <span className="tool-title-text">
            {toolName === 'spawn_agent' ? 'spawn_agent' : t('tools.agent', 'Agent')}
          </span>
          {agentType && (
            <span className="tool-title-summary">{agentType}</span>
          )}
          {summary && (
            <span className="task-summary-text tool-title-summary" title={summary}>
              {summary}
            </span>
          )}
        </div>

        <div className="task-header-right">
          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
          <span className={`codicon agent-group-chevron ${expanded ? 'codicon-chevron-up' : 'codicon-chevron-down'}`} />
        </div>
      </div>

      {expanded && (
        <div className="task-details agent-group-content">
          <SubagentProcessDetails
            agentId={(isAsync ? taskEvent?.agentId : undefined) ?? resolvedAgentId}
            totalDurationMs={(isAsync ? taskEvent?.totalDurationMs : undefined) ?? agentToolMeta.totalDurationMs}
            totalTokens={(isAsync ? taskEvent?.totalTokens : undefined) ?? agentToolMeta.totalTokens}
            totalToolUseCount={(isAsync ? taskEvent?.totalToolUseCount : undefined) ?? agentToolMeta.totalToolUseCount}
            resultText={(isAsync ? taskEvent?.summary : undefined) ?? extractResultText(result)}
            prompt={toolName !== 'spawn_agent' && typeof input?.prompt === 'string' ? input.prompt : undefined}
            history={history}
            canLoad={Boolean(currentSessionId)}
          />
          {followingBlocks.map((block, idx) => {
            // Use block id as stable key; fall back to index for non-tool-use blocks
            const blockKey = (block as { id?: string }).id ?? `${messageIndex}-agent-${idx}`;
            return (
              <div key={blockKey} className="content-block">
                <ContentBlockRenderer
                  block={block}
                  messageIndex={messageIndex}
                  messageType="assistant"
                  isStreaming={isStreaming}
                  isThinkingExpanded={false}
                  isThinking={isThinking}
                  isLastMessage={isLastMessage}
                  isLastBlock={idx === followingBlocks.length - 1}
                  t={t}
                  onToggleThinking={noopToggleThinking}
                  findToolResult={findToolResult}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default AgentGroupBlock;
