package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.github.claudecodegui.ui.toolwindow.ForkTitleFormatter;
import com.github.claudecodegui.settings.TabStateService;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tab management handler
 * Handles creating new chat tabs in the tool window
 */
public class TabHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(TabHandler.class);
    private static final Map<Project, Set<String>> RESERVED_FORK_TITLES = Collections.synchronizedMap(new WeakHashMap<>());

    private static final String[] SUPPORTED_TYPES = {
        "create_new_tab",
        "fork_session"
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
        switch (type) {
            case "create_new_tab":
                LOG.debug("[TabHandler] Processing create_new_tab");
                createNewTabInternal(null);
                return true;
            case "fork_session":
                LOG.debug("[TabHandler] Processing fork_session");
                handleForkSession(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Parses a fork_session payload and opens a branch tab from the source session ID.
     *
     * The webview emits this event for /fork so the source JSONL stays untouched while
     * the user immediately sees a dedicated tab for the branched conversation.
     */
    private void handleForkSession(String content) {
        String sourceSessionId = null;
        String sourceTitle = null;
        try {
            Gson gson = new Gson();
            JsonObject payload = gson.fromJson(content, JsonObject.class);
            if (payload != null && payload.has("sourceSessionId") && !payload.get("sourceSessionId").isJsonNull()) {
                sourceSessionId = payload.get("sourceSessionId").getAsString();
            }
            if (payload != null && payload.has("sourceTitle") && !payload.get("sourceTitle").isJsonNull()) {
                sourceTitle = payload.get("sourceTitle").getAsString();
            }
        } catch (Exception e) {
            // Fork events should not crash the entire tool window on malformed payloads.
            LOG.warn("[TabHandler] Failed to parse fork_session payload: " + e.getMessage());
        }

        if (!isValidSourceSessionId(sourceSessionId)) {
            LOG.warn("[TabHandler] fork_session payload has invalid sourceSessionId, ignoring");
            callJavaScript("addErrorMessage", escapeJs("无法从源会话 fork：缺少 sourceSessionId"));
            return;
        }
        String currentSessionId = context.getSession() != null ? context.getSession().getSessionId() : null;
        if (!isAuthorizedForkSourceSessionId(sourceSessionId, currentSessionId)) {
            LOG.warn("[TabHandler] fork_session sourceSessionId does not match the active session, ignoring");
            callJavaScript("addErrorMessage", escapeJs("无法从非当前会话 fork"));
            return;
        }

        LOG.info("[TabHandler] Forking new tab from source session: " + sourceSessionId);
        Project project = context.getProject();
        final String forkSourceId = sourceSessionId.trim();
        final String forkSourceTitle = sourceTitle;
        CompletableFuture
                .supplyAsync(() -> reserveForkTitle(project, forkSourceTitle))
                .thenAccept(forkTitle -> createNewTabInternal(forkSourceId, forkTitle))
                .exceptionally(ex -> {
                    LOG.warn("[TabHandler] Failed to resolve fork title numbering: " + ex.getMessage(), ex);
                    createNewTabInternal(forkSourceId, ForkTitleFormatter.buildForkTitle(forkSourceTitle, Collections.emptyList()));
                    return null;
                });
    }

    static boolean isValidSourceSessionId(String sessionId) {
        return SessionState.isValidSessionId(sessionId);
    }

    static boolean isAuthorizedForkSourceSessionId(String sourceSessionId, String currentSessionId) {
        return isValidSourceSessionId(sourceSessionId)
                && isValidSourceSessionId(currentSessionId)
                && sourceSessionId.equals(currentSessionId);
    }

    static void addReservedForkTitle(Project project, String forkTitle) {
        if (project == null || forkTitle == null || forkTitle.trim().isEmpty()) {
            return;
        }
        RESERVED_FORK_TITLES.computeIfAbsent(project, ignored -> ConcurrentHashMap.newKeySet()).add(forkTitle);
    }

    static void releaseReservedForkTitle(Project project, String forkTitle) {
        if (project == null || forkTitle == null || forkTitle.trim().isEmpty()) {
            return;
        }
        Set<String> reservedTitles = RESERVED_FORK_TITLES.get(project);
        if (reservedTitles == null) {
            return;
        }
        reservedTitles.remove(forkTitle);
        if (reservedTitles.isEmpty()) {
            RESERVED_FORK_TITLES.remove(project);
        }
    }

    static Set<String> getReservedForkTitlesSnapshot(Project project) {
        Set<String> reservedTitles = RESERVED_FORK_TITLES.get(project);
        return reservedTitles == null ? Collections.emptySet() : Set.copyOf(reservedTitles);
    }

    private String reserveForkTitle(Project project, String sourceTitle) {
        String normalizedSourceTitle = sourceTitle != null ? sourceTitle.trim() : "";
        if (normalizedSourceTitle.isEmpty()) {
            return null;
        }

        List<String> existingTitles = new ArrayList<>(loadPersistedSessionTitles());
        existingTitles.addAll(getReservedForkTitlesSnapshot(project));

        String forkTitle = ForkTitleFormatter.buildForkTitle(normalizedSourceTitle, existingTitles);
        addReservedForkTitle(project, forkTitle);
        return forkTitle;
    }

    private List<String> loadPersistedSessionTitles() {
        try {
            String titlesJson = new NodeJsServiceCaller(context).callNodeJsTitlesService("loadTitles");
            JsonObject titles = new Gson().fromJson(titlesJson, JsonObject.class);
            if (titles == null) {
                return Collections.emptyList();
            }

            List<String> result = new ArrayList<>();
            for (Map.Entry<String, JsonElement> entry : titles.entrySet()) {
                JsonElement value = entry.getValue();
                if (value == null || !value.isJsonObject()) {
                    continue;
                }
                JsonObject titleInfo = value.getAsJsonObject();
                if (titleInfo.has("customTitle") && !titleInfo.get("customTitle").isJsonNull()) {
                    result.add(titleInfo.get("customTitle").getAsString());
                }
            }
            return result;
        } catch (Exception e) {
            LOG.warn("[TabHandler] Failed to load session titles for fork numbering: " + e.getMessage(), e);
            return Collections.emptyList();
        }
    }

    /**
     * Shared entry point for creating a new chat tab.
     *
     * @param sourceSessionIdForFork non-empty when the new tab should branch from that source session
     */
    private void createNewTabInternal(String sourceSessionIdForFork) {
        createNewTabInternal(sourceSessionIdForFork, null);
    }

    private void createNewTabInternal(String sourceSessionIdForFork, String sourceTitleForFork) {
        Project project = context.getProject();
        // Immutable snapshots for lambdas so later local changes cannot leak into tab creation.
        final String forkSourceId = sourceSessionIdForFork;
        final String forkSourceTitle = sourceTitleForFork;

        ToolWindowManager.getInstance(project).invokeLater(() -> {
            try {
                ToolWindow toolWindow = ToolWindowManager.getInstance(project)
                        .getToolWindow(ClaudeSDKToolWindow.TOOL_WINDOW_ID);
                if (toolWindow == null) {
                    LOG.error("[TabHandler] Tool window not found");
                    releaseReservedForkTitle(project, forkSourceTitle);
                    callJavaScript("addErrorMessage", escapeJs("无法找到 CCG 工具窗口"));
                    return;
                }

                // Branch/new tabs must not replace the global main instance; otherwise top-level events
                // can be routed to a branch tab instead of the original tool window.
                ClaudeChatWindow newChatWindow = new ClaudeChatWindow(project, true);

                ContentManager contentManager = toolWindow.getContentManager();
                int tabIndex = contentManager.getContentCount();

                TabStateService tabStateService = TabStateService.getInstance(project);
                String savedName = tabStateService.getTabName(tabIndex);

                String tabName;
                if (savedName != null && !savedName.isEmpty()) {
                    tabName = savedName;
                    LOG.info("[TabHandler] Restored tab name from storage: " + tabName);
                } else {
                    // IDE tab names keep the regular AI sequence; fork identity is shown in the chat title.
                    tabName = ClaudeSDKToolWindow.getNextTabName(toolWindow);
                }

                ContentFactory contentFactory = ContentFactory.getInstance();
                Content content = contentFactory.createContent(newChatWindow.getContent(), tabName, false);
                content.setCloseable(true);
                newChatWindow.setParentContent(content);
                content.setDisposer(() -> {
                    releaseReservedForkTitle(project, forkSourceTitle);
                    newChatWindow.dispose();
                });

                contentManager.addContent(content);
                contentManager.setSelectedContent(content);

                toolWindow.show(null);

                // setForkContext must run after the tab is attached so restore callbacks target an initialized browser.
                if (forkSourceId != null && !forkSourceId.trim().isEmpty()) {
                    newChatWindow.setForkContext(forkSourceId, forkSourceTitle);
                    LOG.info("[TabHandler] Created forked tab: " + tabName + " (source=" + forkSourceId + ")");
                } else {
                    LOG.info("[TabHandler] Created new tab: " + tabName);
                }
            } catch (Exception e) {
                releaseReservedForkTitle(project, forkSourceTitle);
                LOG.error("[TabHandler] Error creating new tab: " + e.getMessage(), e);
                callJavaScript("addErrorMessage", escapeJs("创建新标签页失败: " + e.getMessage()));
            }
        });
    }
}
