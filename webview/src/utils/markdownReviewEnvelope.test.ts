import { describe, it, expect } from 'vitest';
import { parseReviewMessage, encodeReviewMessage } from './markdownReviewMessage';
import { REVIEW_BATCHES_MAX, REVIEW_ANNOTATIONS_MAX, REVIEW_MESSAGE_MAX_CHARS } from './markdownReviewLimits';

describe('Markdown review envelope encoding and boundary validation', () => {
  const makeAnnotation = (id: string, startLine = 1, endLine = 2) => ({
    id,
    revision: 1,
    selectedText: 'selected source',
    sourceText: 'selected source',
    comment: 'user review comment',
    status: 'attached',
    precision: 'source',
    startLine,
    endLine,
  });

  const makeBatch = (id: string, annotationsCount = 1) => ({
    id,
    path: 'src/main.rs',
    documentHash: 'sha256-abc',
    kind: 'review' as const,
    targetId: 'target-1',
    targetEpoch: 'epoch-1',
    annotations: Array.from({ length: annotationsCount }, (_, i) => makeAnnotation(`${id}-ann-${i}`)),
  });

  it('encodes and round-trips batches under normal conditions', () => {
    const batches = [makeBatch('b1', 2), makeBatch('b2', 1)];
    const encoded = encodeReviewMessage(batches, 'Please review these segments');
    expect(encoded).toContain('<ccgui-markdown-review>');
    expect(encoded).toContain('Please review these segments');

    const parsed = parseReviewMessage(encoded);
    expect(parsed).not.toBeNull();
    // In legacy envelope (version undefined), parsed batches expand per annotation
    const totalAnnotations = parsed!.batches.reduce((sum, b) => sum + b.annotations.length, 0);
    expect(totalAnnotations).toBe(3);
    expect(parsed!.userText).toBe('Please review these segments');
  });

  it('strictly respects the 500-batch upper bound', () => {
    const wrap = (batches: unknown[]) =>
      `<ccgui-markdown-review>${JSON.stringify({ version: 1, batches })}</ccgui-markdown-review>`;

    // Exactly 500 batches
    const boundaryBatches = Array.from({ length: REVIEW_BATCHES_MAX }, (_, i) => makeBatch(`b-${i}`, 1));
    const validRaw = wrap(boundaryBatches);
    expect(validRaw.length).toBeLessThan(REVIEW_MESSAGE_MAX_CHARS);
    expect(parseReviewMessage(validRaw)?.batches).toHaveLength(500);

    // 501 batches -> must reject
    const overflowBatches = [...boundaryBatches, makeBatch('overflow', 1)];
    const invalidRaw = wrap(overflowBatches);
    expect(parseReviewMessage(invalidRaw)).toBeNull();
  });

  it('strictly respects the 1000-annotation upper bound per batch', () => {
    const wrap = (batches: unknown[]) =>
      `<ccgui-markdown-review>${JSON.stringify({ version: 1, batches })}</ccgui-markdown-review>`;

    // Exactly 1000 annotations in one batch
    const maxAnnBatch = makeBatch('b-huge', REVIEW_ANNOTATIONS_MAX);
    const validRaw = wrap([maxAnnBatch]);
    expect(validRaw.length).toBeLessThan(REVIEW_MESSAGE_MAX_CHARS);
    expect(parseReviewMessage(validRaw)?.batches[0].annotations).toHaveLength(1000);

    // 1001 annotations in one batch -> must reject
    const overflowBatch = makeBatch('b-huge', REVIEW_ANNOTATIONS_MAX + 1);
    const invalidRaw = wrap([overflowBatch]);
    expect(parseReviewMessage(invalidRaw)).toBeNull();
  });

  it('rejects malformed and tampered envelopes', () => {
    const wrap = (obj: unknown) => `<ccgui-markdown-review>${JSON.stringify(obj)}</ccgui-markdown-review>`;

    // Invalid version
    expect(parseReviewMessage(wrap({ version: 99, batches: [makeBatch('b1')] }))).toBeNull();

    // Invalid kind
    const badKind = { ...makeBatch('b1'), kind: 'malicious-action' as any };
    expect(parseReviewMessage(wrap({ version: 1, batches: [badKind] }))).toBeNull();

    // Empty annotations array
    const emptyAnnotations = { ...makeBatch('b1'), annotations: [] };
    expect(parseReviewMessage(wrap({ version: 1, batches: [emptyAnnotations] }))).toBeNull();

    // Non-finite line numbers
    const nanLine = { ...makeBatch('b1'), annotations: [makeAnnotation('a1', NaN, 2)] };
    expect(parseReviewMessage(wrap({ version: 1, batches: [nanLine] }))).toBeNull();

    const infinityLine = { ...makeBatch('b1'), annotations: [makeAnnotation('a1', 1, Infinity)] };
    expect(parseReviewMessage(wrap({ version: 1, batches: [infinityLine] }))).toBeNull();

    // Incomplete tags
    expect(parseReviewMessage('<ccgui-markdown-review>{"version":1}')).toBeNull();
  });
});
