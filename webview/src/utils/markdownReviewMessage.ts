import type { ArtifactReviewBatch } from '../components/ChatInputBox/hooks/useArtifactReviews';
import { REVIEW_ANNOTATIONS_MAX, REVIEW_BATCHES_MAX, REVIEW_MESSAGE_MAX_CHARS } from './markdownReviewLimits';

export const REVIEW_OPEN = '<ccgui-markdown-review>';
const REVIEW_CLOSE = '</ccgui-markdown-review>';

/** Durable, bounded context envelope: queue and history retain snapshots, never agent instructions. */
export function encodeReviewMessage(batches: ArtifactReviewBatch[], userText = ''): string {
  if (!batches.length) return userText;
  const annotations = new Map<string, object>();
  for (const batch of batches) for (const annotation of batch.annotations) {
    annotations.set(annotation.id, {
      id: annotation.id, path: batch.path, kind: batch.kind ?? 'review',
      selectedText: annotation.selectedText, comment: annotation.comment,
      startLine: annotation.startLine, endLine: annotation.endLine,
    });
  }
  if (!annotations.size) return userText;
  const context = [{ annotations: [...annotations.values()] }];
  // Keep snapshot strings opaque to transcript-tag filtering, quote/reference
  // expansion and global zero-width cleanup. Structural JSON stays unchanged.
  const json = JSON.stringify({ batches: context }).replace(/"(?:[^"\\]|\\.)*"/g, token =>
    token.replace(/[<>&\[\]@\u200B-\u200D\uFEFF]/g, character =>
      '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')));
  return REVIEW_OPEN + json + REVIEW_CLOSE + (userText.trim() ? '\n\n' + userText : '');
}

export function parseReviewMessage(text: string): { batches: ArtifactReviewBatch[]; userText: string } | null {
  if (!text.startsWith(REVIEW_OPEN) || text.length > REVIEW_MESSAGE_MAX_CHARS) return null;
  const end = text.indexOf(REVIEW_CLOSE, REVIEW_OPEN.length);
  if (end < 0) return null;
  try {
    const data = JSON.parse(text.slice(REVIEW_OPEN.length, end));
    if (!Array.isArray(data.batches) || !data.batches.length || data.batches.length > REVIEW_BATCHES_MAX) return null;
    if (data.version === undefined) {
      const normalized: ArtifactReviewBatch[] = [];
      for (const batch of data.batches) {
        if (!Array.isArray(batch.annotations) || !batch.annotations.length || batch.annotations.length > REVIEW_ANNOTATIONS_MAX) return null;
        for (const item of batch.annotations) {
          if (typeof item.id !== 'string' || typeof item.path !== 'string'
            || !['review', 'quote'].includes(item.kind) || typeof item.selectedText !== 'string'
            || typeof item.comment !== 'string' || !Number.isFinite(item.startLine) || !Number.isFinite(item.endLine)) return null;
          normalized.push({ id: item.id, path: item.path, kind: item.kind, targetId: '', targetEpoch: '', documentHash: '',
            annotations: [{ ...item, revision: 0, sourceText: item.selectedText, status: '', precision: '' }] });
        }
      }
      return { batches: normalized, userText: text.slice(end + REVIEW_CLOSE.length).trim() };
    }
    if (data.version !== 1) return null;
    for (const batch of data.batches) {
      if (typeof batch.id !== 'string' || typeof batch.path !== 'string' || typeof batch.documentHash !== 'string' || !Array.isArray(batch.annotations)
        || !['review', 'quote'].includes(batch.kind) || !batch.annotations.length || batch.annotations.length > REVIEW_ANNOTATIONS_MAX) return null;
      for (const item of batch.annotations) {
        if (typeof item.id !== 'string' || typeof item.selectedText !== 'string' || typeof item.comment !== 'string'
          || typeof item.status !== 'string' || typeof item.precision !== 'string'
          || (item.sourceContext !== undefined && typeof item.sourceContext !== 'string')
          || !Number.isFinite(item.startLine) || !Number.isFinite(item.endLine)) return null;
      }
    }
    return { batches: data.batches, userText: text.slice(end + REVIEW_CLOSE.length).trim() };
  } catch { return null; }
}

/** Display-only compatibility with the first release; never resend its embedded rules. */
export function parseLegacyReviewDisplay(text: string): { contextText: string; userText: string } | null {
  if (!text.startsWith('CC GUI Markdown review handling instructions:')) return null;
  const begin = text.indexOf('\n\nMarkdown review: ');
  if (begin < 0) return null;
  const body = text.slice(begin + 2);
  const request = body.lastIndexOf('\n\nUser request:\n');
  return request < 0 ? { contextText: body, userText: '' }
    : { contextText: body.slice(0, request), userText: body.slice(request + '\n\nUser request:\n'.length) };
}
