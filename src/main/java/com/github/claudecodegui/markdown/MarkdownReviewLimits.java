package com.github.claudecodegui.markdown;

/** Bounded limits shared by the review service and the preview bridge. Not user-configurable. */
public final class MarkdownReviewLimits {
    private MarkdownReviewLimits() {
    }

    /** Maximum stored handoff snapshots (pending and terminal) before the oldest is evicted. */
    public static final int MAX_PENDING_BATCHES = 200;
    /** Cached request responses kept for replay across preview reloads. */
    public static final int RESPONSE_CACHE = 128;
    /** Upper bound for a single bridge request, in characters. */
    public static final int REQUEST_MAX_CHARS = 256_000;
    /** Upper bound for a serialized handoff batch, in characters. */
    public static final int BATCH_MAX_CHARS = 200_000;
    /** Upper bound for a selected text or a comment, in characters. */
    public static final int TEXT_MAX_CHARS = 32_000;
    /** Upper bound for the annotated source span, in characters. */
    public static final int SPAN_MAX_CHARS = 64_000;
    /** Documents above this length skip rendered-selection validation. */
    public static final int DOC_MAX_CHARS = 500_000;
    /** Upper bound for a bridge request id, in characters. */
    public static final int REQUEST_ID_MAX_CHARS = 128;
    /** Upper bound for explicitly requested annotation ids in one transfer. */
    public static final int TRANSFER_IDS_MAX = 1000;
    /** Context characters kept on each side of an annotation for relocation. */
    public static final int ANCHOR_CONTEXT_CHARS = 48;
}
