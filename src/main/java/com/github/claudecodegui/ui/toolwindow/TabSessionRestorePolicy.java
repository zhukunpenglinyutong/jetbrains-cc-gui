package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.settings.TabStateService;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;

final class TabSessionRestorePolicy {

    private TabSessionRestorePolicy() {
    }

    static boolean shouldLoadHistory(TabStateService.TabSessionState savedState) {
        return savedState != null && isNonEmpty(savedState.sessionId);
    }

    static boolean matchesProjectIdentity(
            TabStateService.TabSessionState savedState,
            String currentProjectPath,
            String currentWorkingDirectory
    ) {
        if (savedState == null) {
            return false;
        }

        if (isNonEmpty(savedState.projectPath)) {
            return samePath(savedState.projectPath, currentProjectPath);
        }

        // Older tab state has no projectPath; use its saved cwd as a compatibility guard.
        return samePath(savedState.cwd, currentWorkingDirectory);
    }

    static String normalizeProjectPath(String projectPath) {
        if (!isNonEmpty(projectPath)) {
            return null;
        }
        return PathUtils.realPath(PathUtils.normalizeAbsolute(projectPath));
    }

    static boolean shouldLoadImmediately(TabStateService.TabSessionState savedState, boolean selectedTab) {
        return selectedTab && shouldLoadHistory(savedState);
    }

    static boolean shouldStartHistoryLoad(TabStateService.TabSessionState savedState, boolean frontendReady) {
        return frontendReady && shouldLoadHistory(savedState);
    }

    private static boolean samePath(String left, String right) {
        String normalizedLeft = normalizeProjectPath(left);
        String normalizedRight = normalizeProjectPath(right);
        if (normalizedLeft == null || normalizedRight == null) {
            return false;
        }
        return PlatformUtils.isWindows()
                ? normalizedLeft.equalsIgnoreCase(normalizedRight)
                : normalizedLeft.equals(normalizedRight);
    }

    private static boolean isNonEmpty(String value) {
        return value != null && !value.trim().isEmpty();
    }
}
