package com.github.claudecodegui;

import com.intellij.ide.ui.LafManager;
import com.intellij.ide.ui.LafManagerListener;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import com.intellij.util.messages.MessageBusConnection;
import com.intellij.util.ui.JBUI;
import com.intellij.util.ui.UIUtil;

import javax.swing.*;
import java.awt.*;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.awt.event.WindowListener;

/**
 * Detached chat window as a standalone JFrame.
 * Allows users to separate a tab from the tool window and use it in a floating window.
 */
public class DetachedChatFrame extends JFrame {

    private static final Logger LOG = Logger.getInstance(DetachedChatFrame.class);

    private final Project project;
    private final ClaudeChatWindow chatWindow;
    private final String originalTabName;
    private final int originalTabIndex;
    private JComponent originalContent;
    private MessageBusConnection themeBusConnection;

    /**
     * Create a detached chat window from an existing Content.
     *
     * @param project The current project
     * @param content The Content to detach
     */
    public DetachedChatFrame(Project project, Content content) {
        super("CCG - " + content.getDisplayName());
        this.project = project;
        this.originalTabName = content.getDisplayName();
        this.chatWindow = ClaudeSDKToolWindow.getChatWindowForContent(content);

        if (chatWindow == null) {
            LOG.error("[DetachedChatFrame] Cannot find ClaudeChatWindow for content: " + originalTabName);
            throw new IllegalStateException("ClaudeChatWindow not found for content");
        }

        // Get original tab index before removing from ContentManager
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
        if (toolWindow != null) {
            ContentManager contentManager = toolWindow.getContentManager();
            this.originalTabIndex = contentManager.getIndexOfContent(content);
        } else {
            this.originalTabIndex = -1;
        }

        // Store the original content component
        this.originalContent = chatWindow.getContent();

        setupUI();
        setupWindowListeners();
        applyIdeTheme();

        LOG.info("[DetachedChatFrame] Created detached window for: " + originalTabName);
    }

    /**
     * Setup the UI components for the detached window.
     */
    private void setupUI() {
        // Set window icon (use PNG since ImageIcon doesn't support SVG)
        try {
            java.net.URL iconUrl = getClass().getResource("/icons/logo-16.png");
            if (iconUrl != null) {
                setIconImage(new ImageIcon(iconUrl).getImage());
            }
        } catch (Exception e) {
            LOG.warn("[DetachedChatFrame] Failed to load window icon", e);
        }

        // Create main panel with BorderLayout
        JPanel mainPanel = new JPanel(new BorderLayout());

        // Add toolbar at the top
        JPanel toolbar = createToolbar();
        mainPanel.add(toolbar, BorderLayout.NORTH);

        // Add chat content in the center
        mainPanel.add(originalContent, BorderLayout.CENTER);

        setContentPane(mainPanel);

        // Set window size and position
        setSize(1200, 800);
        setLocationRelativeTo(null); // Center on screen

        // Make window resizable
        setResizable(true);
    }

    /**
     * Create the toolbar with action buttons.
     */
    private JPanel createToolbar() {
        JPanel toolbar = new JPanel(new FlowLayout(FlowLayout.LEFT, 10, 5));
        toolbar.setBorder(JBUI.Borders.empty(5));

        // Reattach button
        JButton reattachBtn = new JButton(ClaudeCodeGuiBundle.message("detachedWindow.reattach"));
        reattachBtn.setToolTipText(ClaudeCodeGuiBundle.message("detachedWindow.reattach.tooltip"));
        reattachBtn.addActionListener(e -> reattachToToolWindow());
        toolbar.add(reattachBtn);

        return toolbar;
    }

