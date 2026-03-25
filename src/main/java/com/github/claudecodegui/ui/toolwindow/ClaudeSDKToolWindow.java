package com.github.claudecodegui.ui.toolwindow;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.TabStateService;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.ui.detached.DetachedWindowManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import com.intellij.ui.content.ContentManagerEvent;
import com.intellij.ui.content.ContentManagerListener;
import org.jetbrains.annotations.NotNull;

import javax.swing.*;
import java.awt.*;
import java.util.Collections;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Claude SDK chat tool window.
 * Implements DumbAware to allow usage during index building.
 */
public class ClaudeSDKToolWindow implements ToolWindowFactory, DumbAware {

    private static final Logger LOG = Logger.getInstance(ClaudeSDKToolWindow.class);
    public static final String TOOL_WINDOW_ID = "CCG";
    public static final String TOOL_WINDOW_DISPLAY_NAME = "CC GUI";
    private static final Map<Project, ClaudeChatWindow> instances = new ConcurrentHashMap<>();
    // Map to store Content -> ClaudeChatWindow mapping for multi-tab support
    private static final Map<Content, ClaudeChatWindow> contentToWindowMap = new ConcurrentHashMap<>();
    private static volatile boolean shutdownHookRegistered = false;
    private static final String TAB_NAME_PREFIX = "AI";
    // Track contents being detached to prevent contentRemoved listener from disposing them
    private static final Set<Content> detachingContents =
            Collections.newSetFromMap(new ConcurrentHashMap<>());

    /**
     * Get the chat window instance for the specified project.
     */
    public static ClaudeChatWindow getChatWindow(Project project) {
        return instances.get(project);
    }

    /**
     * Generate the next available tab name in the format "AIN".
     */
    public static String getNextTabName(ToolWindow toolWindow) {
        if (toolWindow == null) {
            return TAB_NAME_PREFIX + "1";
        }

        ContentManager contentManager = toolWindow.getContentManager();
        int maxNumber = 0;

        for (Content content : contentManager.getContents()) {
            String displayName = content.getDisplayName();
            if (displayName != null && displayName.startsWith(TAB_NAME_PREFIX)) {
                try {
                    int number = Integer.parseInt(displayName.substring(TAB_NAME_PREFIX.length()));
                    if (number > maxNumber) {
                        maxNumber = number;
                    }
                } catch (NumberFormatException ignored) {
                }
            }
        }

        return TAB_NAME_PREFIX + (maxNumber + 1);
    }

    // Package-private static helpers for ClaudeChatWindow map access

    static void registerWindow(Project project, ClaudeChatWindow window) {
        synchronized (instances) {
            ClaudeChatWindow oldInstance = instances.get(project);
            if (oldInstance != null && oldInstance != window) {
                LOG.warn("Window instance already exists for project " + project.getName() + ", replacing old instance");
                oldInstance.dispose();
            }
            instances.put(project, window);
        }
    }

    static void unregisterWindow(Project project, ClaudeChatWindow window) {
        synchronized (instances) {
            if (instances.get(project) == window) {
                instances.remove(project);
            }
        }
    }

    static void registerContentMapping(Content content, ClaudeChatWindow window) {
        contentToWindowMap.put(content, window);
    }

    static void unregisterContentMapping(Content content) {
        contentToWindowMap.remove(content);
    }

    /**
     * Mark a Content as being detached (moving to a floating window).
     * This prevents the contentRemoved listener from disposing the associated ClaudeChatWindow.
     */
    public static void markContentAsDetaching(Content content) {
        detachingContents.add(content);
    }

    /**
     * Remove the detaching mark from a Content after the detach operation is complete.
     */
    public static void unmarkContentAsDetaching(Content content) {
        detachingContents.remove(content);
    }

    /**
     * Check if a Content is currently being detached.
     */
    static boolean isContentDetaching(Content content) {
        return detachingContents.contains(content);
    }

    /**
     * Get the ClaudeChatWindow associated with the given Content tab.
     */
    public static ClaudeChatWindow getChatWindowForContent(Content content) {
        return content != null ? contentToWindowMap.get(content) : null;
    }

    @Override
    public void init(@NotNull ToolWindow toolWindow) {
        toolWindow.setTitle(TOOL_WINDOW_DISPLAY_NAME);
        toolWindow.setStripeTitle(TOOL_WINDOW_DISPLAY_NAME);
    }

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        // Register JVM Shutdown Hook (only once)
        registerShutdownHook();

        ContentFactory contentFactory = ContentFactory.getInstance();
        ContentManager contentManager = toolWindow.getContentManager();

