package com.github.claudecodegui;

import com.intellij.openapi.actionSystem.ActionUpdateThread;
import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.jcef.JBCefBrowser;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import java.awt.*;

/**
 * Action to open JCEF DevTools for the current chat window.
 */
public class OpenDevToolsAction extends AnAction {

    private static final Logger LOG = Logger.getInstance(OpenDevToolsAction.class);

    @Override
    public @NotNull ActionUpdateThread getActionUpdateThread() {
        return ActionUpdateThread.BGT;
    }

    @Override
    public void update(@NotNull AnActionEvent e) {
        e.getPresentation().setEnabled(e.getProject() != null);
    }

    @Override
    public void actionPerformed(@NotNull AnActionEvent e) {
        Project project = e.getProject();
        if (project == null) {
            return;
        }

        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow == null) {
            return;
        }

        Content selectedContent = toolWindow.getContentManager().getSelectedContent();
        if (selectedContent == null) {
            return;
        }

        JComponent component = selectedContent.getComponent();
        JBCefBrowser browser = findBrowser(component);
        if (browser != null) {
            browser.openDevtools();
            LOG.info("[OpenDevToolsAction] Opened DevTools");
        }
    }

    private JBCefBrowser findBrowser(Component component) {
        if (component instanceof JComponent) {
            Object browserInstance = ((JComponent) component).getClientProperty("JBCefBrowser.instance");
            if (browserInstance instanceof JBCefBrowser) {
                return (JBCefBrowser) browserInstance;
            }
        }

        if (component instanceof Container) {
            for (Component child : ((Container) component).getComponents()) {
                JBCefBrowser found = findBrowser(child);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }
}
