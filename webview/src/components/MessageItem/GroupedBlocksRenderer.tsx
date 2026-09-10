import { memo } from 'react';
import type { TFunction } from 'i18next';
import type { ClaudeMessage, ToolResultBlock } from '../../types';

import MarkdownBlock from '../MarkdownBlock';
import { ProviderNotConfiguredCard } from './ProviderNotConfiguredCard';
import { ErrorDiagnosticCard } from './ErrorDiagnosticCard';
import type { DiagnosticPattern } from '../../utils/errorMatcher';
import {
  EditToolBlock,
  ReadToolBlock,
  ReadToolGroupBlock,
  BashToolBlock,
  BashToolGroupBlock,
  SearchToolGroupBlock,
  AgentGroupBlock,
} from '../toolBlocks';
import { ContentBlockRenderer } from './ContentBlockRenderer';
import type { GroupedBlock } from './groupBlocks';

/** Map provider id to a human-readable label used in UI text. */
function getProviderDisplayName(providerId?: string): string {
  if (providerId === 'codex') return 'Codex';
  if (providerId === 'grok') return 'Grok';
  if (providerId === 'gemini') return 'Gemini';
  if (providerId === 'opencode') return 'OpenCode';
  if (providerId === 'kimi') return 'Kimi';
  if (providerId === 'pi') return 'Pi';
  if (providerId === 'omp') return 'OMP';
  if (providerId === 'dsh') return 'DSH';
  if (providerId === 'zcode') return 'ZCode';
  if (providerId) return providerId.charAt(0).toUpperCase() + providerId.slice(1);
  return 'Claude';
}

function getGroupedBlockKey(grouped: GroupedBlock, messageIndex: number, messageKey: string): string {
  switch (grouped.type) {
    case 'read_group':
      return `${messageIndex}-readgroup-${grouped.startIndex}`;
    case 'edit_group':
      return `${messageIndex}-editgroup-${grouped.startIndex}`;
    case 'bash_group':
      return `${messageIndex}-bashgroup-${grouped.startIndex}`;
    case 'search_group':
      return `${messageIndex}-searchgroup-${grouped.startIndex}`;
    case 'agent_group':
      return `${messageKey}-agentgroup-${grouped.startIndex}`;
    default:
      return `${messageIndex}-${grouped.originalIndex}`;
  }
}

interface GroupedBlockViewProps {
  grouped: GroupedBlock;
  messageIndex: number;
  messageType: ClaudeMessage['type'];
  renderedBlockCount: number;
  isMessageStreaming: boolean;
  isThinking: boolean;
  isLast: boolean;
  isThinkingExpanded: (blockIndex: number) => boolean;
  onToggleThinking: (blockIndex: number) => void;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  t: TFunction;
}

const GroupedBlockView = memo(function GroupedBlockView({
  grouped,
  messageIndex,
  messageType,
  renderedBlockCount,
  isMessageStreaming,
  isThinking,
  isLast,
  isThinkingExpanded,
  onToggleThinking,
  findToolResult,
  t,
}: GroupedBlockViewProps) {
  if (grouped.type === 'read_group') {
    const readItems = grouped.blocks.map((b) => {
      const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
      return {
        name: block.name,
        input: block.input,
        result: findToolResult(block.id, messageIndex),
        toolId: block.id,
      };
    });

    if (readItems.length === 1) {
      return (
        <div className="content-block">
          <ReadToolBlock
            input={readItems[0].input}
            result={readItems[0].result}
            toolId={readItems[0].toolId}
          />
        </div>
      );
    }

    return (
      <div className="content-block">
        <ReadToolGroupBlock items={readItems} />
      </div>
    );
  }

  if (grouped.type === 'edit_group') {
    const editItems = grouped.blocks.map((b) => {
      const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
      return {
        name: block.name,
        input: block.input,
        result: findToolResult(block.id, messageIndex),
        toolId: block.id,
      };
    });

    // Always route through EditToolBlock so the instance stays stable as
    // edits stream in (1 -> 2 -> ...). It renders the inline-diff view for
    // a single item and delegates to the grouped list view for multiple,
    // without unmounting on the transition.
    return (
      <div className="content-block">
        <EditToolBlock items={editItems} />
      </div>
    );
  }

  if (grouped.type === 'bash_group') {
    const bashItems = grouped.blocks.map((b) => {
      const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
      return {
        name: block.name,
        input: block.input,
        result: findToolResult(block.id, messageIndex),
        toolId: block.id,
      };
    });

    if (bashItems.length === 1) {
      return (
        <div className="content-block">
          <BashToolBlock
            name={bashItems[0].name}
            input={bashItems[0].input}
            result={bashItems[0].result}
            toolId={bashItems[0].toolId}
          />
        </div>
      );
    }

    return (
      <div className="content-block">
        <BashToolGroupBlock items={bashItems} deniedToolIds={window.__deniedToolIds} />
      </div>
    );
  }

  if (grouped.type === 'search_group') {
    const searchItems = grouped.blocks.map((b) => {
      const block = b as { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> };
      return {
        name: block.name,
        input: block.input,
        result: findToolResult(block.id, messageIndex),
      };
    });

    if (searchItems.length === 1) {
      return (
        <div className="content-block">
          <ContentBlockRenderer
            block={grouped.blocks[0]}
            messageIndex={messageIndex}
            messageType={messageType}
            isStreaming={isMessageStreaming}
            isThinkingExpanded={false}
            isThinking={isThinking}
            isLastMessage={isLast}
            isLastBlock={grouped.startIndex === renderedBlockCount - 1}
            t={t}
            onToggleThinking={() => {}}
            findToolResult={findToolResult}
          />
        </div>
      );
    }

    return (
      <div className="content-block">
        <SearchToolGroupBlock items={searchItems} />
      </div>
    );
  }

  if (grouped.type === 'agent_group') {
    return (
      <div className="content-block">
        <AgentGroupBlock
          agentBlock={grouped.agentBlock}
          followingBlocks={grouped.followingBlocks}
          messageIndex={messageIndex}
          isStreaming={isMessageStreaming}
          isLastMessage={isLast}
          isThinking={isThinking}
          findToolResult={findToolResult}
        />
      </div>
    );
  }

  const { block, originalIndex: blockIndex } = grouped;

  return (
    <div className="content-block">
      <ContentBlockRenderer
        block={block}
        messageIndex={messageIndex}
        messageType={messageType}
        isStreaming={isMessageStreaming}
        isThinkingExpanded={isThinkingExpanded(blockIndex)}
        isThinking={isThinking}
        isLastMessage={isLast}
        isLastBlock={blockIndex === renderedBlockCount - 1}
        t={t}
        onToggleThinking={() => onToggleThinking(blockIndex)}
        findToolResult={findToolResult}
      />
    </div>
  );
});

