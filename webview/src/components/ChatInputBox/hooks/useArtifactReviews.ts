import { useCallback, useEffect, useRef, useState } from 'react';
import { sendBridgeEvent } from '../../../utils/bridge';
import { encodeReviewMessage } from '../../../utils/markdownReviewMessage';

export interface ReviewAnnotation {
  id: string; revision: number; selectedText: string; sourceText: string;
  comment: string; startLine: number; endLine: number; status: string; precision: string;
  sourceContext?: string;
  completed?: boolean;
  /** Backend withdrawal marker: the annotation was completed or deleted after handoff. */
  withdrawn?: boolean;
}
export interface ArtifactReviewBatch {
  id: string; targetId: string; targetEpoch: string; path: string;
  kind?: 'review' | 'quote';
  autoDeleteAffected?: boolean;
  automatic?: boolean;
  documentHash: string; annotations: ReviewAnnotation[];
}

export function serializeArtifactReviews(batches: ArtifactReviewBatch[]): string {
  // Send-time double insurance (plan §9): never hand a withdrawn (completed or
  // deleted) entry to the model, even if a withdrawal push raced the submit.
  return encodeReviewMessage(batches
    .map(batch => ({ ...batch,
      annotations: batch.annotations.filter(annotation => !annotation.withdrawn && annotation.completed !== true) }))
    .filter(batch => batch.annotations.length > 0));
}

function acknowledge(batch: ArtifactReviewBatch, status: 'received' | 'queued' | 'removed') {
  return sendBridgeEvent('artifact_review_ack', JSON.stringify({
    id: batch.id, targetId: batch.targetId, targetEpoch: batch.targetEpoch, status,
    annotationIds: batch.annotations.map(annotation => annotation.id),
  }));
}

export function useArtifactReviews() {
  const [batches, setBatches] = useState<ArtifactReviewBatch[]>([]);
  const batchesRef = useRef(batches);
  const targetRef = useRef<{ targetId: string; targetEpoch: string } | null>(null);
  batchesRef.current = batches;
  useEffect(() => {
    const bindTarget = (payload: string) => {
      try {
        const target = JSON.parse(payload) as { targetId: string; targetEpoch: string };
        if (!target.targetId || !target.targetEpoch) return;
        const old = targetRef.current;
        if (old && (old.targetId !== target.targetId || old.targetEpoch !== target.targetEpoch)) {
          // The retired target can no longer receive these drafts; report them as
          // discarded under their own frozen identity so the backend reclaims them.
          for (const batch of batchesRef.current) acknowledge(batch, 'removed');
          batchesRef.current = []; setBatches([]);
        }
        targetRef.current = target;
      } catch { /* Wait for a valid authoritative target binding. */ }
    };
    const receive = (payload: string) => {
      try {
        const batch = JSON.parse(payload) as ArtifactReviewBatch;
        if (!batch.id || !batch.targetEpoch || !Array.isArray(batch.annotations)) return;
        if (batch.targetId !== targetRef.current?.targetId || batch.targetEpoch !== targetRef.current?.targetEpoch) return;
        const existing = batchesRef.current.find(item => item.id === batch.id);
        if (!existing) {
          // Update the ref immediately: multiple Java events can arrive before
          // React commits the next render.
          const relocated = batch.annotations.filter(annotation => !batchesRef.current.some(item =>
            item.annotations.some(old => old.id === annotation.id && old.revision >= annotation.revision
              && item.documentHash === batch.documentHash)));
          // A withdrawal snapshot relocates its stale copy out of every draft
          // without ever becoming a visible card itself.
          const annotations = relocated.filter(annotation => !annotation.withdrawn);
          const incoming = { ...batch, annotations };
          const previous = batchesRef.current.flatMap(item => {
            const remaining = item.annotations.filter(old => !relocated.some(annotation => annotation.id === old.id));
            if (remaining.length === item.annotations.length) return [item];
            const updated = { ...item, annotations: remaining };
            acknowledge(updated, remaining.length ? 'received' : 'removed');
            return remaining.length ? [updated] : [];
          });
          const next = annotations.length ? [...previous, incoming] : previous;
          batchesRef.current = next;
          setBatches(next);
          acknowledge(incoming, annotations.length ? 'received' : 'removed');
        } else {
          acknowledge(existing, 'received');
        }
        window.focusChatInput?.();
      } catch { /* A malformed batch is not acknowledged; Java retains it. */ }
    };
    window.addArtifactReview = receive;
    window.setArtifactReviewTarget = bindTarget;
    sendBridgeEvent('artifact_review_ready');
    return () => {
      if (window.addArtifactReview === receive) delete window.addArtifactReview;
      if (window.setArtifactReviewTarget === bindTarget) delete window.setArtifactReviewTarget;
    };
  }, []);

  const remove = useCallback((batchId: string, annotationId?: string) => {
    const next: ArtifactReviewBatch[] = [];
    for (const batch of batchesRef.current) {
      if (batch.id !== batchId) { next.push(batch); continue; }
      const annotations = annotationId ? batch.annotations.filter(item => item.id !== annotationId) : [];
      const updated = { ...batch, annotations };
      acknowledge(updated, annotations.length ? 'received' : 'removed');
      if (annotations.length) next.push(updated);
    }
    batchesRef.current = next;
    setBatches(next);
  }, []);

  const captureSubmission = useCallback(() => {
    const snapshot = batchesRef.current;
    const target = targetRef.current;
    return {
      text: serializeArtifactReviews(snapshot),
      isCurrent: () => target?.targetId === targetRef.current?.targetId && target?.targetEpoch === targetRef.current?.targetEpoch,
      onSubmitted: () => {
        for (const batch of snapshot) acknowledge(batch, 'queued');
        const ids = new Set(snapshot.map(batch => batch.id));
        const next = batchesRef.current.filter(batch => !ids.has(batch.id));
        batchesRef.current = next;
        setBatches(next);
      },
    };
  }, []);

  const reset = useCallback(() => {
    // Session changes must not consume/reassign the old session's drafts.
    for (const batch of batchesRef.current) acknowledge(batch, 'removed');
    batchesRef.current = [];
    targetRef.current = null;
    setBatches([]);
    sendBridgeEvent('artifact_review_ready');
  }, []);

  return {
    batches, remove, captureSubmission, reset,
    hasReviews: batches.some(batch => batch.annotations.length > 0),
  };
}
