package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Service for managing session metadata: favorites and custom titles.
 *
 * Title operations are serialized via a lock to prevent concurrent
 * read-modify-write races on session-titles.json.
 */
class HistoryMetadataService {

    private static final Logger LOG = Logger.getInstance(HistoryMetadataService.class);

    /**
     * Serializes all title file operations to prevent concurrent
     * read-modify-write races on session-titles.json.
     */
    private final ReentrantLock titleFileLock = new ReentrantLock();

    private final HandlerContext context;
    private final NodeJsServiceCaller nodeJsServiceCaller;

    HistoryMetadataService(HandlerContext context, NodeJsServiceCaller nodeJsServiceCaller) {
        this.context = context;
        this.nodeJsServiceCaller = nodeJsServiceCaller;
    }

    /**
     * Toggle favorite status.
     */
    void handleToggleFavorite(String sessionId) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 切换收藏状态 ==========");
                LOG.info("[HistoryHandler] SessionId: " + sessionId);

                // Call Node.js favorites-service to toggle favorite status
                String result = nodeJsServiceCaller.callNodeJsFavoritesService("toggleFavorite", sessionId);
                LOG.info("[HistoryHandler] 收藏状态切换结果: " + result);

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 切换收藏状态失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Update session title.
     */
    void handleUpdateTitle(String content) {
        CompletableFuture.runAsync(() -> {
            titleFileLock.lock();
            try {
                LOG.info("[HistoryHandler] ========== 更新会话标题 ==========");

                // Parse JSON from frontend to extract sessionId and customTitle
                JsonObject request = new Gson().fromJson(content, JsonObject.class);
                String sessionId = request.get("sessionId").getAsString();
                String customTitle = request.get("customTitle").getAsString();

                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] CustomTitle: " + customTitle);

                // Call Node.js session-titles-service to update the title
                String result = nodeJsServiceCaller.callNodeJsTitlesServiceWithParams("updateTitle", sessionId, customTitle);
                LOG.info("[HistoryHandler] 标题更新结果: " + result);

                // Parse the result
                JsonObject resultObj = new Gson().fromJson(result, JsonObject.class);
                boolean success = resultObj.get("success").getAsBoolean();

                if (!success && resultObj.has("error")) {
                    String error = resultObj.get("error").getAsString();
                    ApplicationManager.getApplication().invokeLater(() -> {
                        String jsCode = "if (window.addToast) { " +
                                                "  window.addToast('更新标题失败: " + context.escapeJs(error) + "', 'error'); " +
                                                "}";
                        context.executeJavaScriptQueued(jsCode);
                    });
                }

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 更新标题失败: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "if (window.addToast) { " +
                                            "  window.addToast('更新标题失败: " + context.escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误") + "', 'error'); " +
                                            "}";
                    context.executeJavaScriptQueued(jsCode);
                });
            } finally {
                titleFileLock.unlock();
            }
        });
    }

    /**
     * Regenerate a session's AI title from its conversation content.
     *
     * Forwards the request to the daemon's claude.regenerateTitle command and
     * relays the outcome to the frontend via window.onTitleRegenerated so the
     * history-list refresh button can clear its loading state, apply the new
     * title, and show a success/failure toast. The original title is untouched
     * on failure: the daemon only appends a new ai-title row after the model
     * returns one.
     */
    void handleRegenerateTitle(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 重新生成会话标题 ==========");

                JsonObject request = new Gson().fromJson(content, JsonObject.class);
                String sessionId = request.has("sessionId") && !request.get("sessionId").isJsonNull()
                        ? request.get("sessionId").getAsString() : null;
                if (sessionId == null || sessionId.isEmpty()) {
                    notifyTitleRegenerated(sessionId, false, null, "invalid_session", null);
                    return;
                }

                // Resolve the project path the same way as history loading so
                // the daemon locates the session file under the same key.
                String rawPath = context.resolveEffectiveWorkingDirectory();
                String nodePath = NodeDetector.getInstance().getCachedNodePath();
                String projectPath = NodeDetector.isWslPath(nodePath)
                        ? NodeDetector.convertToWslPath(rawPath) : rawPath;

                LOG.info("[HistoryHandler] SessionId: " + sessionId + ", projectPath: " + projectPath);

                context.getClaudeSDKBridge()
                        .regenerateSessionTitle(sessionId, projectPath)
                        .thenAccept(result -> {
                            boolean success = result.has("success") && result.get("success").getAsBoolean();
                            String title = result.has("title") && !result.get("title").isJsonNull()
                                    ? result.get("title").getAsString() : null;
                            String code = result.has("code") && !result.get("code").isJsonNull()
                                    ? result.get("code").getAsString() : null;
                            String error = result.has("error") && !result.get("error").isJsonNull()
                                    ? result.get("error").getAsString() : null;
                            notifyTitleRegenerated(sessionId, success, title, code, error);
                        })
                        .exceptionally(ex -> {
                            LOG.error("[HistoryHandler] 重新生成标题失败: " + ex.getMessage(), ex);
                            notifyTitleRegenerated(sessionId, false, null, "backend_error",
                                    ex.getMessage() != null ? ex.getMessage() : "Unknown error");
                            return null;
                        });
            } catch (Exception e) {
                LOG.error("[HistoryHandler] 重新生成标题失败: " + e.getMessage(), e);
                notifyTitleRegenerated(null, false, null, "backend_error",
                        e.getMessage() != null ? e.getMessage() : "未知错误");
            }
        });
    }

    /**
     * Deliver a regeneration outcome to the frontend's
     * window.onTitleRegenerated callback as a single JSON payload.
     */
    private void notifyTitleRegenerated(String sessionId, boolean success, String title, String code, String error) {
        JsonObject payload = new JsonObject();
        if (sessionId != null && !sessionId.isEmpty()) {
            payload.addProperty("sessionId", sessionId);
        }
        payload.addProperty("success", success);
        if (title != null) {
            payload.addProperty("title", title);
        }
        if (code != null) {
            payload.addProperty("code", code);
        }
        if (error != null) {
            payload.addProperty("error", error);
        }
        String json = new Gson().toJson(payload);
        ApplicationManager.getApplication().invokeLater(() -> context.executeJavaScriptQueued(
                "if (window.onTitleRegenerated) { "
                        + "window.onTitleRegenerated('" + context.escapeJs(json) + "'); }"));
    }

    /**
     * Delete an orphaned custom title entry (B-011: session ID migration cleanup).
     */
    void handleDeleteTitle(String sessionId) {
        CompletableFuture.runAsync(() -> {
            titleFileLock.lock();
            try {
                LOG.info("[HistoryHandler] Deleting orphaned title for sessionId: " + sessionId);
                String result = nodeJsServiceCaller.callNodeJsDeleteTitle(sessionId);
                LOG.info("[HistoryHandler] Delete title result: " + result);
            } catch (Exception e) {
                LOG.warn("[HistoryHandler] Failed to delete orphaned title: " + e.getMessage());
            } finally {
                titleFileLock.unlock();
            }
        });
    }

    /**
     * Push the user-set title of a restored session to the webview.
     * <p>
     * A restored transcript only carries the CLI-derived title (AI title /
     * first prompt), while a title set through the header lives in
     * session-titles.json. Without this push the header shows the stale
     * transcript title until the session is reopened from the history list
     * (which merges custom titles in {@link HistoryLoadService}).
     *
     * @param sessionId the session whose saved title should be applied
     */
    void pushCustomTitle(String sessionId) {
        if (sessionId == null || sessionId.isBlank()) {
            return;
        }
        CompletableFuture.runAsync(() -> {
            try {
                String titlesJson = nodeJsServiceCaller.callNodeJsTitlesService("loadTitles");
                String customTitle = extractCustomTitle(titlesJson, sessionId);
                if (customTitle == null) {
                    return;
                }
                ApplicationManager.getApplication().invokeLater(() -> {
                    if (context.isDisposed()) {
                        return;
                    }
                    context.callJavaScript("restoreSessionTitle",
                            context.escapeJs(sessionId), context.escapeJs(customTitle));
                });
            } catch (Exception e) {
                LOG.warn("[HistoryHandler] 恢复会话标题失败: " + e.getMessage());
            }
        });
    }

    /**
     * Extract one session's custom title from the raw session-titles.json payload.
     *
     * @param titlesJson raw JSON returned by the titles service
     * @param sessionId session to look up
     * @return the custom title, or null when absent, blank or unparsable
     */
    static String extractCustomTitle(String titlesJson, String sessionId) {
        try {
            JsonObject titles = new Gson().fromJson(titlesJson, JsonObject.class);
            if (titles == null || !titles.has(sessionId) || !titles.get(sessionId).isJsonObject()) {
                return null;
            }
            JsonObject titleInfo = titles.getAsJsonObject(sessionId);
            if (!titleInfo.has("customTitle") || titleInfo.get("customTitle").isJsonNull()) {
                return null;
            }
            String customTitle = titleInfo.get("customTitle").getAsString();
            return customTitle.isBlank() ? null : customTitle;
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 解析会话标题失败: " + e.getMessage());
            return null;
        }
    }
}
