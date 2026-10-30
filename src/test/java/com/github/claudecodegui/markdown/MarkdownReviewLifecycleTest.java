package com.github.claudecodegui.markdown;

import org.junit.Test;
import java.util.List;
import static org.junit.Assert.*;

/**
 * Tests for review service lifecycle, 500-batch tier eviction, and edit impact consumption.
 */
public class MarkdownReviewLifecycleTest {

    private ReviewBatch createBatch(String id, String target, String status) {
        ReviewBatch batch = new ReviewBatch();
        batch.id = id;
        batch.targetId = target;
        batch.targetEpoch = "epoch-1";
        batch.status = status;
        batch.path = "doc.md";
        batch.documentHash = "hash";
        Annotation a = new Annotation();
        a.id = "ann-" + id;
        a.selectedText = "text";
        a.comment = "comment";
        batch.annotations.add(a);
        return batch;
    }

    @Test
    public void test500BatchesEvictionTiers() {
        MarkdownReviewService service = new MarkdownReviewService(null);

        // Pre-fill 500 batches: 250 sent (terminal), 250 pending
        for (int i = 0; i < 250; i++) {
            ReviewBatch terminal = createBatch("term-" + i, "active-target", "sent");
            service.saveBatch(terminal);
        }
        for (int i = 0; i < 250; i++) {
            ReviewBatch pending = createBatch("pending-" + i, "active-target", "pending");
            service.saveBatch(pending);
        }

        assertEquals(500, service.snapshotState().batches.size());

        // Now save batch #501. It must evict the oldest terminal batch ("term-0")
        ReviewBatch newBatch = createBatch("new-batch", "active-target", "pending");
        service.saveBatch(newBatch);

        assertEquals(500, service.snapshotState().batches.size());
        boolean hasTerm0 = service.snapshotState().batches.stream().anyMatch(b -> b.id.equals("term-0"));
        assertFalse("Oldest terminal batch must be evicted first (Tier 1)", hasTerm0);
        boolean hasNew = service.snapshotState().batches.stream().anyMatch(b -> b.id.equals("new-batch"));
        assertTrue("New batch must be saved", hasNew);
    }

    @Test
    public void testImpactConsumptionCycle() {
        MarkdownReviewService service = new MarkdownReviewService(null);

        // Null document returns NONE
        assertEquals(MarkdownReviewService.EditImpact.NONE, service.consumeImpact(null));
    }
}
