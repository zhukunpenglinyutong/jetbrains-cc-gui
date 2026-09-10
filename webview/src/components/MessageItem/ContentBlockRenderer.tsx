import type { TFunction } from 'i18next';
import type { ClaudeContentBlock, ToolResultBlock } from '../../types';

import { TextBlock } from './blocks/TextBlock';
import { ImageBlock } from './blocks/ImageBlock';
import { AttachmentBlock } from './blocks/AttachmentBlock';
import { ThinkingBlock } from './blocks/ThinkingBlock';
import { ToolUseBlock } from './blocks/ToolUseBlock';
import { CompactNotificationBlock } from './blocks/CompactNotificationBlock';
import { CompactSummaryBlock } from './blocks/CompactSummaryBlock';
import { TaskNotificationBlock } from './blocks/TaskNotificationBlock';

export interface ContentBlockRendererProps {
  block: ClaudeContentBlock;
  messageIndex: number;
  messageType: string;
  isStreaming: boolean;
  isThinkingExpanded: boolean;
  isThinking: boolean;
  isLastMessage: boolean;
  isLastBlock?: boolean;
  t: TFunction;
  onToggleThinking: () => void;
  findToolResult: (toolId: string | undefined, messageIndex: number) => ToolResultBlock | null | undefined;
}

export function ContentBlockRenderer({
  block,
  messageIndex,
  messageType,
  isStreaming,
  isThinkingExpanded,
  isThinking,
  isLastMessage,
  isLastBlock = false,
  t,
  onToggleThinking,
  findToolResult,
}: ContentBlockRendererProps): React.ReactElement | null {
  // `isStreaming` arriving here is message-level: it stays true for the whole
  // assistant turn, including tool round-trips and the wait for tool results.
  // But only the LAST block of a streaming message is still receiving tokens —
  // every earlier text/thinking block is already closed. Feeding those closed
  // blocks the full marked pipeline (instead of the lightweight streaming
  // renderer, which knows no tables/lists) lets block-level syntax render the
  // moment a later block such as a tool call arrives, instead of waiting for
  // the entire turn to end. The two renderers are height-aligned (breaks:
  // false), so switching between them stays invisible.
  const isActivelyStreaming = isStreaming && isLastBlock;

  if (block.type === 'text') {
    return (
      <TextBlock
        block={block}
        messageType={messageType}
        isStreaming={isActivelyStreaming}
      />
    );
  }

  if (block.type === 'image' && block.src) {
    return <ImageBlock block={block} messageType={messageType} t={t} />;
  }

  if (block.type === 'attachment') {
    return <AttachmentBlock block={block} t={t} />;
  }

  if (block.type === 'thinking') {
    return (
      <ThinkingBlock
        block={block}
        isThinking={isThinking}
        isThinkingExpanded={isThinkingExpanded}
        isLastMessage={isLastMessage}
        isLastBlock={isLastBlock}
        isActivelyStreaming={isActivelyStreaming}
        t={t}
        onToggleThinking={onToggleThinking}
      />
    );
  }

  if (block.type === 'tool_use') {
    return (
      <ToolUseBlock
        block={block}
        messageIndex={messageIndex}
        isStreaming={isStreaming}
        findToolResult={findToolResult}
      />
    );
  }

  if (block.type === 'compact_notification') {
    return <CompactNotificationBlock block={block} />;
  }

  if (block.type === 'compact_summary') {
    return <CompactSummaryBlock block={block} t={t} />;
  }

  if (block.type === 'task_notification') {
    return <TaskNotificationBlock block={block} />;
  }

  return null;
}
