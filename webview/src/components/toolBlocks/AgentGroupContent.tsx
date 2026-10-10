import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';
import { extractAgentResultText, isSubagentHistoryCurrent, parseSpawnAgentMeta } from '../../utils/subagentResult';
import { useSubagentHistories } from '../../contexts/SubagentContext';
import SubagentProcessDetails from '../StatusPanel/SubagentProcessDetails';
import { ContentBlockRenderer } from '../MessageItem/ContentBlockRenderer';
import type { AgentGroupDerived } from './useAgentGroupDerived';

interface AgentGroupContentProps {
  derived: AgentGroupDerived;
  canLoad: boolean;
  followingBlocks: ClaudeContentBlock[];
  messageIndex: number;
  isStreaming: boolean;
  isLastMessage: boolean;
  isThinking: boolean;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

function AgentGroupContent({
  derived,
  canLoad,
  followingBlocks,
  messageIndex,
  isStreaming,
  isLastMessage,
  isThinking,
  findToolResult,
}: AgentGroupContentProps) {
  const { t } = useTranslation();
  const noopToggleThinking = useCallback(() => {}, []);
  const histories = useSubagentHistories();
  const { isAsync, taskEvent, resolvedAgentId, agentToolMeta, result, input, toolName, history } = derived;

  return (
    <div className="task-details agent-group-content">
      {derived.states.length > 1 ? derived.states.map(agent => {
        const candidate = histories[agent.id] ?? (agent.agentId ? histories[agent.agentId] : undefined);
        return (
        <SubagentProcessDetails key={agent.id} agentId={agent.agentId} agentPath={agent.agentPath}
          resultText={agent.resultText} totalDurationMs={agent.totalDurationMs} totalTokens={agent.totalTokens}
          totalToolUseCount={agent.totalToolUseCount} history={isSubagentHistoryCurrent(candidate, agent.nativeTaskId) ? candidate : undefined}
          prompt={agent.prompt}
          canLoad={canLoad} />
      ); }) : <SubagentProcessDetails
        agentId={(isAsync ? taskEvent?.agentId : undefined) ?? resolvedAgentId}
        agentPath={derived.resolvedAgentPath}
        totalDurationMs={(isAsync ? taskEvent?.totalDurationMs : undefined) ?? agentToolMeta.totalDurationMs}
        totalTokens={(isAsync ? taskEvent?.totalTokens : undefined) ?? agentToolMeta.totalTokens}
        totalToolUseCount={(isAsync ? taskEvent?.totalToolUseCount : undefined) ?? agentToolMeta.totalToolUseCount}
        resultText={(isAsync ? taskEvent?.summary : undefined) ?? derived.states[0]?.resultText ?? extractAgentResultText(result, toolName)}
        prompt={toolName === 'spawn_agent' ? parseSpawnAgentMeta(input ?? {}, result).prompt
          : typeof input?.prompt === 'string' ? input.prompt : undefined}
        history={history}
        canLoad={canLoad}
      />}
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
  );
}

export default AgentGroupContent;
