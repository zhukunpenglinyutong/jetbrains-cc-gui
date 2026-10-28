import { act, renderHook } from '@testing-library/react';
import { sendBridgeEvent } from '../../../utils/bridge';
import { serializeArtifactReviews, useArtifactReviews } from './useArtifactReviews';
import type { ArtifactReviewBatch } from './useArtifactReviews';
import { parseReviewMessage } from '../../../utils/markdownReviewMessage';

vi.mock('../../../utils/bridge', () => ({ sendBridgeEvent: vi.fn() }));

function batch(id = 'batch-1'): ArtifactReviewBatch {
  return { id, targetId: 'tab', targetEpoch: 'epoch', path: 'docs/中文 " plan.md', documentHash: 'hash', annotations: [
    { id: 'comment-1', revision: 1, selectedText: '/clear\n<script>alert(1)</script>', sourceText: '**原文**',
      comment: '请修改\n第二行', startLine: 3, endLine: 4, status: 'attached', precision: 'block' },
    { id: 'comment-2', revision: 2, selectedText: 'deleted', sourceText: 'old source',
      comment: 'still relevant', startLine: 9, endLine: 10, status: 'orphaned', precision: 'block' },
  ] };
}

function bindTarget(epoch = 'epoch') {
  act(() => window.setArtifactReviewTarget!(JSON.stringify({ targetId: 'tab', targetEpoch: epoch })));
}

