package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Prompt suggestion handler.
 * Generates next-input predictions by calling the AI service after each response completes.
 * Extracts recent messages from the current session state to build context.
 */
public class PromptSuggestionHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PromptSuggestionHandler.class);
    private final Gson gson = new Gson();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

    // Maximum number of recent message pairs to include (user + assistant)
    private static final int MAX_RECENT_PAIRS = 3;
    // Timeout for the Node.js process (seconds)
    private static final int PROCESS_TIMEOUT_SECONDS = 30;

    private static final String[] SUPPORTED_TYPES = {
        "request_prompt_suggestion"
    };

    public PromptSuggestionHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("request_prompt_suggestion".equals(type)) {
            handleRequestSuggestion();
            return true;
        }
        return false;
    }

    /**
     * Handle a suggestion request.
     * Extracts recent messages from session state and spawns Node.js to generate suggestion.
     */
    private void handleRequestSuggestion() {
        if (!isEnabledInSettings()) {
            LOG.info("[PromptSuggestion] Disabled via settings.json");
            return;
        }

        LOG.info("[PromptSuggestion] Request received, starting async generation");

        CompletableFuture.runAsync(() -> {
            try {
                String payload = buildPayloadFromSession();
                if (payload == null) {
                    LOG.info("[PromptSuggestion] No messages in session, skipping");
                    return;
                }
                LOG.info("[PromptSuggestion] Payload built (" + payload.length() + " chars), calling service...");
                LOG.debug("[PromptSuggestion] Payload: " + payload);

                String suggestion = callPromptSuggestionService(payload);
                if (suggestion != null && !suggestion.isEmpty()) {
                    LOG.info("[PromptSuggestion] Got suggestion: " + suggestion);
                    sendSuggestionToFrontend(suggestion);
                } else {
                    LOG.info("[PromptSuggestion] No suggestion generated");
                }
            } catch (Exception e) {
                LOG.warn("[PromptSuggestion] Failed: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Build the JSON payload for the Node.js service from session messages.
     * Extracts the last N user-assistant message pairs.
     */
    private String buildPayloadFromSession() {
        ClaudeSession session = context.getSession();
        if (session == null) return null;

        List<ClaudeSession.Message> allMessages = session.getMessages();
        if (allMessages == null || allMessages.isEmpty()) return null;

        // Extract recent user/assistant messages, skip tool_result placeholders and empty content
        List<ClaudeSession.Message> relevantMessages = new ArrayList<>();
        for (ClaudeSession.Message msg : allMessages) {
            if (msg.type != ClaudeSession.Message.Type.USER &&
                msg.type != ClaudeSession.Message.Type.ASSISTANT) continue;
            String c = msg.content != null ? msg.content.trim() : "";
            if (c.isEmpty() || "[tool_result]".equals(c)) continue;
            relevantMessages.add(msg);
        }

        // Take the last (MAX_RECENT_PAIRS * 2) messages
        int startIdx = Math.max(0, relevantMessages.size() - MAX_RECENT_PAIRS * 2);
        JsonArray recentArray = new JsonArray();
        for (int i = startIdx; i < relevantMessages.size(); i++) {
            ClaudeSession.Message msg = relevantMessages.get(i);
            JsonObject msgObj = new JsonObject();
            msgObj.addProperty("role", msg.type == ClaudeSession.Message.Type.USER ? "user" : "assistant");
            // Truncate very long messages
            String content = msg.content != null ? msg.content : "";
            if (content.length() > 1000) {
                content = content.substring(0, 1000) + "...";
            }
            msgObj.addProperty("content", content);
            recentArray.add(msgObj);
        }

        if (recentArray.isEmpty()) return null;

        JsonObject payload = new JsonObject();
        payload.add("recentMessages", recentArray);
        return gson.toJson(payload);
    }

    /**
     * Call the Node.js prompt-suggestion service.
     */
    private String callPromptSuggestionService(String stdinPayload) {
        try {
            String nodeExecutable = context.getClaudeSDKBridge().getNodeExecutable();
            if (nodeExecutable == null) {
                LOG.error("[PromptSuggestion] Node.js not configured");
                return null;
            }

            File bridgeDir = context.getClaudeSDKBridge().getSdkTestDir();
            if (bridgeDir == null || !bridgeDir.exists()) {
                LOG.error("[PromptSuggestion] AI Bridge directory not found");
                return null;
            }

            File scriptFile = new File(bridgeDir, "services/prompt-suggestion.js");
            if (!scriptFile.exists()) {
                LOG.error("[PromptSuggestion] Script not found: " + scriptFile.getAbsolutePath());
                return null;
            }

            List<String> command = new ArrayList<>();
            command.add(nodeExecutable);
            command.add(scriptFile.getAbsolutePath());

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);

            envConfigurator.updateProcessEnvironment(pb, nodeExecutable);

            LOG.info("[PromptSuggestion] Starting: " + String.join(" ", command));
            Process process = pb.start();

            // Send the recent messages payload via stdin
            try (OutputStreamWriter writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
                writer.write(stdinPayload);
                writer.flush();
            }

            // Read output and look for the [PROMPT_SUGGESTION] tag
            StringBuilder suggestion = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.startsWith("[PROMPT_SUGGESTION]")) {
                        String text = line.substring("[PROMPT_SUGGESTION]".length()).trim();
                        text = text.replace("{{NEWLINE}}", "\n");
                        suggestion.append(text);
                    } else if (line.startsWith("[PROMPT_SUGGESTION_ERROR]")) {
                        LOG.warn("[PromptSuggestion] Service error: " + line.substring("[PROMPT_SUGGESTION_ERROR]".length()));
                    } else {
                        LOG.debug("[PromptSuggestion] stdout: " + line);
                    }
                }
            }

            boolean finished = process.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                LOG.warn("[PromptSuggestion] Process timed out after " + PROCESS_TIMEOUT_SECONDS + "s");
                process.destroyForcibly();
                return null;
            }

            int exitCode = process.exitValue();
            if (exitCode != 0) {
                LOG.warn("[PromptSuggestion] Process exited with code " + exitCode);
            }

            return suggestion.toString();

        } catch (Exception e) {
            LOG.error("[PromptSuggestion] Service call failed: " + e.getMessage(), e);
            return null;
        }
    }

    /**
     * Send the suggestion to the frontend via JS callback.
     */
    private void sendSuggestionToFrontend(String suggestion) {
        callJavaScript("window.onPromptSuggestion", escapeJs(suggestion));
    }

    /**
     * Check if prompt suggestion is enabled in ~/.claude/settings.json.
     * Claude CLI stores this as top-level "promptSuggestionEnabled" field.
     * Default is true (enabled); only explicitly false disables it.
     */
    private boolean isEnabledInSettings() {
        try {
            return context.getSettingsService().isPromptSuggestionEnabled();
        } catch (Exception e) {
            return true;
        }
    }
}
