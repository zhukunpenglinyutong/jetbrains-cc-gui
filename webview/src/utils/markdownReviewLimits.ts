/**
 * Mirrors MarkdownReviewLimits.java (REQUEST_MAX_CHARS / MAX_PENDING_BATCHES /
 * TRANSFER_IDS_MAX). The bridge rejects anything above these, so the frontend
 * parses and previews against the same bounds instead of its own literals.
 */
export const REVIEW_MESSAGE_MAX_CHARS = 256_000;
export const REVIEW_BATCHES_MAX = 200;
export const REVIEW_ANNOTATIONS_MAX = 1000;
