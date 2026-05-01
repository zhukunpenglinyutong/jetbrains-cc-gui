package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.settings.TabStateService;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.ui.content.Content;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

/**
 * Builds a safe session-state snapshot for newly created tabs.
 * New tabs inherit configuration, but do not inherit conversation sessionId.
 */
public final class TabSessionStateInheritor {

    private TabSessionStateInheritor() {
    }

    /**
     * Capture inheritance state from the currently selected chat tab.
     * Falls back to the legacy single-window mapping when selected tab mapping is unavailable.
     */
    @Nullable
    public static TabStateService.TabSessionState captureForNewTab(
            @NotNull Project project,
            @Nullable ToolWindow toolWindow
    ) {
        ClaudeChatWindow sourceWindow = null;
        if (toolWindow != null) {
            Content selectedContent = toolWindow.getContentManager().getSelectedContent();
            sourceWindow = ClaudeSDKToolWindow.getChatWindowForContent(selectedContent);
        }
        if (sourceWindow == null) {
            sourceWindow = ClaudeSDKToolWindow.getChatWindow(project);
        }
        return captureForNewTab(sourceWindow);
    }

    /**
     * Capture inheritance state directly from a chat window.
     */
    @Nullable
    public static TabStateService.TabSessionState captureForNewTab(@Nullable ClaudeChatWindow sourceWindow) {
        if (sourceWindow == null) {
            return null;
        }
        return captureForNewTab(sourceWindow.getSession());
    }

    /**
     * Capture inheritance state directly from a session.
     */
    @Nullable
    public static TabStateService.TabSessionState captureForNewTab(@Nullable ClaudeSession sourceSession) {
        if (sourceSession == null) {
            return null;
        }

        TabStateService.TabSessionState inherited = new TabStateService.TabSessionState();
        inherited.provider = sourceSession.getProvider();
        inherited.model = sourceSession.getModel();
        inherited.permissionMode = sourceSession.getPermissionMode();
        inherited.reasoningEffort = sourceSession.getReasoningEffort();
        inherited.cwd = sourceSession.getCwd();

        // Keep a fresh conversation identity for the new tab.
        inherited.sessionId = null;
        return inherited;
    }
}