interface GroupedBlocksRendererProps {
  message: ClaudeMessage;
  messageIndex: number;
  messageKey: string;
  t: TFunction;
  getMessageText: (message: ClaudeMessage) => string;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
  isProviderNotConfigured: boolean;
  errorDiagnosticPattern: DiagnosticPattern | null;
  isEmptyStreamingPlaceholder: boolean;
  currentProvider?: string;
  groupedBlocks: GroupedBlock[];
  renderedBlockCount: number;
  isMessageStreaming: boolean;
  isThinking: boolean;
  isLast: boolean;
  isThinkingExpanded: (blockIndex: number) => boolean;
  onToggleThinking: (blockIndex: number) => void;
  onNavigateToProviderSettings?: () => void;
  onNavigateToDependencySettings?: () => void;
}

export const GroupedBlocksRenderer = memo(function GroupedBlocksRenderer({
  message,
  messageIndex,
  messageKey,
  t,
  getMessageText,
  findToolResult,
  isProviderNotConfigured,
  errorDiagnosticPattern,
  isEmptyStreamingPlaceholder,
  currentProvider,
  groupedBlocks,
  renderedBlockCount,
  isMessageStreaming,
  isThinking,
  isLast,
  isThinkingExpanded,
  onToggleThinking,
  onNavigateToProviderSettings,
  onNavigateToDependencySettings,
}: GroupedBlocksRendererProps) {
  if (message.type === 'error') {
    if (isProviderNotConfigured) {
      return (
        <ProviderNotConfiguredCard
          t={t}
          onNavigateToSettings={onNavigateToProviderSettings}
        />
      );
    }
    return (
      <>
        <MarkdownBlock content={getMessageText(message)} />
        {errorDiagnosticPattern && (
          <ErrorDiagnosticCard
            t={t}
            pattern={errorDiagnosticPattern}
            onNavigateToDependencySettings={onNavigateToDependencySettings}
          />
        )}
      </>
    );
  }

  if (isEmptyStreamingPlaceholder) {
    return (
      <div className="streaming-connect-status">
        <span className="streaming-connect-text">
          {t('chat.streamingConnected', { provider: getProviderDisplayName(currentProvider) })}
        </span>
      </div>
    );
  }

  return (
    <>
      {groupedBlocks.map((grouped) => (
        <GroupedBlockView
          key={getGroupedBlockKey(grouped, messageIndex, messageKey)}
          grouped={grouped}
          messageIndex={messageIndex}
          messageType={message.type}
          renderedBlockCount={renderedBlockCount}
          isMessageStreaming={isMessageStreaming}
          isThinking={isThinking}
          isLast={isLast}
          isThinkingExpanded={isThinkingExpanded}
          onToggleThinking={onToggleThinking}
          findToolResult={findToolResult}
          t={t}
        />
      ))}
    </>
  );
});
