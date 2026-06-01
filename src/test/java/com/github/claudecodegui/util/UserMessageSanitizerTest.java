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

    @Test
    public void stripsPrependedAgentInstructionsAndEnvironmentContext() {
        String original = "# AGENTS.md instructions for D:\\project\\demo\n\n"
                + "<INSTRUCTIONS>\n"
                + "请默认使用中文（简体）回复。\n"
                + "</INSTRUCTIONS>"
                + "<environment_context>\n"
                + "  <cwd>D:\\project\\demo</cwd>\n"
                + "</environment_context>"
                + "请帮我修复这个问题";

        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(original);

        assertEquals("请帮我修复这个问题", sanitized);
    }

    @Test
    public void stripsImageAttachmentInstructionsFromUserFacingText() {
        String original = "请分析这张图\n\n"
                + "The user has attached the image(s) above. Please use the Read tool to view them.\n\n"
                + "Use the Read tool to inspect this image file, then answer using its visible content: "
                + "C:\\Users\\me\\AppData\\Local\\Temp\\upload.png";

        String sanitized = UserMessageSanitizer.sanitizeUserFacingText(original);

        assertEquals("请分析这张图", sanitized);
    }
}
