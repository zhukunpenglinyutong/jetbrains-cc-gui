package com.github.claudecodegui.settings;

import com.intellij.openapi.components.*;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import java.util.HashMap;
import java.util.Map;

/**
 * Tab State Persistence Service.
 * Saves and restores custom tab names plus per-tab session binding state.
 */
@State(
    name = "ClaudeCodeTabState",
    storages = @Storage("claudeCodeTabState.xml")
)
@Service(Service.Level.PROJECT)
public final class TabStateService implements PersistentStateComponent<TabStateService.State> {

    private static final Logger LOG = Logger.getInstance(TabStateService.class);

    private State myState = new State();

    public static TabStateService getInstance(@NotNull Project project) {
        return project.getService(TabStateService.class);
    }

    @Override
    public @Nullable State getState() {
        return myState;
    }

    @Override
    public void loadState(@NotNull State state) {
        myState = state;
        if (myState.tabNames == null) {
            myState.tabNames = new HashMap<>();
        }
        if (myState.tabSessions == null) {
            myState.tabSessions = new HashMap<>();
        }
        LOG.info("[TabStateService] Loaded tab state with " + myState.tabNames.size()
                + " tab names and " + myState.tabSessions.size() + " tab sessions");
    }

    /**
     * Save a tab name.
     * @param tabIndex the tab index
     * @param tabName the tab name
     */
    public void saveTabName(int tabIndex, String tabName) {
        if (tabName != null && !tabName.trim().isEmpty()) {
            myState.tabNames.put(tabIndex, tabName);
            LOG.info("[TabStateService] Saved tab name: index=" + tabIndex + ", name=" + tabName);
        }
    }

    /**
     * Get a tab name.
     * @param tabIndex the tab index
     * @return the tab name, or null if not set
     */
    @Nullable
    public String getTabName(int tabIndex) {
        return myState.tabNames.get(tabIndex);
    }

    /**
     * Save or update session binding state for a tab.
     */
    public void saveTabSessionState(int tabIndex, @Nullable TabSessionState sessionState) {
        if (sessionState == null) {
            myState.tabSessions.remove(tabIndex);
            LOG.info("[TabStateService] Cleared tab session state: index=" + tabIndex);
            return;
        }
        myState.tabSessions.put(tabIndex, sessionState.copy());
        LOG.info("[TabStateService] Saved tab session state: index=" + tabIndex
                + ", provider=" + sessionState.provider
                + ", sessionId=" + sessionState.sessionId
                + ", cwd=" + sessionState.cwd + ")");
    }

    /**
     * Get session binding state for a tab.
     */
    @Nullable
    public TabSessionState getTabSessionState(int tabIndex) {
        TabSessionState state = myState.tabSessions.get(tabIndex);
        return state != null ? state.copy() : null;
    }

    /**
     * Remove a tab name and session state.
     * @param tabIndex the tab index
     */
    public void removeTabName(int tabIndex) {
        myState.tabNames.remove(tabIndex);
        myState.tabSessions.remove(tabIndex);
        LOG.info("[TabStateService] Removed tab state for index: " + tabIndex);
    }

    /**
     * Get all tab names.
     * @return a map from tab index to tab name
     */
    public Map<Integer, String> getAllTabNames() {
        return new HashMap<>(myState.tabNames);
    }

    /**
     * Clear all tab names and session state.
     */
    public void clearAllTabNames() {
        myState.tabNames.clear();
        myState.tabSessions.clear();
        LOG.info("[TabStateService] Cleared all tab names and session state");
    }

    /**
     * Update tab indexes when a tab is removed (re-maps all indexes accordingly).
     * @param removedIndex the index of the removed tab
     */
    public void onTabRemoved(int removedIndex) {
        myState.tabNames.remove(removedIndex);
        myState.tabSessions.remove(removedIndex);

        Map<Integer, String> newTabNames = new HashMap<>();
        for (Map.Entry<Integer, String> entry : myState.tabNames.entrySet()) {
            int oldIndex = entry.getKey();
            if (oldIndex > removedIndex) {
                newTabNames.put(oldIndex - 1, entry.getValue());
            } else {
                newTabNames.put(oldIndex, entry.getValue());
            }
        }
        myState.tabNames = newTabNames;

        Map<Integer, TabSessionState> newTabSessions = new HashMap<>();
        for (Map.Entry<Integer, TabSessionState> entry : myState.tabSessions.entrySet()) {
            int oldIndex = entry.getKey();
            if (oldIndex > removedIndex) {
                newTabSessions.put(oldIndex - 1, entry.getValue());
            } else {
                newTabSessions.put(oldIndex, entry.getValue());
            }
        }
        myState.tabSessions = newTabSessions;

        if (myState.tabCount > 0) {
            myState.tabCount--;
        }

        LOG.info("[TabStateService] Updated tab indexes after removal of index: " + removedIndex
                + ", new count: " + myState.tabCount);
    }

    /**
     * Save the tab count.
     * @param count the number of tabs
     */
    public void saveTabCount(int count) {
        myState.tabCount = count;
        LOG.info("[TabStateService] Saved tab count: " + count);
    }

    /**
     * Get the tab count.
     * @return the number of tabs, defaults to 1
     */
    public int getTabCount() {
        return Math.max(1, myState.tabCount);
    }

    /**
     * Per-tab persisted session snapshot.
     */
    public static class TabSessionState {
        public String provider;
        public String sessionId;
        public String cwd;
        public String model;
        public String permissionMode;
        public String reasoningEffort;

        public TabSessionState copy() {
            TabSessionState copy = new TabSessionState();
            copy.provider = this.provider;
            copy.sessionId = this.sessionId;
            copy.cwd = this.cwd;
            copy.model = this.model;
            copy.permissionMode = this.permissionMode;
            copy.reasoningEffort = this.reasoningEffort;
            return copy;
        }
    }

    /**
     * Persistent state class.
     */
    public static class State {
        /**
         * Map from tab index to tab name.
         */
        public Map<Integer, String> tabNames = new HashMap<>();

        /**
         * Map from tab index to tab session state.
         */
        public Map<Integer, TabSessionState> tabSessions = new HashMap<>();

        /**
         * Number of tabs.
         */
        public int tabCount = 1;
    }
}
