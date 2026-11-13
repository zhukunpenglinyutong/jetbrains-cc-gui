import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import CollapsibleTextBlock from '../../CollapsibleTextBlock';
import type { ArtifactReviewBatch } from '../../ChatInputBox/hooks/useArtifactReviews';
import { markdownReviewLocation } from '../../../utils/markdownReviewLocation';
import { CompactSummaryBlock } from './CompactSummaryBlock';
import './markdown-review-block.css';

export function MarkdownReviewBlock({ batches, userText }: { batches: ArtifactReviewBatch[]; userText: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const count = batches.reduce((sum, batch) => sum + batch.annotations.length, 0);
  return <>
    <details className="markdown-review-context" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="markdown-review-title">
        <span className="codicon codicon-comment" aria-hidden="true" />
        <span className="markdown-review-title-text">{t('markdownReview.contextCard', { count })}</span>
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </summary>
      <div className="markdown-review-paths">{[...new Set(batches.map(batch => batch.path))].join(' · ')}</div>
      {expanded && <div className="markdown-review-items">
        {batches.map(batch => <section key={batch.id}>
          {batches.length > 1 && <strong>{batch.path}</strong>}
          {batch.annotations.map(item => <article key={item.id}>
            <div className="markdown-review-item-heading"><small className="markdown-review-id">#{item.id}</small>
            <small className="markdown-review-location" title={`${batch.path} ${item.startLine}:${item.endLine}`}>
              {markdownReviewLocation(batch.path, item.startLine, item.endLine)}
            </small></div>
            <blockquote>{item.selectedText}</blockquote>
            {batch.kind !== 'quote' && <p>{item.comment}</p>}
          </article>)}
        </section>)}
      </div>}
    </details>
    {userText && <div className="markdown-review-user-text"><CollapsibleTextBlock content={userText} /></div>}
  </>;
}

export function LegacyMarkdownReviewBlock({ contextText, userText }: { contextText: string; userText: string }) {
  const { t } = useTranslation();
  return <>
    <CompactSummaryBlock t={t} block={{ type: 'compact_summary', title: 'markdownReview.legacyContextCard', content: contextText }} />
    {userText && <div className="markdown-review-user-text"><CollapsibleTextBlock content={userText} /></div>}
  </>;
}
