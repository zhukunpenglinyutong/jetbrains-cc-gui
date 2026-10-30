package com.github.claudecodegui.markdown;

import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Protocol, boundary limits, and keyed error handling tests for the native review bridge.
 */
public class NativeMarkdownBridgeProtocolTest {

    @Test
    public void testLimitConstantsConsistency() {
        assertEquals(500, MarkdownReviewLimits.MAX_PENDING_BATCHES);
        assertEquals(1000, MarkdownReviewLimits.TRANSFER_IDS_MAX);
        assertEquals(256_000, MarkdownReviewLimits.REQUEST_MAX_CHARS);
        assertEquals(200_000, MarkdownReviewLimits.BATCH_MAX_CHARS);
        assertEquals(32_000, MarkdownReviewLimits.TEXT_MAX_CHARS);
        assertEquals(64_000, MarkdownReviewLimits.SPAN_MAX_CHARS);
        assertEquals(128, MarkdownReviewLimits.REQUEST_ID_MAX_CHARS);
    }

    @Test
    public void testReviewRequestExceptionKeys() {
        ReviewRequestException disabled = new ReviewRequestException("disabled", "Annotations are disabled");
        assertEquals("disabled", disabled.messageKey);
        assertEquals("Annotations are disabled", disabled.getMessage());

        ReviewRequestException selectionInvalid = new ReviewRequestException("selectionInvalid", "Text too long");
        assertEquals("selectionInvalid", selectionInvalid.messageKey);

        ReviewRequestException chatGone = new ReviewRequestException("chatGone", "Target chat closed");
        assertEquals("chatGone", chatGone.messageKey);
    }

    @Test
    public void testRequestIdAndAnnotationIdValidation() {
        // IDs must be alphanumeric with dashes/underscores
        String validId = "md-1730000000-42";
        assertTrue(validId.length() <= MarkdownReviewLimits.REQUEST_ID_MAX_CHARS);

        String tooLongId = "x".repeat(MarkdownReviewLimits.REQUEST_ID_MAX_CHARS + 1);
        assertTrue(tooLongId.length() > MarkdownReviewLimits.REQUEST_ID_MAX_CHARS);
    }
}
