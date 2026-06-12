package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.HandlerContext;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.File;
import java.util.concurrent.CompletableFuture;

/**
 * Handles persistence of a user-provided Claude Code CLI executable path.
 *
 * <p>When set, the daemon spawns its Claude Agent SDK with
 * {@code pathToClaudeCodeExecutable} pointing at this binary, overriding the
 * SDK's bundled CLI. Persisted in {@link PropertiesComponent} under
 * {@link #CLAUDE_CLI_PATH_PROPERTY_KEY}; mirrors {@link NodePathHandler}.
 */
public class ClaudeCliPathHandler {

    private static final Logger LOG = Logger.getInstance(ClaudeCliPathHandler.class);

    public static final String CLAUDE_CLI_PATH_PROPERTY_KEY = "claude.code.cli.path";

    private final HandlerContext context;
    private final Gson gson = new Gson();

    public ClaudeCliPathHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Get the configured Claude CLI path (empty string when unset).
     */
    public void handleGetClaudeCliPath() {
        CompletableFuture.runAsync(() -> {
            try {
                String saved = PropertiesComponent.getInstance().getValue(CLAUDE_CLI_PATH_PROPERTY_KEY);
                String pathToSend = (saved != null) ? saved.trim() : "";

                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject response = new JsonObject();
                    response.addProperty("path", pathToSend);
                    context.callJavaScript("window.updateClaudeCliPath", context.escapeJs(gson.toJson(response)));
                });
            } catch (Exception e) {
                LOG.error("[ClaudeCliPathHandler] Failed to get Claude CLI path: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("Failed to load Claude CLI path: " + e.getMessage()))
                );
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[ClaudeCliPathHandler] Unexpected error in handleGetClaudeCliPath: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Persist a custom Claude CLI path. Validates that the path points at an
     * existing file (when non-empty), then shuts down the daemon so the next
     * request picks up the new {@code CLAUDE_CODE_PATH} env var.
     */
    public void handleSetClaudeCliPath(String content) {
        String parsedPath = null;
        try {
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json != null && json.has("path") && !json.get("path").isJsonNull()) {
                parsedPath = json.get("path").getAsString();
            }
        } catch (Exception e) {
            LOG.error("[ClaudeCliPathHandler] Failed to parse set_claude_cli_path content: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.showError", context.escapeJs("Failed to save Claude CLI path: " + e.getMessage()))
            );
            return;
        }
        final String pathArg = (parsedPath != null) ? parsedPath.trim() : null;

        CompletableFuture.runAsync(() -> {
            try {
                PropertiesComponent props = PropertiesComponent.getInstance();
                String finalPath = "";
                boolean success = false;
                String failureMsg = null;

                if (pathArg == null || pathArg.isEmpty()) {
                    props.unsetValue(CLAUDE_CLI_PATH_PROPERTY_KEY);
                    LOG.info("[ClaudeCliPathHandler] Cleared custom Claude CLI path");
                    success = true;
                } else {
                    failureMsg = validateCliPath(new File(pathArg), pathArg);
                    if (failureMsg == null) {
                        props.setValue(CLAUDE_CLI_PATH_PROPERTY_KEY, pathArg);
                        finalPath = pathArg;
                        success = true;
                        LOG.info("[ClaudeCliPathHandler] Saved custom Claude CLI path: " + pathArg);
                    }
                }

                // Restart the daemon so CLAUDE_CODE_PATH is re-injected on next request.
                // The env var is read at daemon spawn, so an in-flight daemon retains the
                // old value until we tear it down. shutdownDaemon() is safe: the next
                // request triggers a fresh start via ClaudeDaemonCoordinator.
                if (success) {
                    try {
                        context.getClaudeSDKBridge().shutdownDaemon();
                    } catch (Exception e) {
                        LOG.warn("[ClaudeCliPathHandler] Failed to shutdown daemon after path change: " + e.getMessage());
                    }
                }

                final boolean successFlag = success;
                final String failureMsgFinal = failureMsg;
                final String finalPathToSend = finalPath;
                // On failure, echo back what the user typed so the input keeps their
                // entry instead of being blanked; on success, reflect the persisted value.
                final String pathToEcho = successFlag
                        ? finalPathToSend
                        : (pathArg != null ? pathArg : "");

                ApplicationManager.getApplication().invokeLater(() -> {
                    JsonObject response = new JsonObject();
                    response.addProperty("path", pathToEcho);
                    context.callJavaScript("window.updateClaudeCliPath", context.escapeJs(gson.toJson(response)));

                    if (successFlag) {
                        String msg = finalPathToSend.isEmpty()
                            ? "Claude CLI path cleared, using bundled SDK"
                            : "Claude CLI path saved: " + finalPathToSend;
                        context.callJavaScript("window.showSwitchSuccess", context.escapeJs(msg));
                    } else {
                        String msg = failureMsgFinal != null ? failureMsgFinal : "Invalid Claude CLI path";
                        context.callJavaScript("window.showError", context.escapeJs(msg));
                    }
                });
            } catch (Exception e) {
                LOG.error("[ClaudeCliPathHandler] Failed to set Claude CLI path: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() ->
                    context.callJavaScript("window.showError", context.escapeJs("Failed to save Claude CLI path: " + e.getMessage()))
                );
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[ClaudeCliPathHandler] Unexpected error in handleSetClaudeCliPath: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Validates a candidate Claude CLI path. Returns {@code null} when the path is a
     * usable executable file, otherwise a human-readable reason. Extracted as a pure
     * static method so the validation branches can be unit-tested without booting the
     * IntelliJ platform (the handler itself depends on {@link PropertiesComponent}).
     */
    static String validateCliPath(File f, String rawPath) {
        if (!f.exists()) {
            return "File does not exist: " + rawPath;
        }
        if (f.isDirectory()) {
            return "Path is a directory, expected an executable file: " + rawPath;
        }
        if (!f.canExecute()) {
            return "File is not executable (check permissions): " + rawPath;
        }
        return null;
    }
}
