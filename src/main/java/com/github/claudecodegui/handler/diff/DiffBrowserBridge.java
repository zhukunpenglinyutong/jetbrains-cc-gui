package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.handler.HandlerContext;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Diff 相关的浏览器通信桥接
 * 封装 Java → WebView 的 JavaScript 调用
 */
public class DiffBrowserBridge {

    private static final Logger LOG = Logger.getInstance(DiffBrowserBridge.class);
    private final HandlerContext context;
    private final Gson gson;

    public DiffBrowserBridge(HandlerContext context, Gson gson) {
        this.context = context;
        this.gson = gson;
    }

    /**
     * 在 WebView 中显示错误提示
     */
    public void showErrorToast(String message) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getBrowser() == null || context.isDisposed()) {
                    LOG.warn("Cannot show error toast: browser is null or disposed");
                    return;
                }
                String escapedMsg = JsUtils.escapeJs(message);
                String js = "if (window.addToast) { window.addToast('" + escapedMsg + "', 'error'); }";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } catch (Exception e) {
                LOG.error("Failed to show error toast: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 通知前端从编辑列表中移除文件
     */
    public void sendRemoveFileFromEdits(String filePath) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getBrowser() == null || context.isDisposed()) {
                    LOG.warn("Cannot send remove_file_from_edits: browser is null or disposed");
                    return;
                }
                JsonObject payload = new JsonObject();
                payload.addProperty("filePath", filePath);
                String payloadJson = gson.toJson(payload);
                String js = "(function() {" +
                        "  if (typeof window.handleRemoveFileFromEdits === 'function') {" +
                        "    window.handleRemoveFileFromEdits('" + JsUtils.escapeJs(payloadJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
            } catch (Exception e) {
                LOG.error("Failed to send remove_file_from_edits message: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 发送 diff 结果到前端
     */
    public void sendDiffResult(String filePath, String action, String content, String error) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (context.getBrowser() == null || context.isDisposed()) {
                    LOG.warn("Cannot send diff_result: browser is null or disposed");
                    return;
                }

                JsonObject payload = new JsonObject();
                payload.addProperty("filePath", filePath);
                payload.addProperty("action", action);
                if (content != null) {
                    payload.addProperty("content", content);
                }
                if (error != null) {
                    payload.addProperty("error", error);
                }

                String payloadJson = gson.toJson(payload);
                String js = "(function() {" +
                        "  if (typeof window.handleDiffResult === 'function') {" +
                        "    window.handleDiffResult('" + JsUtils.escapeJs(payloadJson) + "');" +
                        "  }" +
                        "})();";
                context.getBrowser().getCefBrowser().executeJavaScript(js, context.getBrowser().getCefBrowser().getURL(), 0);
                LOG.info("Diff result sent to frontend: " + action + " for " + filePath);
            } catch (Exception e) {
                LOG.error("Failed to send diff_result message: " + e.getMessage(), e);
            }
        });
    }
}
