package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

/**
 * Codex SDK bridge.
 * Handles Java to Node.js Codex SDK communication, supports streaming responses.
 * Uses unified ai-bridge directory (shared with Claude).
 */
public class CodexSDKBridge extends BaseSDKBridge {

    // Codex API configuration
    private String baseUrl = null;
    private String apiKey = null;

    public CodexSDKBridge() {
        super(CodexSDKBridge.class);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "codex";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("CODEX_USE_STDIN", "true");
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            boolean[] hadSendError,
            String[] lastNodeError
    ) {
        if (line.contains("[DEBUG]")) {
            LOG.debug("[Codex] " + line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
        } else if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        } else if (line.startsWith("[THREAD_ID]")) {
            String receivedThreadId = line.substring("[THREAD_ID]".length()).trim();
            callback.onMessage("session_id", receivedThreadId);
        } else if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "unknown";

                    if ("status".equals(msgType)) {
                        String status = "";
                        if (msg.has("message") && !msg.get("message").isJsonNull()) {
                            JsonElement statusEl = msg.get("message");
                            status = statusEl.isJsonPrimitive() ? statusEl.getAsString() : statusEl.toString();
                        }
                        if (status != null && !status.isEmpty()) {
                            callback.onMessage("status", status);
                        }
                        return;
                    }

                    result.messages.add(msg);

                    if ("assistant".equals(msgType)) {
                        try {
                            String extracted = extractAssistantText(msg);
                            if (extracted != null && !extracted.isEmpty()) {
                                assistantContent.append(extracted);
                            }
                        } catch (Exception ignored) {
                        }
                    }

                    callback.onMessage(msgType, jsonStr);
                }
            } catch (Exception ignored) {
            }
        } else if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = line.substring("[CONTENT_DELTA]".length()).trim();
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
        } else if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            // Avoid duplicate
            if (!assistantContent.toString().contains(content)) {
                assistantContent.append(content);
            }
            callback.onMessage("content", content);
        } else if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError[0] = true;
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
        }
    }

    // ============================================================================
    // Codex-specific configuration
    // ============================================================================

    /**
     * Set Codex API base URL.
     */
    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    /**
     * Get Codex API base URL.
     */
    public String getBaseUrl() {
        return this.baseUrl;
    }

    /**
     * Set Codex API key.
     */
    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    /**
     * Get Codex API key.
     */
    public String getApiKey() {
        return this.apiKey;
    }

    /**
     * Set executable permission for Codex binary.
     */
    private void setCodexExecutablePermission(File bridgeDir) {
        try {
            File vendorDir = new File(bridgeDir, "node_modules/@openai/codex-sdk/vendor");
            if (!vendorDir.exists()) {
                LOG.info("vendor directory not found, skipping permission setup");
                return;
            }

            File[] platformDirs = vendorDir.listFiles();
            if (platformDirs == null) return;

            for (File platformDir : platformDirs) {
                if (!platformDir.isDirectory()) continue;

                File codexDir = new File(platformDir, "codex");
                File codexBinary = new File(codexDir, "codex");
                File codexExe = new File(codexDir, "codex.exe");

                if (codexBinary.exists()) {
                    boolean success = codexBinary.setExecutable(true, false);
                    LOG.info("Set executable permission: " + codexBinary.getAbsolutePath() + " -> " + success);
                }
                if (codexExe.exists()) {
                    boolean success = codexExe.setExecutable(true, false);
                    LOG.info("Set executable permission: " + codexExe.getAbsolutePath() + " -> " + success);
                }
            }
        } catch (Exception e) {
            LOG.warn("Failed to set executable permission: " + e.getMessage());
        }
    }

    // ============================================================================
    // Message sending
    // ============================================================================

    /**
     * Send message to Codex (streaming response).
     *
     * Note: Codex uses threadId instead of sessionId
     * Note: Codex does not support attachments
     * Note: Codex does not support system prompts, so agentPrompt is appended to user message
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String threadId,  // Codex uses threadId, not sessionId
            String cwd,
            List<ClaudeSession.Attachment> attachments,  // Ignored for Codex
            String permissionMode,
            String model,
            String agentPrompt,  // Agent prompt (appended to message for Codex)
            String reasoningEffort,  // Codex reasoning effort (thinking depth)
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            final String[] lastNodeError = {null};
            final boolean[] hadSendError = {false};

            try {
                String node = nodeDetector.findNodeExecutable();
                File bridgeDir = getDirectoryResolver().findSdkDir();

                // Ensure Codex SDK binary has executable permission
                setCodexExecutablePermission(bridgeDir);

                // Append agentPrompt to message if provided (Codex doesn't support system prompts)
                String finalMessage = message;
                if (agentPrompt != null && !agentPrompt.isEmpty()) {
                    finalMessage = message + "\n\n## Agent Role and Instructions\n\n" + agentPrompt;
                    LOG.info("[Agent] ✓ Appending agentPrompt to user message for Codex (length: " + agentPrompt.length() + " chars)");
                }

                // Build stdin input JSON
                // Note: Codex uses 'threadId' (not 'sessionId')
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("message", finalMessage);
                stdinInput.addProperty("threadId", threadId != null ? threadId : "");
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
                stdinInput.addProperty("model", model != null ? model : "");
                // Reasoning effort (thinking depth)
                stdinInput.addProperty("reasoningEffort", reasoningEffort != null ? reasoningEffort : "medium");
                // API configuration
                stdinInput.addProperty("baseUrl", baseUrl != null ? baseUrl : "");
                stdinInput.addProperty("apiKey", apiKey != null ? apiKey : "");
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("codex");
                command.add("send");

                File processTempDir = processManager.prepareClaudeTempDir();
                Set<String> existingTempMarkers = processManager.snapshotClaudeCwdFiles(processTempDir);

                ProcessBuilder pb = new ProcessBuilder(command);

                // Set working directory
                if (cwd != null && !cwd.isEmpty() && !"undefined".equals(cwd) && !"null".equals(cwd)) {
                    File userWorkDir = new File(cwd);
                    if (userWorkDir.exists() && userWorkDir.isDirectory()) {
                        pb.directory(userWorkDir);
                    } else {
                        pb.directory(bridgeDir);
                    }
                } else {
                    pb.directory(bridgeDir);
                }

                // Configure environment variables
                Map<String, String> env = pb.environment();
                envConfigurator.configureTempDir(env, processTempDir);
                env.put("CODEX_USE_STDIN", "true");

                // Set model via environment variable if specified
                if (model != null && !model.isEmpty()) {
                    env.put("CODEX_MODEL", model);
                }

                // 【关键修复】通过环境变量覆盖用户配置文件中的 sandbox 和 approval 设置
                // Override user's ~/.codex/config.toml settings via environment variables
                if (permissionMode != null && !permissionMode.isEmpty()) {
                    switch (permissionMode) {
                        case "bypassPermissions":
                            env.put("CODEX_SANDBOX_MODE", "workspace-write");
                            env.put("CODEX_APPROVAL_POLICY", "never");
                            break;
                        case "acceptEdits":
                            env.put("CODEX_SANDBOX_MODE", "workspace-write");
                            env.put("CODEX_APPROVAL_POLICY", "auto-edit");
                            break;
                        case "plan":
                            env.put("CODEX_SANDBOX_MODE", "read-only");
                            env.put("CODEX_APPROVAL_POLICY", "untrusted");
                            break;
                        default:
                            // Default mode: workspace-write with confirmation
                            env.put("CODEX_SANDBOX_MODE", "workspace-write");
                            env.put("CODEX_APPROVAL_POLICY", "untrusted");
                            break;
                    }
                    LOG.info("[Codex] Permission env override: SANDBOX_MODE=" +
                             env.get("CODEX_SANDBOX_MODE") + ", APPROVAL_POLICY=" +
                             env.get("CODEX_APPROVAL_POLICY") + " (from permissionMode=" + permissionMode + ")");
                }

                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);

                // Configure Codex-specific env vars from ~/.codex/config.toml
                envConfigurator.configureCodexEnv(env);

                LOG.info("Command: " + String.join(" ", command));

                Process process = null;
                try {
                    process = pb.start();
                    processManager.registerProcess(channelId, process);

                    // Write to stdin
                    try (java.io.OutputStream stdin = process.getOutputStream()) {
                        stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                        stdin.flush();
                    } catch (Exception e) {
                        LOG.warn("Failed to write stdin: " + e.getMessage());
                    }

                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                        String line;
                        while ((line = reader.readLine()) != null) {
                            // Capture Node.js error logs
                            if (line.startsWith("[UNCAUGHT_ERROR]")
                                    || line.startsWith("[UNHANDLED_REJECTION]")
                                    || line.startsWith("[COMMAND_ERROR]")) {
                                LOG.warn("[Node.js ERROR] " + line);
                                lastNodeError[0] = line;
                            }

                            // Print debug logs
                            if (line.contains("[DEBUG]")) {
                                LOG.debug("[Codex] " + line);
                            }

                            // Parse messages
                            if (line.startsWith("[MESSAGE_START]")) {
                                callback.onMessage("message_start", "");
                            } else if (line.startsWith("[MESSAGE_END]")) {
                                callback.onMessage("message_end", "");
                            } else if (line.startsWith("[THREAD_ID]")) {
                                String receivedThreadId = line.substring("[THREAD_ID]".length()).trim();
                                callback.onMessage("session_id", receivedThreadId);
                            } else if (line.startsWith("[MESSAGE]")) {
                                String jsonStr = line.substring("[MESSAGE]".length()).trim();
                                try {
                                    JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                                    if (msg != null) {
                                        String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                                                ? msg.get("type").getAsString()
                                                : "unknown";

                                        if ("status".equals(msgType)) {
                                            String status = "";
                                            if (msg.has("message") && !msg.get("message").isJsonNull()) {
                                                JsonElement statusEl = msg.get("message");
                                                status = statusEl.isJsonPrimitive() ? statusEl.getAsString() : statusEl.toString();
                                            }
                                            if (status != null && !status.isEmpty()) {
                                                callback.onMessage("status", status);
                                            }
                                            continue;
                                        }

                                        result.messages.add(msg);

                                        if ("assistant".equals(msgType)) {
                                            try {
                                                String extracted = extractAssistantText(msg);
                                                if (extracted != null && !extracted.isEmpty()) {
                                                    assistantContent.append(extracted);
                                                }
                                            } catch (Exception ignored) {
                                            }
                                        }

                                        callback.onMessage(msgType, jsonStr);
                                    }
                                } catch (Exception ignored) {
                                }
                            } else if (line.startsWith("[CONTENT_DELTA]")) {
                                String delta = line.substring("[CONTENT_DELTA]".length()).trim();
                                assistantContent.append(delta);
                                callback.onMessage("content_delta", delta);
                            } else if (line.startsWith("[CONTENT]")) {
                                String content = line.substring("[CONTENT]".length()).trim();
                                // Avoid duplicate
                                if (!assistantContent.toString().contains(content)) {
                                    assistantContent.append(content);
                                }
                                callback.onMessage("content", content);
                            } else if (line.startsWith("[SEND_ERROR]")) {
                                String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
                                String errorMessage = jsonStr;
                                try {
                                    JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                                    if (obj.has("error")) {
                                        errorMessage = obj.get("error").getAsString();
                                    }
                                } catch (Exception ignored) {
                                }
                                hadSendError[0] = true;
                                result.success = false;
                                result.error = errorMessage;
                                callback.onError(errorMessage);
                            }
                        }
                    }

                    process.waitFor();

                    int exitCode = process.exitValue();
                    boolean wasInterrupted = processManager.wasInterrupted(channelId);

                    result.finalResult = assistantContent.toString();
                    result.messageCount = result.messages.size();

                    if (wasInterrupted) {
                        result.success = false;
                        result.error = "User interrupted";
                        callback.onComplete(result);
                    } else if (!hadSendError[0]) {
                        result.success = exitCode == 0;
                        if (result.success) {
                            callback.onComplete(result);
                        } else {
                            String errorMsg = "Codex process exited with code: " + exitCode;
                            if (lastNodeError[0] != null && !lastNodeError[0].isEmpty()) {
                                errorMsg = errorMsg + " | Last error: " + lastNodeError[0];
                            }
                            result.error = errorMsg;
                            callback.onError(errorMsg);
                        }
                    }

                    return result;
                } finally {
                    processManager.unregisterProcess(channelId, process);
                    processManager.waitForProcessTermination(process);
                    processManager.cleanupClaudeTempFiles(processTempDir, existingTempMarkers);
                }

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                callback.onError(e.getMessage());
                return result;
            }
        });
    }

    /**
     * Get session history messages (Codex doesn't support this, returns empty list).
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        LOG.info("getSessionMessages not supported by Codex SDK");
        return new ArrayList<>();
    }

    // ============================================================================
    // Utility methods
    // ============================================================================

    private String extractAssistantText(JsonObject msg) {
        if (msg == null) return "";
        if (!msg.has("message") || !msg.get("message").isJsonObject()) return "";

        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) return "";

        JsonElement contentEl = message.get("content");
        if (contentEl.isJsonPrimitive()) {
            return contentEl.getAsString();
        }
        if (!contentEl.isJsonArray()) {
            return "";
        }

        JsonArray arr = contentEl.getAsJsonArray();
        StringBuilder sb = new StringBuilder();
        for (JsonElement el : arr) {
            if (!el.isJsonObject()) continue;
            JsonObject block = el.getAsJsonObject();
            if (!block.has("type") || block.get("type").isJsonNull()) continue;
            String type = block.get("type").getAsString();
            if ("text".equals(type) && block.has("text") && !block.get("text").isJsonNull()) {
                if (sb.length() > 0) sb.append("\n");
                sb.append(block.get("text").getAsString());
            }
        }
        return sb.toString();
    }
}
