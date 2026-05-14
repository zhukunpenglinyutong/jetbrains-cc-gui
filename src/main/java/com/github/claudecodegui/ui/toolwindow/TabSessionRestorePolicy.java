package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.settings.TabStateService;

final class TabSessionRestorePolicy {

    private TabSessionRestorePolicy() {
    }

    static boolean shouldLoadHistory(TabStateService.TabSessionState savedState) {
        return savedState != null && isNonEmpty(savedState.sessionId);
    }

    static boolean shouldLoadImmediately(TabStateService.TabSessionState savedState, boolean selectedTab) {
        return selectedTab && shouldLoadHistory(savedState);
    }

    static String getDeferredRestoreSessionId(TabStateService.TabSessionState savedState) {
        if (!shouldLoadHistory(savedState)) {
            return null;
        }
        return savedState.sessionId.trim();
    }

    static boolean shouldLoadDeferredHistory(String deferredSessionId, String currentSessionId) {
        return isNonEmpty(deferredSessionId) && deferredSessionId.equals(currentSessionId);
    }

    private static boolean isNonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }
}