    /**
     * Setup window event listeners.
     */
    private void setupWindowListeners() {
        setDefaultCloseOperation(JFrame.DO_NOTHING_ON_CLOSE);

        addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent e) {
                onWindowClosing();
            }
        });
    }

    /**
     * Apply IDE theme to the window and listen for theme changes.
     */
    private void applyIdeTheme() {
        updateThemeColors();

        // Listen for IDE theme changes to keep the detached window in sync
        themeBusConnection = ApplicationManager.getApplication().getMessageBus().connect();
        themeBusConnection.subscribe(LafManagerListener.TOPIC, source ->
            ApplicationManager.getApplication().invokeLater(this::updateThemeColors)
        );
    }

    /**
     * Update the window colors to match the current IDE theme.
     */
    private void updateThemeColors() {
        if (!isDisplayable()) return;

        getContentPane().setBackground(UIUtil.getPanelBackground());

        // Update toolbar background
        Container contentPane = getContentPane();
        if (contentPane instanceof JPanel) {
            for (Component comp : ((JPanel) contentPane).getComponents()) {
                if (comp instanceof JPanel) {
                    comp.setBackground(UIUtil.getPanelBackground());
                }
            }
        }

        getContentPane().repaint();
    }

    /**
     * Handle window closing event.
     * Ask user whether to reattach to tool window or destroy the session.
     */
    private void onWindowClosing() {
        // If project is already disposed, just clean up the session
        if (project.isDisposed()) {
            disposeSession();
            return;
        }

        int choice = Messages.showYesNoCancelDialog(
                project,
                ClaudeCodeGuiBundle.message("detachedWindow.close.message"),
                ClaudeCodeGuiBundle.message("detachedWindow.close.title"),
                ClaudeCodeGuiBundle.message("detachedWindow.close.reattach"),
                ClaudeCodeGuiBundle.message("detachedWindow.close.destroy"),
                ClaudeCodeGuiBundle.message("detachedWindow.close.cancel"),
                Messages.getQuestionIcon()
        );

        if (choice == Messages.YES) {
            // Reattach to tool window
            reattachToToolWindow();
        } else if (choice == Messages.NO) {
            // Destroy session
            disposeSession();
        }
        // CANCEL - do nothing
    }

    /**
     * Reattach the chat window to the tool window as a tab.
     */
    public void reattachToToolWindow() {
        LOG.info("[DetachedChatFrame] Reattaching to tool window: " + originalTabName);

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                // If project is disposed, cannot reattach — clean up instead
                if (project.isDisposed()) {
                    LOG.warn("[DetachedChatFrame] Project is disposed, cannot reattach");
                    disposeSession();
                    return;
                }

                ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                if (toolWindow == null) {
                    LOG.error("[DetachedChatFrame] Tool window not found");
                    Messages.showErrorDialog(
                            project,
                            ClaudeCodeGuiBundle.message("detachedWindow.reattach.error.noToolWindow"),
                            ClaudeCodeGuiBundle.message("detachedWindow.reattach.error.title")
                    );
                    return;
                }

                ContentManager contentManager = toolWindow.getContentManager();

                // Remove content from JFrame
                getContentPane().removeAll();

                // Create new Content
                ContentFactory factory = ContentFactory.getInstance();
                Content content = factory.createContent(originalContent, originalTabName, false);
                content.setCloseable(true);
                chatWindow.setParentContent(content);

                // Add back to ContentManager at original index if possible
                if (originalTabIndex >= 0 && originalTabIndex < contentManager.getContentCount()) {
                    contentManager.addContent(content, originalTabIndex);
                } else {
                    contentManager.addContent(content);
                }
                contentManager.setSelectedContent(content);

                // Show the tool window
                toolWindow.show(null);

                // Revalidate and repaint to ensure proper rendering
                originalContent.revalidate();
                originalContent.repaint();

                // Unregister from DetachedWindowManager
                DetachedWindowManager.unregisterDetached(project, chatWindow.getSessionId());

                // Close this window
                dispose();

                LOG.info("[DetachedChatFrame] Successfully reattached: " + originalTabName);
            } catch (Exception e) {
                LOG.error("[DetachedChatFrame] Error reattaching to tool window", e);
                Messages.showErrorDialog(
                        project,
                        ClaudeCodeGuiBundle.message("detachedWindow.reattach.error.failed") + ": " + e.getMessage(),
                        ClaudeCodeGuiBundle.message("detachedWindow.reattach.error.title")
                );
            }
        });
    }

    /**
     * Dispose the session and close the window.
     */
    private void disposeSession() {
        LOG.info("[DetachedChatFrame] Disposing session: " + originalTabName);

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                // Unregister from DetachedWindowManager
                DetachedWindowManager.unregisterDetached(project, chatWindow.getSessionId());

                // Dispose the chat window (this will clean up all resources)
                if (chatWindow != null) {
                    chatWindow.dispose();
                }

                // Sync TabStateService with the actual ContentManager tab count
                // to prevent phantom tabs on next IDE restart
                if (!project.isDisposed()) {
                    try {
                        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                        if (toolWindow != null) {
                            int actualCount = toolWindow.getContentManager().getContentCount();
                            com.github.claudecodegui.settings.TabStateService.getInstance(project)
                                    .saveTabCount(actualCount);
                        }
                    } catch (Exception e) {
                        LOG.warn("[DetachedChatFrame] Failed to sync tab state: " + e.getMessage());
                    }
                }

                // Close this window
                dispose();

                LOG.info("[DetachedChatFrame] Session disposed: " + originalTabName);
            } catch (Exception e) {
                LOG.error("[DetachedChatFrame] Error disposing session", e);
            }
        });
    }

    @Override
    public void dispose() {
        LOG.info("[DetachedChatFrame] Disposing window: " + originalTabName);

        // Disconnect theme change listener
        if (themeBusConnection != null) {
            themeBusConnection.disconnect();
            themeBusConnection = null;
        }

        // Remove all window listeners
        for (WindowListener listener : getWindowListeners()) {
            removeWindowListener(listener);
        }

        // Clear content
        getContentPane().removeAll();

        // Call parent dispose
        super.dispose();
    }

    /**
     * Get the associated ClaudeChatWindow.
     */
    public ClaudeChatWindow getChatWindow() {
        return chatWindow;
    }

    /**
     * Get the original tab name.
     */
    public String getOriginalTabName() {
        return originalTabName;
    }
}