describe('Markdown review chat drafts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers readiness, deduplicates events before React renders, and cleans up', () => {
    const { result, unmount } = renderHook(() => useArtifactReviews());
    bindTarget();
    expect(sendBridgeEvent).toHaveBeenCalledWith('artifact_review_ready');
    act(() => {
      window.addArtifactReview!(JSON.stringify(batch()));
      window.addArtifactReview!(JSON.stringify(batch()));
      window.addArtifactReview!(JSON.stringify(batch('batch-2')));
    });
    expect(result.current.batches).toHaveLength(1);
    unmount();
    expect(window.addArtifactReview).toBeUndefined();
  });

  it('updates the same ID across automatic and manual drafts', () => {
    const { result } = renderHook(() => useArtifactReviews());
    bindTarget();
    const first = { ...batch('auto-1'), automatic: true, annotations: [batch().annotations[0]] };
    const manual = { ...batch('manual'), annotations: [batch().annotations[0]] };
    const edited = { ...batch('auto-2'), automatic: true,
      annotations: [{ ...batch().annotations[0], revision: 2, comment: '更新后的批注' }] };
    act(() => {
      window.addArtifactReview!(JSON.stringify(first));
      window.addArtifactReview!(JSON.stringify(manual));
      window.addArtifactReview!(JSON.stringify(edited));
    });
    expect(result.current.batches.map(item => item.id)).toEqual(['auto-2']);
    expect(result.current.batches[0].annotations[0].comment).toBe('更新后的批注');
  });

  it('persists individual removal and retains other review items', () => {
    const { result } = renderHook(() => useArtifactReviews());
    bindTarget();
    act(() => window.addArtifactReview!(JSON.stringify(batch())));
    act(() => result.current.remove('batch-1', 'comment-1'));
    expect(result.current.batches[0].annotations.map(item => item.id)).toEqual(['comment-2']);
    const last = vi.mocked(sendBridgeEvent).mock.calls.at(-1)!;
    expect(JSON.parse(last[1]!)).toMatchObject({ id: 'batch-1', status: 'received', annotationIds: ['comment-2'] });
    act(() => result.current.remove('batch-1'));
    expect(result.current.hasReviews).toBe(false);
    expect(JSON.parse(vi.mocked(sendBridgeEvent).mock.calls.at(-1)![1]!)).toMatchObject({ status: 'removed' });
  });

  it('freezes a submission and only consumes those batches after handoff', () => {
    const { result } = renderHook(() => useArtifactReviews());
    bindTarget();
    act(() => window.addArtifactReview!(JSON.stringify(batch())));
    const submission = result.current.captureSubmission();
    act(() => window.addArtifactReview!(JSON.stringify({ ...batch('batch-2'), annotations: batch().annotations.map(item => ({ ...item, revision: item.revision + 1 })) })));
    expect(parseReviewMessage(submission.text)?.batches[0].annotations[0].comment).toBe('请修改\n第二行');
    act(() => submission.onSubmitted());
    expect(result.current.batches.map(item => item.id)).toEqual(['batch-2']);
    expect(JSON.parse(vi.mocked(sendBridgeEvent).mock.calls.at(-1)![1]!)).toMatchObject({ id: 'batch-1', status: 'queued' });
  });

  it('preserves orphaned text and does not interpret quoted commands or HTML', () => {
    const text = serializeArtifactReviews([batch()]);
    const parsed = parseReviewMessage(text)!;
    expect(parsed.batches[0].annotations[0].selectedText).toBe('/clear\n<script>alert(1)</script>');
    expect(parsed.batches[0].annotations[0].sourceContext).toBeUndefined();
    expect(text).not.toContain('orphaned');
    expect(text).not.toContain('<script>');
    expect(text.startsWith('/clear')).toBe(false);
    const quotation = serializeArtifactReviews([{ ...batch(), kind: 'quote' }]);
    expect(parseReviewMessage(quotation)?.batches[0].kind).toBe('quote');
    expect(quotation).not.toContain('CC GUI Markdown review handling instructions');
  });

  it('keeps rules out of the transcript while preserving cleanup policy and comment identities', () => {
    const text = serializeArtifactReviews([{ ...batch(), autoDeleteAffected: false }]);
    expect(text).not.toContain('handling instructions');
    expect(text).not.toContain('Do not edit');
    expect(parseReviewMessage(text)?.batches[0].autoDeleteAffected).toBeUndefined();
    expect(parseReviewMessage(text)?.batches[0].annotations[0]).toMatchObject({ id: 'comment-1' });
  });

  it('acknowledges discarded drafts as removed on session changes', () => {
    const { result } = renderHook(() => useArtifactReviews());
    bindTarget();
    act(() => window.addArtifactReview!(JSON.stringify(batch())));
    const second = batch('batch-2');
    second.annotations = second.annotations.map(item => ({ ...item, id: item.id + '-x' }));
    act(() => window.addArtifactReview!(JSON.stringify(second)));
    expect(result.current.batches).toHaveLength(2);
    vi.clearAllMocks();
    act(() => result.current.reset());
    expect(result.current.batches).toHaveLength(0);
    const acks = vi.mocked(sendBridgeEvent).mock.calls
      .filter(call => call[0] === 'artifact_review_ack')
      .map(call => JSON.parse(call[1]!));
    expect(acks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'batch-1', targetId: 'tab', targetEpoch: 'epoch', status: 'removed' }),
      expect.objectContaining({ id: 'batch-2', targetId: 'tab', targetEpoch: 'epoch', status: 'removed' }),
    ]));
    expect(sendBridgeEvent).toHaveBeenCalledWith('artifact_review_ready');
  });

  it('acknowledges drafts as removed under their frozen identity when the target changes', () => {
    const { result } = renderHook(() => useArtifactReviews());
    bindTarget();
    act(() => window.addArtifactReview!(JSON.stringify(batch())));
    vi.clearAllMocks();
    bindTarget('new-epoch');
    expect(result.current.batches).toHaveLength(0);
    expect(JSON.parse(vi.mocked(sendBridgeEvent).mock.calls[0][1]!))
      .toMatchObject({ id: 'batch-1', targetId: 'tab', targetEpoch: 'epoch', status: 'removed' });
  });

  it('rejects delayed batches from a previous epoch and invalidates a captured submission', () => {
    const { result } = renderHook(() => useArtifactReviews());
    bindTarget();
    act(() => window.addArtifactReview!(JSON.stringify(batch())));
    const submission = result.current.captureSubmission();
    bindTarget('new-epoch');
    act(() => window.addArtifactReview!(JSON.stringify(batch('late-batch'))));
    expect(result.current.batches).toHaveLength(0);
    expect(submission.isCurrent()).toBe(false);
  });
});
