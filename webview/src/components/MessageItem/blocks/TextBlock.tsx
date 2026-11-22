import MarkdownBlock from '../../MarkdownBlock';
import { useMemo } from 'react';
import CollapsibleTextBlock from '../../CollapsibleTextBlock';
import type { ClaudeContentBlock } from '../../../types';
import { parseLegacyReviewDisplay, parseReviewMessage } from '../../../utils/markdownReviewMessage';
import { LegacyMarkdownReviewBlock, MarkdownReviewBlock } from './MarkdownReviewBlock';

interface TextBlockProps {
  block: Extract<ClaudeContentBlock, { type: 'text' }>;
  messageType: string;
  isStreaming: boolean;
}

export function TextBlock({ block, messageType, isStreaming }: TextBlockProps) {
  const review = useMemo(() => messageType === 'user' ? parseReviewMessage(block.text ?? '') : null, [messageType, block.text]);
  const legacy = useMemo(() => messageType === 'user' ? parseLegacyReviewDisplay(block.text ?? '') : null, [messageType, block.text]);
  if (review) return <MarkdownReviewBlock {...review} />;
  if (legacy) return <LegacyMarkdownReviewBlock {...legacy} />;
  return messageType === 'user' ? (
    <CollapsibleTextBlock content={block.text ?? ''} />
  ) : (
    <MarkdownBlock
      content={block.text ?? ''}
      isStreaming={isStreaming}
    />
  );
}
