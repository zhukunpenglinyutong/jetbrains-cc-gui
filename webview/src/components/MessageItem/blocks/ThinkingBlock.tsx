import type { TFunction } from 'i18next';
import MarkdownBlock from '../../MarkdownBlock';
import type { ClaudeContentBlock } from '../../../types';

interface ThinkingBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'thinking' }>;
  isThinking: boolean;
  isThinkingExpanded: boolean;
  isLastMessage: boolean;
  isLastBlock: boolean;
  isActivelyStreaming: boolean;
  t: TFunction;
  onToggleThinking: () => void;
}

export function ThinkingBlock({
  block,
  isThinking,
  isThinkingExpanded,
  isLastMessage,
  isLastBlock,
  isActivelyStreaming,
  t,
  onToggleThinking,
}: ThinkingBlockProps) {
  return (
    <div className="thinking-block">
      <div
        className="thinking-header"
        onClick={onToggleThinking}
      >
        <span className="thinking-title">
          {isThinking && isLastMessage && isLastBlock
            ? t('common.thinkingProcess')
            : t('common.thinking')}
        </span>
        <span className="thinking-icon">
          {isThinkingExpanded ? '▼' : '▶'}
        </span>
      </div>
      <div className={`thinking-content ${isThinkingExpanded ? 'expanded' : ''}`}>
        <div className="thinking-content-inner">
          <MarkdownBlock
            content={block.thinking ?? block.text ?? t('chat.noThinkingContent')}
            isStreaming={isActivelyStreaming}
          />
        </div>
      </div>
    </div>
  );
}
