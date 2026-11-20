package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.util.ClaudeConfigDir;
import com.github.claudecodegui.util.WslPathUtil;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.function.Predicate;
import java.util.function.UnaryOperator;

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
                    failure = validateInput(pathArg, NodeDetector.resolveHomeForFileOps(),
                            ClaudeConfigDir.isWslNode(), WslPathUtil::convertWslPathToWindowsUnc,
                            WslPathUtil::wslDirectoryExists);
                    if (failure == null) {
                        props.setValue(ClaudeConfigDir.CONFIG_DIR_PROPERTY_KEY, pathArg);
                    }
                }

                boolean providerSkipped = false;
                if (failure == null) {
                    TokenTrackerScanRoots.syncFromSettings();
                    providerSkipped = applyActiveProviderToNewDirectory();
                    // CLAUDE_CONFIG_DIR is injected at daemon spawn: other chat tabs replace their
                    // daemon on their next idle request, this tab restarts now.
                    ClaudeSDKBridge.markSdkChanged();
                    try {
                        context.getClaudeSDKBridge().shutdownDaemon();
                    } catch (Exception e) {
                        LOG.warn("[ClaudeConfigDirHandler] Failed to shutdown daemon: " + e.getMessage());
                    }
                }

                final String error = failure;
                final boolean skipped = providerSkipped;
                ApplicationManager.getApplication().invokeLater(() -> {
                    sendPath(pathArg);
                    if (error == null) {
                        context.callJavaScript("window.showSwitchSuccess",
                                context.escapeJs(savedMessage(pathArg, skipped)));
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

    /**
     * A managed provider keeps its credentials in {@code settings.json}, and that file now belongs to
     * the active directory. Bring the provider in, so the next chat request finds its key without a
     * manual provider switch. A directory with API settings of its own is left alone: mixing those
     * with the provider's would send the user's credential to the provider's endpoint.
     *
     * @return true when the provider was not applied because the directory has its own API settings
     */
    private boolean applyActiveProviderToNewDirectory() {
        try {
            return context.getSettingsService().applyActiveProviderToConfigDirectory();
        } catch (Exception e) {
            LOG.warn("[ClaudeConfigDirHandler] Could not apply the active provider to the new directory: "
                    + e.getMessage());
            return false;
        }
    }

    /** The toast shown once the directory is saved (or cleared). */
    static String savedMessage(String path, boolean providerSkipped) {
        String saved = path.isEmpty()
                ? "Claude config directory cleared"
                : "Claude config directory saved: " + path;
        if (!providerSkipped) {
            return saved;
        }
        return saved + ". This directory has its own API settings, so the active provider was not applied."
                + " Choose \"Local settings.json\" to use them, or select the provider again to replace them.";
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

    /**
     * Validates what the user typed. With a WSL node a Linux path is opened through its UNC form,
     * and {@code wslDirectoryExists} is the fallback for the UNC share answering "missing" too early.
     */
    static String validateInput(String raw, String home, boolean wslNode, UnaryOperator<String> linuxToUnc,
                                Predicate<String> wslDirectoryExists) {
        Path dir = ClaudeConfigDir.expand(raw, home, wslNode, linuxToUnc);
        if (dir == null) {
            return "Cannot reach the WSL path (is WSL running?): " + raw;
        }
        String failure = validateConfigDir(dir, raw);
        if (failure != null && wslNode && raw.trim().startsWith("/") && wslDirectoryExists.test(raw.trim())) {
            return null;
        }
        return failure;
    }

    /** Returns null when {@code dir} is an existing absolute directory, otherwise a human-readable reason. */
    static String validateConfigDir(Path dir, String rawPath) {
        if (!dir.isAbsolute()) {
            return "Path must be absolute: " + rawPath;
        }
        if (!Files.exists(dir)) {
            return "Directory does not exist: " + rawPath;
        }
        if (!Files.isDirectory(dir)) {
            return "Path is not a directory: " + rawPath;
        }
        return null;
    }
}
