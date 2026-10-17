import type { TFunction } from 'i18next';
import MarkdownBlock from '../../MarkdownBlock';
import type { ClaudeContentBlock } from '../../../types';
import { shouldRevealThinking } from '../../../utils/thinkingVisibility';

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
  if (!shouldRevealThinking(block)) return null;
  const nativeThinking = block.native === true;
  const thinkingText = block.thinking ?? block.text;
  const thinkingContent = thinkingText ?? t('chat.noThinkingContent');
  // Native completion can arrive before the surrounding assistant turn ends.
  const isThinkingInProgress = nativeThinking
    ? block.status === 'inProgress' && isActivelyStreaming
    : isThinking && isLastMessage && isLastBlock;

  return (
    <div className="thinking-block">
      <div
        className="thinking-header"
        onClick={onToggleThinking}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggleThinking();
          }
        }}
      >
        <span className="thinking-title">
          {isThinkingInProgress
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
            content={thinkingContent}
            isStreaming={nativeThinking ? isThinkingInProgress : isActivelyStreaming}
          />
        </div>
      </div>
    </div>
  );
}
