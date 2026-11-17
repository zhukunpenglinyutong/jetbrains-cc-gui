import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ArtifactReviewBatch } from './hooks/useArtifactReviews';
import { markdownReviewLocation } from '../../utils/markdownReviewLocation';

interface Props {
  batches: ArtifactReviewBatch[];
  remove: (batchId: string, annotationId?: string) => void;
}
export function ArtifactReviewDrafts({ batches, remove }: Props) {
  const { t } = useTranslation();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const latestAutomaticId = batches.filter(batch => batch.automatic).at(-1)?.id;
  useEffect(() => {
    if (latestAutomaticId && detailsRef.current) detailsRef.current.open = true;
  }, [latestAutomaticId]);
  if (!batches.length) return null;
  const count = batches.reduce((total, batch) => total + batch.annotations.length, 0);
  return <details ref={detailsRef} className="artifact-review-drafts" onClick={event => event.stopPropagation()}>
    <summary>
      <span className="codicon codicon-chevron-right artifact-review-chevron" aria-hidden="true" />
      <span className="codicon codicon-comment" aria-hidden="true" />
      {t('markdownReview.count', { count, defaultValue: '{{count}} comments' })}
    </summary>
    {batches.map(batch => <section key={batch.id}>
      <div className="artifact-review-file">
        <strong><span className="codicon codicon-file-text" aria-hidden="true" />{batch.path}</strong>
        <button type="button" onClick={() => remove(batch.id)}
          aria-label={t('markdownReview.removeBatch', 'Remove review from draft')}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
      {batch.annotations.map(annotation => <article key={annotation.id}>
        <div className="artifact-review-reference">
          <small title={`${batch.path} ${annotation.startLine}:${annotation.endLine}`}>
            {markdownReviewLocation(batch.path, annotation.startLine, annotation.endLine)}
          </small>
          <button type="button" onClick={() => remove(batch.id, annotation.id)}
            aria-label={t('markdownReview.remove', 'Remove')} title={t('markdownReview.remove', 'Remove')}>
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
        <blockquote>{annotation.selectedText}</blockquote>
        {batch.kind !== 'quote' && <p>{annotation.comment}</p>}
      </article>)}
      <small className="artifact-review-snapshot">{t('markdownReview.snapshot', 'This draft is a snapshot; later source comments do not change it.')}</small>
    </section>)}
  </details>;
}