        // Check if ai-bridge is ready
        if (BridgePreloader.isBridgeReady()) {
            LOG.info("[ToolWindow] ai-bridge ready, creating chat window directly");
            createChatWindowContent(project, toolWindow, contentFactory, contentManager);
        } else {
            LOG.info("[ToolWindow] ai-bridge not ready, showing loading panel");
            JPanel loadingPanel = createLoadingPanel();
            Content loadingContent = contentFactory.createContent(loadingPanel, TAB_NAME_PREFIX + "1", false);
            contentManager.addContent(loadingContent);

            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    BridgePreloader.getSharedResolver().findSdkDir();
                    CompletableFuture<Boolean> future = BridgePreloader.waitForBridgeAsync();
                    Boolean ready = future.get(60, TimeUnit.SECONDS);

                    if (project.isDisposed()) return;

                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (project.isDisposed()) return;

                        if (ready != null && ready) {
                            LOG.info("[ToolWindow] ai-bridge ready, replacing loading panel with chat window");
                            replaceLoadingPanelWithChatWindow(project, toolWindow, contentFactory, contentManager, loadingContent);
                        } else {
                            LOG.error("[ToolWindow] ai-bridge preparation failed");
                            updateLoadingPanelWithError(loadingPanel, "AI Bridge preparation failed. Please restart IDE.");
                        }
                    });
                } catch (TimeoutException e) {
                    LOG.error("[ToolWindow] ai-bridge preparation timeout");
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (!project.isDisposed()) {
                            updateLoadingPanelWithError(loadingPanel, "AI Bridge preparation timeout. Please restart IDE.");
                        }
                    });
                } catch (Exception e) {
                    LOG.error("[ToolWindow] ai-bridge preparation error: " + e.getMessage());
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (!project.isDisposed()) {
                            updateLoadingPanelWithError(loadingPanel, "Error: " + e.getMessage());
                        }
                    });
                }
            });
        }

        // Add DevTools action to ToolWindow title bar (only in development mode)
        if (PlatformUtils.isPluginDevMode()) {
            com.intellij.openapi.actionSystem.AnAction devToolsAction =
                    com.intellij.openapi.actionSystem.ActionManager.getInstance()
                            .getAction("ClaudeCodeGUI.OpenDevToolsAction");
            if (devToolsAction != null) {
                toolWindow.setTitleActions(java.util.List.of(devToolsAction));
            }
        }

        // Add Rename Tab and Detach Tab actions to tool window gear menu
        com.intellij.openapi.actionSystem.AnAction renameTabAction =
                com.intellij.openapi.actionSystem.ActionManager.getInstance()
                        .getAction("ClaudeCodeGUI.RenameTabAction");
        com.intellij.openapi.actionSystem.AnAction detachTabAction =
                com.intellij.openapi.actionSystem.ActionManager.getInstance()
                        .getAction("ClaudeCodeGUI.DetachTabAction");

        com.intellij.openapi.actionSystem.DefaultActionGroup gearActions =
                new com.intellij.openapi.actionSystem.DefaultActionGroup();
        if (renameTabAction != null) {
            gearActions.add(renameTabAction);
        }
        if (detachTabAction != null) {
            gearActions.add(detachTabAction);
        }
        toolWindow.setAdditionalGearActions(gearActions);

        // Register project closing listener to dispose detached windows
        registerProjectCloseListener(project);

        // Add listener to manage tab closeable state based on tab count
        contentManager.addContentManagerListener(new ContentManagerListener() {
            @Override
            public void contentAdded(@NotNull ContentManagerEvent event) {
                updateTabCloseableState(contentManager);
                TabStateService tabStateService = TabStateService.getInstance(project);
                tabStateService.saveTabCount(contentManager.getContentCount());
            }

            @Override
            public void contentRemoved(@NotNull ContentManagerEvent event) {
                updateTabCloseableState(contentManager);

                Content removedContent = event.getContent();

                // Skip dispose and tab state cleanup when the tab is being detached
                // to a floating window (the ClaudeChatWindow is still alive in the frame)
                if (isContentDetaching(removedContent)) {
                    LOG.info("[TabManager] Tab detaching to floating window, skipping dispose: "
                        + removedContent.getDisplayName());
                    return;
                }

                int removedIndex = event.getIndex();
                TabStateService tabStateService = TabStateService.getInstance(project);
                tabStateService.onTabRemoved(removedIndex);

                // Dispose the ClaudeChatWindow associated with the removed tab
                // to shut down its Daemon process and release resources
                ClaudeChatWindow window = contentToWindowMap.get(removedContent);
                if (window != null) {
                    LOG.info("[TabManager] Disposing ClaudeChatWindow for removed tab: "
                        + removedContent.getDisplayName());
                    window.dispose();
                }
            }

            @Override
            public void contentRemoveQuery(@NotNull ContentManagerEvent event) {
                Content content = event.getContent();

                // Skip confirmation dialog when the tab is being detached to a floating window
                if (isContentDetaching(content)) {
                    return;
                }

                String tabName = content.getDisplayName();

                int result = com.intellij.openapi.ui.Messages.showYesNoDialog(
                    project,
                    ClaudeCodeGuiBundle.message("tab.close.confirm.message", tabName),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.title"),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.yes"),
                    ClaudeCodeGuiBundle.message("tab.close.confirm.no"),
                    com.intellij.openapi.ui.Messages.getQuestionIcon()
                );

                if (result != com.intellij.openapi.ui.Messages.YES) {
                    event.consume();
                }
            }
        });

        updateTabCloseableState(contentManager);
    }

    private void updateTabCloseableState(ContentManager contentManager) {
        int tabCount = contentManager.getContentCount();
        boolean closeable = tabCount > 1;

        for (Content tab : contentManager.getContents()) {
            tab.setCloseable(closeable);
        }

        LOG.debug("[TabManager] Updated tab closeable state: count=" + tabCount + ", closeable=" + closeable);
    }

    private JPanel createLoadingPanel() {
        JPanel panel = new JPanel(new GridBagLayout());
        panel.setBackground(com.github.claudecodegui.util.ThemeConfigService.getBackgroundColor());

        JPanel centerPanel = new JPanel();
        centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
        centerPanel.setOpaque(false);

        JLabel iconLabel = new JLabel("⚙");
        iconLabel.setFont(iconLabel.getFont().deriveFont(48f));
        iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(iconLabel);

        centerPanel.add(Box.createVerticalStrut(16));

        JLabel textLabel = new JLabel(ClaudeCodeGuiBundle.message("toolwindow.preparingBridge"));
        textLabel.setFont(textLabel.getFont().deriveFont(14f));
        textLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(textLabel);

        panel.add(centerPanel);
        return panel;
    }

    private void updateLoadingPanelWithError(JPanel loadingPanel, String errorMessage) {
        loadingPanel.removeAll();

        JPanel centerPanel = new JPanel();
        centerPanel.setLayout(new BoxLayout(centerPanel, BoxLayout.Y_AXIS));
        centerPanel.setOpaque(false);

        JLabel iconLabel = new JLabel("⚠");
        iconLabel.setFont(iconLabel.getFont().deriveFont(48f));
        iconLabel.setForeground(Color.ORANGE);
        iconLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(iconLabel);

        centerPanel.add(Box.createVerticalStrut(16));

        JLabel textLabel = new JLabel(errorMessage);
        textLabel.setFont(textLabel.getFont().deriveFont(14f));
        textLabel.setAlignmentX(Component.CENTER_ALIGNMENT);
        centerPanel.add(textLabel);

        loadingPanel.add(centerPanel);
        loadingPanel.revalidate();
        loadingPanel.repaint();
    }

    private void replaceLoadingPanelWithChatWindow(
            @NotNull Project project,
            @NotNull ToolWindow toolWindow,
            ContentFactory contentFactory,
            ContentManager contentManager,
            Content loadingContent
    ) {
        TabStateService tabStateService = TabStateService.getInstance(project);
        int savedTabCount = tabStateService.getTabCount();
        LOG.info("[TabManager] Restoring " + savedTabCount + " tabs from storage");

        ClaudeChatWindow firstChatWindow = new ClaudeChatWindow(project, false);

        String firstTabName;
        String savedFirstName = tabStateService.getTabName(0);
        if (savedFirstName != null && !savedFirstName.isEmpty()) {
            firstTabName = savedFirstName;
            LOG.info("[TabManager] Restored tab 0 name from storage: " + firstTabName);
        } else {
            firstTabName = TAB_NAME_PREFIX + "1";
        }

        loadingContent.setComponent(firstChatWindow.getContent());
        loadingContent.setDisplayName(firstTabName);
        firstChatWindow.setParentContent(loadingContent);

        loadingContent.setDisposer(() -> {
            ClaudeChatWindow window = instances.get(project);
            if (window != null) {
                window.dispose();
            }
        });

        for (int i = 1; i < savedTabCount; i++) {
            ClaudeChatWindow chatWindow = new ClaudeChatWindow(project, true);

            String tabName;
            String savedName = tabStateService.getTabName(i);
            if (savedName != null && !savedName.isEmpty()) {
                tabName = savedName;
                LOG.info("[TabManager] Restored tab " + i + " name from storage: " + tabName);
            } else {
                tabName = TAB_NAME_PREFIX + (i + 1);
            }

            Content content = contentFactory.createContent(chatWindow.getContent(), tabName, false);
            chatWindow.setParentContent(content);
            contentManager.addContent(content);
        }

        updateTabCloseableState(contentManager);
    }

    private void createChatWindowContent(
            @NotNull Project project,
            @NotNull ToolWindow toolWindow,
            ContentFactory contentFactory,
            ContentManager contentManager
    ) {
        TabStateService tabStateService = TabStateService.getInstance(project);
        int savedTabCount = tabStateService.getTabCount();
        LOG.info("[TabManager] Restoring " + savedTabCount + " tabs from storage");

        for (int i = 0; i < savedTabCount; i++) {
            boolean isFirstTab = (i == 0);
            ClaudeChatWindow chatWindow = new ClaudeChatWindow(project, !isFirstTab);

            String tabName;
            String savedName = tabStateService.getTabName(i);
            if (savedName != null && !savedName.isEmpty()) {
                tabName = savedName;
                LOG.info("[TabManager] Restored tab " + i + " name from storage: " + tabName);
            } else {
                tabName = TAB_NAME_PREFIX + (i + 1);
            }

            Content content = contentFactory.createContent(chatWindow.getContent(), tabName, false);
            chatWindow.setParentContent(content);
            chatWindow.setOriginalTabName(tabName);
            contentManager.addContent(content);

            if (isFirstTab) {
                content.setDisposer(() -> {
                    ClaudeChatWindow window = instances.get(project);
                    if (window != null) {
                        window.dispose();
                    }
                });
            }
        }

        updateTabCloseableState(contentManager);
    }

    private static synchronized void registerShutdownHook() {
        if (shutdownHookRegistered) {
            return;
        }
        shutdownHookRegistered = true;

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            LOG.info("[ShutdownHook] IDEA is shutting down, cleaning up all Node.js processes...");

            ExecutorService executor = Executors.newSingleThreadExecutor();
            try {
                Future<?> future = executor.submit(() -> {
                    // Collect all unique windows from both maps and detached windows
                    java.util.Set<ClaudeChatWindow> allWindows = java.util.Collections.newSetFromMap(
                        new java.util.IdentityHashMap<>());
                    allWindows.addAll(instances.values());
                    allWindows.addAll(contentToWindowMap.values());
                    allWindows.addAll(DetachedWindowManager.getAllDetachedChatWindows());

                    for (ClaudeChatWindow window : allWindows) {
                        try {
                            if (window != null && window.getClaudeSDKBridge() != null) {
                                window.getClaudeSDKBridge().cleanupAllProcesses();
                            }
                            if (window != null && window.getCodexSDKBridge() != null) {
                                window.getCodexSDKBridge().cleanupAllProcesses();
                            }
                        } catch (Exception e) {
                            LOG.error("[ShutdownHook] Error cleaning up processes: " + e.getMessage());
                        }
                    }
                });

                future.get(3, TimeUnit.SECONDS);
                LOG.info("[ShutdownHook] Node.js process cleanup completed");
            } catch (TimeoutException e) {
                LOG.warn("[ShutdownHook] Process cleanup timed out (3s), forcing exit");
            } catch (Exception e) {
                LOG.error("[ShutdownHook] Process cleanup failed: " + e.getMessage());
            } finally {
                executor.shutdownNow();
            }
        }, "Claude-Process-Cleanup-Hook"));

        LOG.info("[ShutdownHook] JVM Shutdown Hook registered");
    }

    private static final CodeSnippetManager codeSnippetManager = new CodeSnippetManager(instances, contentToWindowMap);

    public static void addSelectionFromExternal(Project project, String selectionInfo) {
        codeSnippetManager.addSelectionFromExternal(project, selectionInfo);
    }

    /**
     * Register project closing listener to dispose all detached windows for the project.
     * This ensures proper cleanup when a project is closed.
     *
     * @param project The project to listen to
     */
    private void registerProjectCloseListener(@NotNull Project project) {
        project.getMessageBus().connect(project).subscribe(
                com.intellij.openapi.project.ProjectManager.TOPIC,
                new com.intellij.openapi.project.ProjectManagerListener() {
                    @Override
                    public void projectClosing(@NotNull Project closingProject) {
                        if (closingProject.equals(project)) {
                            LOG.info("[ToolWindow] Project closing, disposing detached windows for: " + project.getName());
                            DetachedWindowManager.disposeAllDetached(project);
                        }
                    }
                }
        );
    }
}
