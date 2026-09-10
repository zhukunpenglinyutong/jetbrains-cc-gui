import { memo, useState, useEffect, useCallback, useRef } from 'react';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';
import { sendBridgeEvent } from '../../utils/bridge';
import { getPersistedExpanded, setPersistedExpanded } from '../../utils/expandedState';
import { hasSubagentTranscript } from '../../utils/subagentResult';
import { useSessionId, useSessionProvider } from '../../contexts/SubagentContext';
import AgentGroupHeader from './AgentGroupHeader';
import AgentGroupContent from './AgentGroupContent';
import { useAgentGroupDerived } from './useAgentGroupDerived';

// Constants extracted from magic numbers
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

const AgentGroupBlock = memo(function AgentGroupBlock({
  agentBlock,
  followingBlocks,
  messageIndex,
  isStreaming,
  isLastMessage,
  isThinking,
  findToolResult,
}: AgentGroupBlockProps) {
  const currentSessionId = useSessionId();
  const currentProvider = useSessionProvider();
  const derived = useAgentGroupDerived(agentBlock, messageIndex, findToolResult);
  const {
    toolId,
    summary,
    history,
    resolvedAgentId,
    resolvedAgentPath,
    isCompleted,
    isError,
  } = derived;

  const stateKey = `agent-group-${toolId ?? messageIndex}`;
  const [expanded, setExpandedRaw] = useState(() => getPersistedExpanded(stateKey));
  const setExpanded = useCallback((updater: (prev: boolean) => boolean) => {
    setExpandedRaw((prev) => {
      const next = updater(prev);
      setPersistedExpanded(stateKey, next);
      return next;
    });
  }, [stateKey]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, [setExpanded]);

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
      <AgentGroupHeader
        toolName={derived.toolName}
        agentType={derived.agentType}
        summary={summary}
        expanded={expanded}
        isError={isError}
        isCompleted={isCompleted}
        onToggle={handleToggle}
      />

      {expanded && (
        <AgentGroupContent
          derived={derived}
          canLoad={Boolean(currentSessionId)}
          followingBlocks={followingBlocks}
          messageIndex={messageIndex}
          isStreaming={isStreaming}
          isLastMessage={isLastMessage}
          isThinking={isThinking}
          findToolResult={findToolResult}
        />
      )}
    </div>
  );
});

export default AgentGroupBlock;
