package com.github.claudecodegui;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import org.jetbrains.annotations.NotNull;


/**
 * Action to create a new chat tab in the Claude Code GUI tool window
 */
public class CreateNewTabAction extends AnAction {

    private static final Logger LOG = Logger.getInstance(CreateNewTabAction.class);

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            LOG.error("[CreateNewTabAction] Project is null");
            return;
        }

        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            LOG.error("[CreateNewTabAction] Tool window not found");
            return;
        }

        // Create a new chat window instance with skipRegister=true (don't replace the main instance)
        ClaudeSDKToolWindow.ClaudeChatWindow newChatWindow = new ClaudeSDKToolWindow.ClaudeChatWindow(project, true);

        // Create a tab name in the format "AIN"
        String tabName = ClaudeSDKToolWindow.getNextTabName(toolWindow);

        // Create and add the new tab content
        ContentFactory contentFactory = ContentFactory.getInstance();
        Content content = contentFactory.createContent(newChatWindow.getContent(), tabName, false);
        content.setCloseable(true);
        newChatWindow.setParentContent(content);

        ContentManager contentManager = toolWindow.getContentManager();
        contentManager.addContent(content);
        contentManager.setSelectedContent(content);

        // Ensure the tool window is visible
        toolWindow.show(null);

        LOG.info("[CreateNewTabAction] Created new tab: " + tabName);
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        // Only enable this action when there's a valid project
        e.getPresentation().setEnabled(e.getProject() != null);
    }
}
