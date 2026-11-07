package com.github.claudecodegui.action.tab;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.ContentManager;
import org.jetbrains.annotations.NotNull;

/** Resolves the selected tab from native IDE state, without relying on the frozen page's controls. */
public final class RecoverViewAction extends AnAction implements DumbAware {
    public RecoverViewAction() {
        super(ClaudeCodeGuiBundle.message("action.recoverView.text"),
                ClaudeCodeGuiBundle.message("action.recoverView.description"), null);
    }

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.EDT;
    }

    private static ClaudeChatWindow selectedWindow(AnActionEvent event) {
        if (event.getProject() == null) {
            return null;
        }
        ToolWindow toolWindow = ToolWindowManager.getInstance(event.getProject())
                .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
        ContentManager manager = toolWindow == null ? null : toolWindow.getContentManagerIfCreated();
        return manager == null ? null : ClaudeSDKToolWindow.getChatWindowForContent(manager.getSelectedContent());
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent event) {
        ClaudeChatWindow window = selectedWindow(event);
        if (window != null) {
            window.recoverCurrentView();
        }
    }

    @Override
    public void update(@NotNull AnActionEvent event) {
        ClaudeChatWindow window = selectedWindow(event);
        event.getPresentation().setEnabledAndVisible(window != null && window.canRecoverCurrentView());
    }
}
