package com.github.claudecodegui.handler.history;

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
                        context.executeJavaScriptOnEDT(jsCode);
                    });
                }

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 更新标题失败: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "if (window.addToast) { " +
                                            "  window.addToast('更新标题失败: " + context.escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误") + "', 'error'); " +
                                            "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            } finally {
                titleFileLock.unlock();
            }
        });
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
}
