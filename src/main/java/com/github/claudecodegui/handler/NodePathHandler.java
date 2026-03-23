package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.concurrent.CompletableFuture;

/**
 * Handles Node.js path detection, verification, and persistence.
 */
public class NodePathHandler {

    private static final Logger LOG = Logger.getInstance(NodePathHandler.class);

    static final String NODE_PATH_PROPERTY_KEY = "claude.code.node.path";

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public NodePathHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Get Node.js path and version information.
     * Runs detection/verification in a background thread to avoid blocking the CEF IO thread.
     */
    public void handleGetNodePath() {
        CompletableFuture.runAsync(() -> {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String saved = props.getValue(NODE_PATH_PROPERTY_KEY);
                String pathToSend = "";
                String versionToSend = null;

                if (saved != null && !saved.trim().isEmpty()) {
                    pathToSend = saved.trim();
                    NodeDetectionResult result = context.getClaudeSDKBridge().verifyAndCacheNodePath(pathToSend);
                    if (result != null && result.isFound()) {
                        versionToSend = result.getNodeVersion();
                    }
                } else {
                    NodeDetectionResult detected = context.getClaudeSDKBridge().detectNodeWithDetails();
                    if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                        pathToSend = detected.getNodePath();
                        versionToSend = detected.getNodeVersion();
                        props.setValue(NODE_PATH_PROPERTY_KEY, pathToSend);
                        // Use verifyAndCacheNodePath instead of setNodeExecutable to ensure version info is cached
                        context.getClaudeSDKBridge().verifyAndCacheNodePath(pathToSend);
                        context.getCodexSDKBridge().setNodeExecutable(pathToSend);
                    }
                }

                final String finalPath = pathToSend;
                final String finalVersion = versionToSend;

                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject response = new JsonObject();
                    response.addProperty("path", finalPath);
                    response.addProperty("version", finalVersion);
                    response.addProperty("minVersion", NodeDetector.MIN_NODE_MAJOR_VERSION);
                    context.callJavaScript("window.updateNodePath", context.escapeJs(gson.toJson(response)));
                });
            } catch (Exception e) {
                LOG.error("[NodePathHandler] Failed to get Node.js path: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("获取 Node.js 路径失败: " + e.getMessage()))
                );
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[NodePathHandler] Unexpected error in handleGetNodePath: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Set Node.js path.
     * JSON parsing runs on the CEF IO thread (safe, no I/O), while verification/detection
     * runs in a background thread to avoid blocking the CEF IO thread.
     */
    public void handleSetNodePath(String content) {
        LOG.debug("[NodePathHandler] ========== handleSetNodePath START ==========");
        LOG.debug("[NodePathHandler] Received content: " + content);

        // Parse path on the CEF IO thread — pure JSON parsing, no I/O, safe to do synchronously
        String parsedPath = null;
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json != null && json.has("path") && !json.get("path").isJsonNull()) {
                parsedPath = json.get("path").getAsString();
            }
        } catch (Exception e) {
            LOG.error("[NodePathHandler] Failed to parse set_node_path content: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("保存 Node.js 路径失败: " + e.getMessage()))
            );
            return;
        }
        final String pathArg = (parsedPath != null) ? parsedPath.trim() : null;

        // All I/O and process-spawning runs in a background thread
        CompletableFuture.runAsync(() -> {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String finalPath = "";
                String versionToSend = null;
                boolean verifySuccess = false;
                String failureMsg = null;

                if (pathArg == null || pathArg.isEmpty()) {
                    props.unsetValue(NODE_PATH_PROPERTY_KEY);
                    context.getClaudeSDKBridge().setNodeExecutable(null);
                    context.getCodexSDKBridge().setNodeExecutable(null);
                    LOG.info("[NodePathHandler] Cleared manual Node.js path from settings");

                    NodeDetectionResult detected = context.getClaudeSDKBridge().detectNodeWithDetails();
                    if (detected != null && detected.isFound() && detected.getNodePath() != null) {
                        finalPath = detected.getNodePath();
                        versionToSend = detected.getNodeVersion();
                        props.setValue(NODE_PATH_PROPERTY_KEY, finalPath);
                        // Use verifyAndCacheNodePath to ensure version info is cached
                        context.getClaudeSDKBridge().verifyAndCacheNodePath(finalPath);
                        context.getCodexSDKBridge().setNodeExecutable(finalPath);
                        verifySuccess = true;
                    } else {
                        failureMsg = "已清空自定义路径，但无法自动检测到 Node.js，请手动配置路径";
                    }
                } else {
                    props.setValue(NODE_PATH_PROPERTY_KEY, pathArg);
                    NodeDetectionResult result = context.getClaudeSDKBridge().verifyAndCacheNodePath(pathArg);
                    LOG.info("[NodePathHandler] Updated manual Node.js path from settings: " + pathArg);
                    finalPath = pathArg;
                    if (result != null && result.isFound()) {
                        context.getCodexSDKBridge().setNodeExecutable(pathArg);
                        versionToSend = result.getNodeVersion();
                        verifySuccess = true;
                    } else {
                        failureMsg = result != null ? result.getErrorMessage() : "无法验证指定的 Node.js 路径";
                    }
                }

                final boolean successFlag = verifySuccess;
                final String failureMsgFinal = failureMsg;
                final String finalPathToSend = finalPath;
                final String finalVersionToSend = versionToSend;

                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject response = new JsonObject();
                    response.addProperty("path", finalPathToSend);
                    response.addProperty("version", finalVersionToSend);
                    response.addProperty("minVersion", NodeDetector.MIN_NODE_MAJOR_VERSION);
                    context.callJavaScript("window.updateNodePath", context.escapeJs(gson.toJson(response)));

                    if (successFlag) {
                        // Trigger environment re-check, no IDE restart needed
                        context.callJavaScript("window.showSwitchSuccess", context.escapeJs("Node.js 路径已保存并生效,无需重启IDE"));

                        // Notify DependencySection to re-check Node.js environment
                        context.callJavaScript("window.checkNodeEnvironment");
                    } else {
                        String msg = failureMsgFinal != null ? failureMsgFinal : "无法验证指定的 Node.js 路径";
                        context.callJavaScript("window.showError", context.escapeJs("保存的 Node.js 路径无效: " + msg));
                    }
                });
            } catch (Exception e) {
                LOG.error("[NodePathHandler] Failed to set Node.js path: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("保存 Node.js 路径失败: " + e.getMessage()))
                );
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[NodePathHandler] Unexpected error in handleSetNodePath: " + ex.getMessage(), ex);
            return null;
        });

        LOG.debug("[NodePathHandler] ========== handleSetNodePath END (async dispatched) ==========");
    }
}
