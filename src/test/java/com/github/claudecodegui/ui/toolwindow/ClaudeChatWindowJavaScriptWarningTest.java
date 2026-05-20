package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeChatWindowJavaScriptWarningTest {

    @Test
    public void buildUnescapedJavaScriptArgumentWarningDoesNotIncludeRawArgumentPreview() {
        String warning = ClaudeChatWindow.buildUnescapedJavaScriptArgumentWarning(
                "addErrorMessage",
                "password=secret-token\n'raw user prompt'"
        );

        assertTrue(warning.contains("addErrorMessage"));
        assertTrue(warning.contains("length="));
        assertFalse(warning.contains("Preview:"));
        assertFalse(warning.contains("password=secret-token"));
        assertFalse(warning.contains("raw user prompt"));
    }

    @Test
    public void buildWebviewConsoleLogMessageDoesNotIncludeRawArguments() {
        String message = ClaudeChatWindow.buildWebviewConsoleLogMessage(
                "console.error",
                "password=secret-token",
                "raw user prompt"
        );

        assertTrue(message.contains("console.error"));
        assertTrue(message.contains("args=2"));
        assertFalse(message.contains("password=secret-token"));
        assertFalse(message.contains("raw user prompt"));
    }
}
