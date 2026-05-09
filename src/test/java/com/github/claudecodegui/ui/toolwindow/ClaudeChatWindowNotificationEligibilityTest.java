package com.github.claudecodegui.ui.toolwindow;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class ClaudeChatWindowNotificationEligibilityTest {

    @Test
    public void shouldAllowNotificationForClaudeProviderWithoutError() {
        assertTrue(ClaudeChatWindow.shouldShowTaskCompletionNotification("claude", null));
    }

    @Test
    public void shouldAllowNotificationForCodexProviderWithoutError() {
        assertTrue(ClaudeChatWindow.shouldShowTaskCompletionNotification("codex", null));
    }

    @Test
    public void shouldRejectNotificationWhenProviderIsBlank() {
        assertFalse(ClaudeChatWindow.shouldShowTaskCompletionNotification("   ", null));
    }

    @Test
    public void shouldRejectNotificationWhenSessionHasError() {
        assertFalse(ClaudeChatWindow.shouldShowTaskCompletionNotification("codex", "boom"));
    }

    @Test
    public void shouldRejectNotificationWhenSessionIsNull() {
        assertFalse(ClaudeChatWindow.shouldShowTaskCompletionNotification(null));
    }
}
