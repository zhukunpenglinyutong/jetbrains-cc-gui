import { memo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';
import { normalizeToolName } from '../../utils/toolConstants';
import { sendBridgeEvent } from '../../utils/bridge';
import { useSubagentHistoryGetter, useSessionId, useGetToolResultRaw, type GetToolResultRawFn } from '../../contexts/SubagentContext';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';
import MarkdownBlock from '../MarkdownBlock';

interface AgentGroupBlockProps {
  agentBlock: ClaudeContentBlock;
  followingTextBlocks: ClaudeContentBlock[];
  messageIndex: number;
  isStreaming: boolean;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

function getAgentSummary(block: ClaudeContentBlock): string {
  if (block.type !== 'tool_use') return '';
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return '';
  const desc = input.description ?? input.prompt;
  return typeof desc === 'string' ? desc.slice(0, 120) : '';
}

function getAgentType(block: ClaudeContentBlock): string {
  if (block.type !== 'tool_use') return '';
  const input = block.input as Record<string, unknown> | undefined;
  if (!input) return '';
  const t = input.subagent_type ?? input.subagentType;
  return typeof t === 'string' ? t : '';
}

function extractResultText(result?: ToolResultBlock | null): string | undefined {
  if (!result) return undefined;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .filter((item): item is { type: string; text: string } => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join('\n') || undefined;
  }
  return undefined;
}

function parseAgentToolMeta(
  getToolResultRaw: GetToolResultRawFn,
  toolUseId?: string,
): { agentId?: string; totalDurationMs?: number; totalTokens?: number; totalToolUseCount?: number } {
  if (!toolUseId) return {};
  const rawMessage = getToolResultRaw(toolUseId);
  const metadata = rawMessage?.toolUseResult;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const record = metadata as Record<string, unknown>;
  const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const getNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  return {
    agentId: getString(record.agentId),
    totalDurationMs: getNumber(record.totalDurationMs),
    totalTokens: getNumber(record.totalTokens),
    totalToolUseCount: getNumber(record.totalToolUseCount),
  };
}

const AgentGroupBlock = memo(function AgentGroupBlock({
  agentBlock,
  followingTextBlocks,
  messageIndex,
  isStreaming,
  findToolResult,
}: AgentGroupBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const getSubagentHistory = useSubagentHistoryGetter();
  const currentSessionId = useSessionId();
  const getToolResultRaw = useGetToolResultRaw();

  const toolId = agentBlock.type === 'tool_use' ? agentBlock.id : undefined;
  const input = agentBlock.type === 'tool_use' ? (agentBlock.input as Record<string, unknown> | undefined) : undefined;
  const result = findToolResult(toolId, messageIndex);
  const isCompleted = result !== undefined && result !== null;
  const isError = isCompleted && result?.is_error === true;

  const agentType = getAgentType(agentBlock);
  const summary = getAgentSummary(agentBlock);
  const toolName = agentBlock.type === 'tool_use' ? normalizeToolName(agentBlock.name ?? '') : '';

  const agentToolMeta = parseAgentToolMeta(getToolResultRaw, toolId);
  const agentId = agentToolMeta.agentId ?? (input?.agent_id as string | undefined) ?? (input?.agentId as string | undefined);
  const history = (toolId ? getSubagentHistory(toolId) : undefined) ?? (agentId ? getSubagentHistory(agentId) : undefined);

  useEffect(() => {
    if (!expanded || !currentSessionId || !toolId || history) return;
    sendBridgeEvent('load_subagent_session', JSON.stringify({
      sessionId: currentSessionId,
      agentId,
      description: typeof summary === 'string' ? summary : undefined,
      toolUseId: toolId,
    }));
  }, [agentId, currentSessionId, summary, expanded, history, toolId]);

  useEffect(() => {
    if (!expanded || !currentSessionId || !toolId || !isStreaming || isCompleted || history) return;
    const timer = window.setInterval(() => {
      sendBridgeEvent('load_subagent_session', JSON.stringify({
        sessionId: currentSessionId,
        agentId,
        description: typeof summary === 'string' ? summary : undefined,
        toolUseId: toolId,
      }));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [agentId, currentSessionId, summary, expanded, history, isStreaming, isCompleted, toolId]);

  return (
    <div className="task-container agent-group-container">
      <div
        className={`task-header ${expanded ? 'task-header-expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
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
            <span className="task-summary-text tool-title-summary" title={summary} style={{ fontWeight: 'normal' }}>
              {summary}
            </span>
          )}
        </div>

        <div className="task-header-right">
          <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
          <span className={`codicon ${expanded ? 'codicon-chevron-up' : 'codicon-chevron-down'}`} style={{ fontSize: '12px', color: 'var(--text-tertiary)' }} />
        </div>
      </div>

      {expanded && (
        <div className="task-details agent-group-content">
          <SubagentProcessDetails
            agentId={agentId}
            totalDurationMs={agentToolMeta.totalDurationMs}
            totalTokens={agentToolMeta.totalTokens}
            totalToolUseCount={agentToolMeta.totalToolUseCount}
            resultText={extractResultText(result)}
            history={history}
            canLoad={Boolean(currentSessionId)}
          />
          {followingTextBlocks.map((block, idx) => (
            <div key={idx} className="agent-group-text-block">
              <MarkdownBlock content={block.type === 'text' ? block.text : ''} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export default AgentGroupBlock;
