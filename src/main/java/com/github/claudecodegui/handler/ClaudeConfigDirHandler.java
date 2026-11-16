package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.ClaudeConfigDir;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;

/**
 * Persists the Claude configuration directory (the plugin-side equivalent of
 * {@code CLAUDE_CONFIG_DIR}) used for history, usage statistics and the daemon.
 * Stored under {@link ClaudeConfigDir#CONFIG_DIR_PROPERTY_KEY}; mirrors {@link ClaudeCliPathHandler}.
 */
public class ClaudeConfigDirHandler {

    private static final Logger LOG = Logger.getInstance(ClaudeConfigDirHandler.class);

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public ClaudeConfigDirHandler(HandlerContext context) {
        this.context = context;
    }

    public void handleGetClaudeConfigDir() {
        CompletableFuture.runAsync(() -> {
            String saved = PropertiesComponent.getInstance().getValue(ClaudeConfigDir.CONFIG_DIR_PROPERTY_KEY);
            sendPath(saved != null ? saved.trim() : "");
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[ClaudeConfigDirHandler] Failed to get Claude config dir: " + ex.getMessage(), ex);
            return null;
        });
    }

    public void handleSetClaudeConfigDir(String content) {
        String parsed = null;
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json != null && json.has("path") && !json.get("path").isJsonNull()) {
                parsed = json.get("path").getAsString();
            }
        } catch (Exception e) {
            showError("Failed to save Claude config directory: " + e.getMessage());
            return;
        }
        final String pathArg = parsed != null ? parsed.trim() : "";

        CompletableFuture.runAsync(() -> {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String failure = null;
                if (pathArg.isEmpty()) {
                    props.unsetValue(ClaudeConfigDir.CONFIG_DIR_PROPERTY_KEY);
                } else {
                    failure = validateConfigDir(
                            ClaudeConfigDir.resolve(pathArg, null, NodeDetector.resolveHomeForFileOps()), pathArg);
                    if (failure == null) {
                        props.setValue(ClaudeConfigDir.CONFIG_DIR_PROPERTY_KEY, pathArg);
                    }
                }

                if (failure == null) {
                    try {
                        // CLAUDE_CONFIG_DIR is injected at daemon spawn, so restart it.
                        context.getClaudeSDKBridge().shutdownDaemon();
                    } catch (Exception e) {
                        LOG.warn("[ClaudeConfigDirHandler] Failed to shutdown daemon: " + e.getMessage());
                    }
                }

                final String error = failure;
                ApplicationManager.getApplication().invokeLater(() -> {
                    sendPath(pathArg);
                    if (error == null) {
                        context.callJavaScript("window.showSwitchSuccess", context.escapeJs(
                                pathArg.isEmpty() ? "Claude config directory cleared" : "Claude config directory saved: " + pathArg));
                    } else {
                        context.callJavaScript("window.showError", context.escapeJs(error));
                    }
                });
            } catch (Exception e) {
                LOG.error("[ClaudeConfigDirHandler] Failed to set Claude config dir: " + e.getMessage(), e);
                showError("Failed to save Claude config directory: " + e.getMessage());
            }
        }, AppExecutorUtil.getAppExecutorService());
    }

    private void sendPath(String path) {
        ApplicationManager.getApplication().invokeLater(() -> {
            JsonObject response = new JsonObject();
            response.addProperty("path", path);
            context.callJavaScript("window.updateClaudeConfigDir", context.escapeJs(gson.toJson(response)));
        });
    }

    private void showError(String message) {
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs(message)));
    }

    /** Returns null when {@code dir} is an existing directory, otherwise a human-readable reason. */
    static String validateConfigDir(Path dir, String rawPath) {
        if (!Files.exists(dir)) {
            return "Directory does not exist: " + rawPath;
        }
        if (!Files.isDirectory(dir)) {
            return "Path is not a directory: " + rawPath;
        }
        return null;
    }
}
