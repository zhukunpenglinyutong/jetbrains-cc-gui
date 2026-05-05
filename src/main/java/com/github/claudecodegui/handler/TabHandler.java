package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.github.claudecodegui.ui.toolwindow.TabSessionStateInheritor;
import com.github.claudecodegui.settings.TabStateService;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.DataManager;
import com.intellij.openapi.actionSystem.DataContext;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vcs.CommitMessageI;
import com.intellij.openapi.vcs.VcsDataKeys;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.IdeFocusManager;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import com.intellij.vcs.commit.CommitMessageUi;
import com.intellij.vcs.commit.CommitWorkflowUi;

import java.awt.Component;
import java.lang.reflect.Method;


/**
 * Tab management handler
 * Handles creating new chat tabs in the tool window
 */
public class TabHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(TabHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "create_new_tab",
        "rename_current_tab",
        "set_commit_message_from_reply"
    };

    public TabHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("create_new_tab".equals(type)) {
            LOG.debug("[TabHandler] Processing create_new_tab");
            handleCreateNewTab();
            return true;
        }
        if ("rename_current_tab".equals(type)) {
            LOG.debug("[TabHandler] Processing rename_current_tab");
            handleRenameCurrentTab(content);
            return true;
        }
        if ("set_commit_message_from_reply".equals(type)) {
            LOG.debug("[TabHandler] Processing set_commit_message_from_reply");
            handleSetCommitMessageFromReply(content);
            return true;
        }
        return false;
    }

    /**
     * Create a new chat tab in the tool window
     */
    private void handleCreateNewTab() {
        Project project = context.getProject();

        ToolWindowManager.getInstance(project).invokeLater(() -> {
            try {
                // Get the tool window
                ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                        .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
                if (toolWindow == null) {
                    LOG.error("[TabHandler] Tool window not found");
                    callJavaScript("addErrorMessage", escapeJs("无法找到 CCG 工具窗口"));
                    return;
                }

                // Prefer inheriting from the current handler context session to ensure
                // "new tab" clones the tab that triggered this action.
                TabStateService.TabSessionState inheritedState =
                        TabSessionStateInheritor.captureForNewTab(context.getSession());
                if (inheritedState == null) {
                    inheritedState = TabSessionStateInheritor.captureForNewTab(project, toolWindow);
                }

                // Create a new chat window instance with skipRegister=true (don't replace the main instance)
                ClaudeChatWindow newChatWindow = new ClaudeChatWindow(project, true);
                if (inheritedState != null) {
                    newChatWindow.restorePersistedTabSessionState(inheritedState);
                }

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
                content.setDisposer(newChatWindow::dispose);

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
     * Rename the currently selected tab from webview request.
     * Keeps originalTabName and persisted TabStateService in sync.
     */
    private void handleRenameCurrentTab(String content) {
        Project project = context.getProject();
        if (project == null || project.isDisposed()) {
            return;
        }

        String newName = extractTabTitle(content);
        if (newName == null || newName.isEmpty()) {
            return;
        }

        ToolWindowManager.getInstance(project).invokeLater(() -> {
            ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                    .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
            if (toolWindow == null) {
                return;
            }

            ContentManager contentManager = toolWindow.getContentManager();
            Content targetContent = resolveRenameTargetContent(contentManager);
            if (targetContent == null) {
                return;
            }

            String currentDisplayName = targetContent.getDisplayName();
            if (newName.equals(currentDisplayName)) {
                return;
            }

            targetContent.setDisplayName(newName);

            ClaudeChatWindow chatWindow = ClaudeSDKToolWindow.getChatWindowForContent(targetContent);
            if (chatWindow != null) {
                chatWindow.setOriginalTabName(newName);
            }

            int tabIndex = contentManager.getIndexOfContent(targetContent);
            if (tabIndex >= 0) {
                TabStateService.getInstance(project).saveTabName(tabIndex, newName);
            }
        });
    }

    /**
     * Resolve the tab that initiated this handler call.
     * Do not rely on "currently selected tab" because users may switch tabs
     * while an assistant response is still streaming.
     */
    private Content resolveRenameTargetContent(ContentManager contentManager) {
        if (contentManager == null) {
            return null;
        }

        if (context.getSession() != null) {
            for (Content content : contentManager.getContents()) {
                ClaudeChatWindow chatWindow = ClaudeSDKToolWindow.getChatWindowForContent(content);
                if (chatWindow != null && chatWindow.getSession() == context.getSession()) {
                    return content;
                }
            }
        }

        // Fallback: keep previous behavior if session mapping cannot be resolved.
        return contentManager.getSelectedContent();
    }

    private String extractTabTitle(String content) {
        if (content == null || content.trim().isEmpty()) {
            return null;
        }
        try {
            JsonObject json = JsonParser.parseString(content).getAsJsonObject();
            if (!json.has("title") || json.get("title").isJsonNull()) {
                return null;
            }
            String title = json.get("title").getAsString();
            if (title == null) {
                return null;
            }
            String trimmed = title.trim();
            return trimmed.isEmpty() ? null : trimmed;
        } catch (Exception e) {
            LOG.warn("[TabHandler] Failed to parse rename_current_tab payload: " + e.getMessage());
            return null;
        }
    }

    private void handleSetCommitMessageFromReply(String content) {
        Project project = context.getProject();
        if (project == null || project.isDisposed()) {
            return;
        }

        if (!isCommitAutoFillEnabled()) {
            return;
        }

        String commitMessage = extractCommitMessage(content);
        if (commitMessage == null || commitMessage.isEmpty()) {
            return;
        }

        ToolWindowManager.getInstance(project).invokeLater(() -> {
            if (project.isDisposed()) {
                return;
            }
            boolean applied = applyCommitMessageFromFocusedContext(commitMessage);
            if (!applied) {
                applied = applyCommitMessageFromCommitToolWindow(project, commitMessage);
            }
            if (!applied) {
                LOG.debug("[TabHandler] Commit message panel not found, skip autofill");
            }
        });
    }

    private boolean isCommitAutoFillEnabled() {
        try {
            return context.getSettingsService().getCommitGenerationEnabled();
        } catch (Exception e) {
            LOG.warn("[TabHandler] Failed to read commitGenerationEnabled, fallback enabled: " + e.getMessage());
            return true;
        }
    }

    private String extractCommitMessage(String content) {
        if (content == null || content.trim().isEmpty()) {
            return null;
        }
        try {
            JsonObject json = JsonParser.parseString(content).getAsJsonObject();
            if (!json.has("message") || json.get("message").isJsonNull()) {
                return null;
            }
            String message = json.get("message").getAsString();
            if (message == null) {
                return null;
            }
            String trimmed = message.trim();
            return trimmed.isEmpty() ? null : trimmed;
        } catch (Exception e) {
            LOG.warn("[TabHandler] Failed to parse set_commit_message_from_reply payload: " + e.getMessage());
            return null;
        }
    }

    private boolean applyCommitMessageFromFocusedContext(String commitMessage) {
        try {
            Component focusOwner = IdeFocusManager.getGlobalInstance().getFocusOwner();
            if (focusOwner == null) {
                return false;
            }
            DataContext dataContext = DataManager.getInstance().getDataContext(focusOwner);
            return applyCommitMessageFromDataContext(dataContext, commitMessage);
        } catch (Exception e) {
            LOG.debug("[TabHandler] Failed to apply commit message from focused context: " + e.getMessage());
            return false;
        }
    }

    private boolean applyCommitMessageFromCommitToolWindow(Project project, String commitMessage) {
        try {
            ToolWindow commitToolWindow = ToolWindowManager.getInstance(project).getToolWindow("Commit");
            if (commitToolWindow == null) {
                return false;
            }
            Component component = commitToolWindow.getComponent();
            if (component == null) {
                return false;
            }
            DataContext dataContext = DataManager.getInstance().getDataContext(component);
            return applyCommitMessageFromDataContext(dataContext, commitMessage);
        } catch (Exception e) {
            LOG.debug("[TabHandler] Failed to apply commit message from Commit tool window: " + e.getMessage());
            return false;
        }
    }

    private boolean applyCommitMessageFromDataContext(DataContext dataContext, String commitMessage) {
        if (dataContext == null) {
            return false;
        }

        CommitWorkflowUi workflowUi = VcsDataKeys.COMMIT_WORKFLOW_UI.getData(dataContext);
        if (workflowUi != null) {
            CommitMessageUi commitMessageUi = workflowUi.getCommitMessageUi();
            if (commitMessageUi != null) {
                commitMessageUi.setText(commitMessage);
                return true;
            }
        }

        CommitMessageI messageControl = VcsDataKeys.COMMIT_MESSAGE_CONTROL.getData(dataContext);
        if (messageControl != null) {
            messageControl.setCommitMessage(commitMessage);
            return true;
        }

        Object workflowHandler = VcsDataKeys.COMMIT_WORKFLOW_HANDLER.getData(dataContext);
        if (workflowHandler != null) {
            try {
                Method getUiMethod = workflowHandler.getClass().getMethod("getUi");
                Object uiObj = getUiMethod.invoke(workflowHandler);
                if (uiObj instanceof CommitWorkflowUi ui) {
                    CommitMessageUi commitMessageUi = ui.getCommitMessageUi();
                    if (commitMessageUi != null) {
                        commitMessageUi.setText(commitMessage);
                        return true;
                    }
                }
            } catch (Exception e) {
                LOG.debug("[TabHandler] Reflection fallback failed while setting commit message: " + e.getMessage());
            }
        }

        return false;
    }
}
