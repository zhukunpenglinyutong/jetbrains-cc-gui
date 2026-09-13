package com.github.claudecodegui.ui.toolwindow;

import org.junit.Assert;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Regression tests for structured file-reference buffering before WebView readiness. */
public class PendingFileReferencesBufferTest {

    @Test
    public void offerEmitsImmutableSnapshotWhenFrontendIsReady() {
        PendingFileReferencesBuffer buffer = new PendingFileReferencesBuffer();
        List<String> paths = new ArrayList<>(Arrays.asList(
                "C:\\Program Files\\demo\\view file.xml",
                "\\\\server\\share\\index.vue"
        ));

        List<String> emitted = buffer.offer(paths, true);
        paths.set(0, "changed");

        Assert.assertEquals("C:\\Program Files\\demo\\view file.xml", emitted.get(0));
        try {
            emitted.add("another");
            Assert.fail("buffer payload should be immutable");
        } catch (UnsupportedOperationException expected) {
            // Expected: delivery must not be mutable after it leaves the buffer.
        }
        Assert.assertNull(buffer.takePending());
    }

    @Test
    public void deferredBatchIsFlushedOnlyOnce() {
        PendingFileReferencesBuffer buffer = new PendingFileReferencesBuffer();
        List<String> paths = Arrays.asList("/workspace/src/index.vue");

        Assert.assertNull(buffer.offer(paths, false));
        Assert.assertEquals(paths, buffer.takePending());
        Assert.assertNull(buffer.takePending());
    }

    @Test
    public void deferredBatchesAreCombinedInDeliveryOrder() {
        PendingFileReferencesBuffer buffer = new PendingFileReferencesBuffer();

        Assert.assertNull(buffer.offer(Arrays.asList("C:\\first.xml"), false));
        Assert.assertNull(buffer.offer(Arrays.asList("C:\\second.vue", "C:\\third.html"), false));

        Assert.assertEquals(
                Arrays.asList("C:\\first.xml", "C:\\second.vue", "C:\\third.html"),
                buffer.takePending()
        );
        Assert.assertNull(buffer.takePending());
    }
}
