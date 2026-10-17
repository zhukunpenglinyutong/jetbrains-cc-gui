package com.github.claudecodegui.markdown;

import org.junit.Test;
import static org.junit.Assert.*;

public class MarkdownAnnotationIdTest {
    @Test
    public void idsStartAtFourCharactersPersistAndGrowWithoutReuse() {
        var service = new MarkdownReviewService(null);
        assertEquals("0000", service.nextAnnotationId());
        for (int i = 1; i < 10; i++) service.nextAnnotationId();
        assertEquals("000a", service.nextAnnotationId());
        var restored = new MarkdownReviewService(null);
        restored.loadState(service.getState());
        assertEquals("000b", restored.nextAnnotationId());
        var state = restored.snapshotState();
        state.nextAnnotationId = 36L * 36 * 36 * 36 - 1;
        restored.loadState(state);
        assertEquals("zzzz", restored.nextAnnotationId());
        assertEquals("10000", restored.nextAnnotationId());
    }
}
