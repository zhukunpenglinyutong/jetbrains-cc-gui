package com.github.claudecodegui.settings;

import com.intellij.util.xmlb.XmlSerializer;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class TabStateServiceTest {
    /** Unread belongs to a session snapshot and survives copying and project XML reload. */
    @Test
    public void preservesUnreadAcrossSnapshotCopiesAndProjectRestart() {
        TabStateService service = new TabStateService();
        TabStateService.TabSessionState session = new TabStateService.TabSessionState();
        session.sessionId = "unread-session";
        session.unread = true;
        service.saveTabSessionState(0, session);
        session.unread = false;
        assertTrue(service.getTabSessionState(0).unread);
        TabStateService restored = new TabStateService();
        restored.loadState(XmlSerializer.deserialize(
                XmlSerializer.serialize(service.getState()), TabStateService.State.class));
        assertTrue(restored.getTabSessionState(0).unread);
    }

    /** Existing installations have no selected index and keep the first-tab fallback. */
    @Test
    public void legacyStateDefaultsToTheFirstTab() {
        assertEquals(0, new TabStateService().getSelectedTabIndex());
    }

    /** Verify the actual XML state format preserves selection across IDE restarts. */
    @Test
    public void restoresSelectionFromSerializedProjectState() {
        TabStateService service = new TabStateService();
        service.saveTabCount(4);
        service.saveSelectedTabIndex(3);
        TabStateService restored = new TabStateService();
        restored.loadState(XmlSerializer.deserialize(
                XmlSerializer.serialize(service.getState()), TabStateService.State.class));
        assertEquals(4, restored.getTabCount());
        assertEquals(3, restored.getSelectedTabIndex());
    }

    /** Closing an earlier tab must keep the selected conversation, including its session binding. */
    @Test
    public void closingEarlierTabKeepsTheSameConversationSelected() {
        TabStateService service = new TabStateService();
        service.saveTabCount(4);
        service.saveSelectedTabIndex(3);
        TabStateService.TabSessionState session = new TabStateService.TabSessionState();
        session.sessionId = "selected-session";
        service.saveTabSessionState(3, session);
        service.onTabRemoved(1);
        assertEquals(2, service.getSelectedTabIndex());
        assertEquals("selected-session", service.getTabSessionState(2).sessionId);
    }

    /** Closing the last selected tab falls back to the nearest surviving tab. */
    @Test
    public void closingSelectedLastTabClampsToThePreviousTab() {
        TabStateService service = new TabStateService();
        service.saveTabCount(3);
        service.saveSelectedTabIndex(2);
        service.onTabRemoved(2);
        assertEquals(1, service.getSelectedTabIndex());
        service.onTabRemoved(1);
        assertEquals(0, service.getSelectedTabIndex());
    }

    /** Stale or damaged selection must not index beyond the restored content array. */
    @Test
    public void clampsStoredAndNewSelectionsToSurvivingTabs() {
        TabStateService service = new TabStateService();
        TabStateService.State state = new TabStateService.State();
        state.tabCount = 3;
        state.selectedTabIndex = 30;
        service.loadState(state);
        assertEquals(2, service.getSelectedTabIndex());
        service.saveSelectedTabIndex(-1);
        assertEquals(0, service.getSelectedTabIndex());
    }

    /** Clearing saved workspace state also clears its selection. */
    @Test
    public void clearingWorkspaceResetsSelection() {
        TabStateService service = new TabStateService();
        service.saveTabCount(3);
        service.saveSelectedTabIndex(2);
        service.clearAllTabNames();
        assertEquals(0, service.getSelectedTabIndex());
    }
}
