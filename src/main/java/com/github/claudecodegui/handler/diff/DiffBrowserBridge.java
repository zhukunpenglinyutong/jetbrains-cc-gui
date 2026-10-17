package com.github.claudecodegui.handler.diff;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Browser communication bridge for diff operations.
 * Encapsulates Java to WebView JavaScript calls.
 */
public class DiffBrowserBridge {

    private static final Logger LOG = Logger.getInstance(DiffBrowserBridge.class);
    private final HandlerContext context;
    private final Gson gson;

    /** Creates the browser bridge for a chat window. */
    public DiffBrowserBridge(HandlerContext context, Gson gson) {
        this.context = context;
        this.gson = gson;
    }

    /**
     * Show an error toast in the WebView.
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
     * Notify the frontend to remove a file from the edits list.
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
     * Send diff result to the frontend.
     */
    public void sendDiffResult(String filePath, String action, String content, String error) {
        this.sendDiffResult(filePath, action, content, error, null);
    }

    /** Sends a reviewed diff result with the chat and operation identities captured when it opened. */
    public void sendDiffResult(String filePath, String action, String content, String error, JsonObject reviewOrigin) {
        ApplicationManager.getApplication().invokeLater(() -> {
            try {
                if (this.context.getBrowser() == null || this.context.isDisposed()) {
                    LOG.warn("Cannot send diff_result: browser is null or disposed");
                    return;
                }

                JsonObject payload = reviewOrigin == null ? new JsonObject() : reviewOrigin.deepCopy();
                payload.addProperty("filePath", filePath);
                payload.addProperty("action", action);
                if (content != null) {
                    payload.addProperty("content", content);
                }
                if (error != null) {
                    payload.addProperty("error", error);
                }

                // Explicitly unbound reviews must not acquire the newly selected chat's identity.
                String payloadJson = payload.toString();
                String js = "(function() {" +
                        "  if (typeof window.handleDiffResult === 'function') {" +
                        "    window.handleDiffResult('" + JsUtils.escapeJs(payloadJson) + "');" +
                        "  }" +
                        "})();";
                this.context.getBrowser().getCefBrowser().executeJavaScript(js, this.context.getBrowser().getCefBrowser().getURL(), 0);
                LOG.info("Diff result sent to frontend: " + action + " for " + filePath);
            } catch (Exception e) {
                LOG.error("Failed to send diff_result message: " + e.getMessage(), e);
            }
        });
    }
}
