package com.github.claudecodegui.markdown;

import org.junit.Test;
import static org.junit.Assert.*;

public class NativeMarkdownExtensionProviderTest {
    @Test
    public void createsTheBridgeOnlyWhenAnnotationsAreEnabled() {
        MarkdownReviewConfig disabled = new MarkdownReviewConfig();
        assertFalse(NativeMarkdownExtensionProvider.shouldCreate(disabled));
        MarkdownReviewConfig enabled = new MarkdownReviewConfig();
        enabled.enabled = true;
        assertTrue(NativeMarkdownExtensionProvider.shouldCreate(enabled));
    }
}
