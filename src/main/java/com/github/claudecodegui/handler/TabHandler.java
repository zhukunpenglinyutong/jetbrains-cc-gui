package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeChatWindow;
import com.github.claudecodegui.ClaudeSDKToolWindow;
import com.github.claudecodegui.settings.TabStateService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;


/**
 * Tab management handler
 * Handles creating new chat tabs in the tool window
 */
public class TabHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(TabHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "create_new_tab",
        "rename_tab"
    };

    private static final int MAX_TAB_TITLE_LENGTH = 30;
    private static final String DEFAULT_TAB_NAME_PATTERN = "^AI\\d+$";

    public TabHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "create_new_tab":
                LOG.debug("[TabHandler] Processing create_new_tab");
                handleCreateNewTab();
                return true;
            case "rename_tab":
                LOG.debug("[TabHandler] Processing rename_tab");
                handleRenameTab(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Create a new chat tab in the tool window
     */
    private void handleCreateNewTab() {
        Project project = context.getProject();

        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                // Get the tool window
                ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                if (toolWindow == null) {
                    LOG.error("[TabHandler] Tool window not found");
                    callJavaScript("addErrorMessage", escapeJs("无法找到 CCG 工具窗口"));
                    return;
                }

                // Create a new chat window instance with skipRegister=true (don't replace the main instance)
                ClaudeChatWindow newChatWindow = new ClaudeChatWindow(project, true);

                // Get tab index before adding content
                ContentManager contentManager = toolWindow.getContentManager();
                int tabIndex = contentManager.getContentCount();

                // Check if there's a saved name for this tab index
                TabStateService tabStateService = TabStateService.getInstance(project);
                String savedName = tabStateService.getTabName(tabIndex);

                // Create a tab name: use saved name or generate new one
                String tabName;
                if (savedName != null && !savedName.isEmpty()) {
                    tabName = savedName;
                    LOG.info("[TabHandler] Restored tab name from storage: " + tabName);
                } else {
                    tabName = ClaudeSDKToolWindow.getNextTabName(toolWindow);
                }

                // Create and add the new tab content
                ContentFactory contentFactory = ContentFactory.getInstance();
                Content content = contentFactory.createContent(newChatWindow.getContent(), tabName, false);
                content.setCloseable(true);
                newChatWindow.setParentContent(content);

                contentManager.addContent(content);
                contentManager.setSelectedContent(content);

                // Ensure the tool window is visible
                toolWindow.show(null);

                LOG.info("[TabHandler] Created new tab: " + tabName);
            } catch (Exception e) {
                LOG.error("[TabHandler] Error creating new tab: " + e.getMessage(), e);
                callJavaScript("addErrorMessage", escapeJs("创建新标签页失败: " + e.getMessage()));
            }
        });
    }

    /**
     * Auto-rename the current tab based on the first message content.
     * Only renames tabs that still have the default "AIN" name.
     */
    private void handleRenameTab(String content) {
        Project project = context.getProject();

        try {
            Gson gson = new Gson();
            JsonObject payload = gson.fromJson(content, JsonObject.class);
            String title = payload != null && payload.has("title") ? payload.get("title").getAsString() : null;

            if (title == null || title.trim().isEmpty()) {
                LOG.debug("[TabHandler] rename_tab: empty title, skipping");
                return;
            }

            boolean force = payload != null && payload.has("force") && payload.get("force").getAsBoolean();

            // Truncate to max length
            title = title.trim().replace("\n", " ");
            if (title.length() > MAX_TAB_TITLE_LENGTH) {
                title = title.substring(0, MAX_TAB_TITLE_LENGTH) + "...";
            }

            final String newTitle = title;
            final boolean forceRename = force;

            ApplicationManager.getApplication().invokeLater(() -> {
                try {
                    ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("CCG");
                    if (toolWindow == null) {
                        return;
                    }

                    ContentManager contentManager = toolWindow.getContentManager();
                    Content selectedContent = contentManager.getSelectedContent();
                    if (selectedContent == null) {
                        return;
                    }

                    // Only auto-rename if tab still has the default "AIN" name (unless force=true)
                    String currentName = selectedContent.getDisplayName();
                    if (!forceRename && currentName != null && !currentName.matches(DEFAULT_TAB_NAME_PATTERN)) {
                        LOG.debug("[TabHandler] Tab already has custom name: " + currentName + ", skipping auto-rename");
                        return;
                    }

                    // Update display name
                    selectedContent.setDisplayName(newTitle);

                    // Update originalTabName so status indicators use the new name
                    ClaudeChatWindow chatWindow = ClaudeSDKToolWindow.getChatWindowForContent(selectedContent);
                    if (chatWindow != null) {
                        chatWindow.setOriginalTabName(newTitle);
                    }

                    // Persist
                    int tabIndex = contentManager.getIndexOfContent(selectedContent);
                    if (tabIndex >= 0) {
                        TabStateService.getInstance(project).saveTabName(tabIndex, newTitle);
                    }

                    LOG.info("[TabHandler] Auto-renamed tab from '" + currentName + "' to '" + newTitle + "'");
                } catch (Exception e) {
                    LOG.error("[TabHandler] Error renaming tab: " + e.getMessage(), e);
                }
            });
        } catch (Exception e) {
            LOG.error("[TabHandler] Error parsing rename_tab payload: " + e.getMessage(), e);
        }
    }
}
