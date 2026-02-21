package com.github.claudecodegui;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentManager;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.Map;

/**
 * Manages code snippet delivery to chat windows across tabs.
 * Handles external code snippet injection (from context menu),
 * tab selection routing, and retry logic.
 */
public class CodeSnippetManager {

    private static final Logger LOG = Logger.getInstance(CodeSnippetManager.class);

    private final Map<Project, ClaudeChatWindow> instances;
    private final Map<Content, ClaudeChatWindow> contentToWindowMap;

    public CodeSnippetManager(
            Map<Project, ClaudeChatWindow> instances,
            Map<Content, ClaudeChatWindow> contentToWindowMap
    ) {
        this.instances = instances;
        this.contentToWindowMap = contentToWindowMap;
    }

    /**
     * Add code snippet from external source (context menu).
     * Sends code to the currently selected tab.
     */
    public void addSelectionFromExternal(Project project, String selectionInfo) {
        if (project == null) {
            LOG.error("project is null");
            return;
        }

        // Try to get the currently selected tab's window first
        ClaudeChatWindow window = getSelectedTabWindow(project);

        // Fallback to instances map if no selected tab window found
        if (window == null) {
            window = instances.get(project);
        }

        if (window == null) {
            // If no window instance exists, open the tool window automatically
            LOG.info("Window instance not found, opening tool window automatically: " + project.getName());
            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                    if (toolWindow != null) {
                        toolWindow.show(null);
                        scheduleCodeSnippetRetry(project, selectionInfo, 3);
                    } else {
                        LOG.error("Cannot find CCG tool window");
                    }
                } catch (Exception e) {
                    LOG.error("Error opening tool window: " + e.getMessage());
                }
            });
            return;
        }

        if (window.isDisposed()) {
            if (window.getParentContent() != null) {
                contentToWindowMap.remove(window.getParentContent());
            }
            instances.remove(project);
            return;
        }

        if (!window.isInitialized()) {
            scheduleCodeSnippetRetry(project, selectionInfo, 3);
            return;
        }

        window.addCodeSnippetFromExternal(selectionInfo);
    }

    /**
     * Get the ClaudeChatWindow for the currently selected tab.
     */
    private ClaudeChatWindow getSelectedTabWindow(Project project) {
        if (project == null || project.isDisposed()) {
            return null;
        }

        try {
            ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
            if (toolWindow == null) {
                return null;
            }

            ContentManager contentManager = toolWindow.getContentManager();
            Content selectedContent = contentManager.getSelectedContent();

            if (selectedContent != null) {
                ClaudeChatWindow window = contentToWindowMap.get(selectedContent);
                if (window != null) {
                    LOG.debug("[MultiTab] Found window for selected tab: " + selectedContent.getDisplayName());
                    return window;
                }
            }
        } catch (Exception e) {
            LOG.debug("[MultiTab] Failed to get selected tab window: " + e.getMessage());
        }

        return null;
    }

    /**
     * Schedule code snippet addition with retry mechanism.
     * Uses exponential backoff (200ms, 400ms, 800ms).
     */
    private void scheduleCodeSnippetRetry(Project project, String selectionInfo, int retriesLeft) {
        if (retriesLeft <= 0) {
            LOG.warn("Failed to add code snippet after max retries");
            return;
        }

        int delay = 200 * (int) Math.pow(2, 3 - retriesLeft);

        AppExecutorUtil.getAppScheduledExecutorService().schedule(() -> {
            ApplicationManager.getApplication().invokeLater(() -> {
                if (project.isDisposed()) {
                    return;
                }

                ClaudeChatWindow retryWindow = getSelectedTabWindow(project);

                if (retryWindow == null) {
                    retryWindow = instances.get(project);
                }

                if (retryWindow != null && retryWindow.isInitialized() && !retryWindow.isDisposed()) {
                    retryWindow.addCodeSnippetFromExternal(selectionInfo);
                } else {
                    LOG.debug("Window not ready, retrying (retries left: " + (retriesLeft - 1) + ")");
                    scheduleCodeSnippetRetry(project, selectionInfo, retriesLeft - 1);
                }
            });
        }, delay, java.util.concurrent.TimeUnit.MILLISECONDS);
    }
}
