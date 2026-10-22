package com.github.claudecodegui.markdown;

import com.intellij.testFramework.LightVirtualFile;
import org.junit.Test;
import static org.junit.Assert.*;

public class MarkdownCompletionTest {
    @Test
    public void completionPersistsAndMissingSourceCannotBeListed() {
        var file = new LightVirtualFile("plan.md");
        var service = new MarkdownReviewService(null);
        var state = service.snapshotState();
        state.config.persist = true;
        var annotation = new Annotation();
        annotation.id = "000a";
        annotation.fileUrl = file.getUrl();
        state.annotations.add(annotation);
        service.loadState(state);
        var config = service.getConfig();
        config.persist = false;
        service.configure(config);
        service.complete(file, "000a", 1, true);
        assertTrue(service.getConfig().persist);
        var restored = new MarkdownReviewService(null);
        restored.loadState(service.getState());
        assertTrue(restored.list(file).get(0).completed);
        restored.complete(file, "000a", 2, false);
        assertFalse(restored.list(file).get(0).completed);
        state = restored.snapshotState();
        state.annotations.get(0).sourceMissing = true;
        restored.loadState(state);
        assertTrue(restored.list(file).isEmpty());
        assertEquals(1, restored.snapshotState().annotations.size());
    }
}
