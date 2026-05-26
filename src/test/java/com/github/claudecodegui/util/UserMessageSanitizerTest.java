package com.github.claudecodegui.util;

import org.junit.Test;

import static org.junit.Assert.assertEquals;

public class UserMessageSanitizerTest {

    @Test
    public void stripsOpenedFilesContextFromHistoryReplayText() {
        String original = "帮我看下这个问题\n\n## Opened Files Context\n\n[{\"path\":\"/tmp/App.java\"}]";

        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(original);

        assertEquals("帮我看下这个问题", sanitized);
    }
}
