package com.github.claudecodegui.handler;

import com.github.claudecodegui.provider.common.CLIDaemonBridge;
import com.github.claudecodegui.settings.CLISettingsManager;
import com.github.claudecodegui.skill.SlashCommandRegistry;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/**
 * Handler for Claude Code CLI native commands.
 * Routes CLI commands (like /plan, /review, /commit) to the CLI daemon
 * or falls back to API mode when CLI is unavailable.
 */
public class CLICommandHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CLICommandHandler.class);
    private static final String CLI_EXECUTE_METHOD = "cli.execute";

    private final CLIDaemonBridge cliDaemonBridge;
    private final CLISettingsManager cliSettingsManager;

    public CLICommandHandler(
            HandlerContext context,
            CLIDaemonBridge cliDaemonBridge,
            CLISettingsManager cliSettingsManager
    ) {
        super(context);
        this.cliDaemonBridge = cliDaemonBridge;
        this.cliSettingsManager = cliSettingsManager;
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"chat".equals(type)) {
            return false;
        }

        if (content == null || content.isEmpty()) {
            return false;
        }

        String trimmedContent = content.trim();

        // Check if this is a CLI native command using centralized registry
        if (!SlashCommandRegistry.isCLICommand(trimmedContent)) {
            return false;
        }

        // If CLI is not available and fallback is disabled, let other handlers handle it
        if (!cliSettingsManager.isCliDetected() && !cliSettingsManager.isFallbackToAPI()) {
            LOG.info("[CLICommandHandler] CLI not detected and fallback disabled, passing to next handler");
            return false;
        }

        // Execute via CLI daemon or fallback to API
        if (cliSettingsManager.isCliDetected() && cliDaemonBridge.isAlive()) {
            executeViaCLI(trimmedContent);
        } else {
            LOG.info("[CLICommandHandler] CLI not available, falling back to API mode");
            // Send as regular message to API (will be handled by PromptHandler)
            return false; // Let PromptHandler handle it
        }

        return true;
    }

    @Override
    public String[] getSupportedTypes() {
        return new String[]{"chat"};
    }

    /**
     * Execute a command via the CLI daemon.
     */
    private void executeViaCLI(String command) {
        // Parse command using centralized registry helper
        String commandName = SlashCommandRegistry.getCommandName(command);
        String args = SlashCommandRegistry.getCommandArgs(command);

        LOG.info("[CLICommandHandler] Executing via CLI: " + commandName + " " + args);

        // Build parameters for the CLI daemon
        JsonObject params = new JsonObject();
        params.addProperty("command", commandName);
        params.addProperty("args", args);

        // Create callback for handling CLI output
        CLIDaemonBridge.DaemonOutputCallback callback = new CLIDaemonBridge.DaemonOutputCallback() {
            @Override
            public void onLine(String line) {
                sendToFrontend("stream", line);
            }

            @Override
            public void onStderr(String text) {
                sendToFrontend("error", text);
            }

            @Override
            public void onError(String error) {
                sendToFrontend("error", error);
            }

            @Override
            public void onComplete(boolean success) {
                JsonObject result = new JsonObject();
                result.addProperty("done", true);
                result.addProperty("success", success);
                sendToFrontend("cliComplete", result.toString());
            }
        };

        // Send command to CLI daemon
        cliDaemonBridge.sendCommand(CLI_EXECUTE_METHOD, params, callback);
    }

    /**
     * Send a message to the frontend JavaScript.
     */
    private void sendToFrontend(String type, String content) {
        try {
            JsonObject message = new JsonObject();
            message.addProperty("type", type);
            message.addProperty("content", content);

            // Escape the JSON string for JavaScript
            String escaped = escapeJs(message.toString());
            executeJavaScript("window.handleBackendMessage(" + escaped + ");");
        } catch (Exception e) {
            LOG.error("[CLICommandHandler] Failed to send message to frontend: " + e.getMessage());
        }
    }

    /**
     * Check if CLI is available and ready.
     */
    public boolean isCLIAvailable() {
        return cliSettingsManager.isCliDetected() && cliDaemonBridge.isAlive();
    }

    /**
     * Get CLI status information.
     */
    public JsonObject getCLIStatus() {
        JsonObject status = new JsonObject();
        status.addProperty("cliDetected", cliSettingsManager.isCliDetected());
        status.addProperty("cliPath", cliSettingsManager.getCliExecutablePath());
        status.addProperty("cliVersion", cliSettingsManager.getCliVersion());
        status.addProperty("daemonRunning", cliDaemonBridge.isAlive());
        status.addProperty("fallbackEnabled", cliSettingsManager.isFallbackToAPI());
        return status;
    }
}
