package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.settings.TabStateService;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertEquals;

public class TabSessionRestorePolicyTest {

    @Test
    public void shouldLoadHistoryForPersistedSessionId() {
        TabStateService.TabSessionState savedState = new TabStateService.TabSessionState();
        savedState.sessionId = "session-123";

        assertTrue(TabSessionRestorePolicy.shouldLoadHistory(savedState));
    }

    @Test
    public void shouldNotLoadHistoryWithoutPersistedSessionId() {
        TabStateService.TabSessionState savedState = new TabStateService.TabSessionState();
        savedState.cwd = "/workspace";

        assertFalse(TabSessionRestorePolicy.shouldLoadHistory(savedState));
        assertFalse(TabSessionRestorePolicy.shouldLoadHistory(null));
    }

    @Test
    public void shouldLoadImmediatelyOnlyForSelectedTabsWithHistory() {
        TabStateService.TabSessionState savedState = new TabStateService.TabSessionState();
        savedState.sessionId = "session-123";

        assertTrue(TabSessionRestorePolicy.shouldLoadImmediately(savedState, true));
        assertFalse(TabSessionRestorePolicy.shouldLoadImmediately(savedState, false));
    }

    @Test
    public void shouldExposeDeferredRestoreSessionIdOnlyForPersistedSessions() {
        TabStateService.TabSessionState savedState = new TabStateService.TabSessionState();
        savedState.sessionId = " session-123 ";

        assertEquals("session-123", TabSessionRestorePolicy.getDeferredRestoreSessionId(savedState));
        assertNull(TabSessionRestorePolicy.getDeferredRestoreSessionId(new TabStateService.TabSessionState()));
    }

    @Test
    public void shouldOnlyLoadDeferredHistoryWhenCurrentSessionMatchesPersistedRestoreSession() {
        assertTrue(TabSessionRestorePolicy.shouldLoadDeferredHistory("session-123", "session-123"));
        assertFalse(TabSessionRestorePolicy.shouldLoadDeferredHistory("session-123", "session-456"));
        assertFalse(TabSessionRestorePolicy.shouldLoadDeferredHistory(null, "session-123"));
    }
}
