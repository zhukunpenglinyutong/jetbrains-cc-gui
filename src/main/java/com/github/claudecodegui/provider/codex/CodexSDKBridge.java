package com.github.claudecodegui.provider.codex;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.dependency.DependencyManager;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.util.PlatformUtils;

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
     * Codex SDK is installed in ~/.codemoss/dependencies/codex-sdk/, not in ai-bridge.
     */
    private void setCodexExecutablePermission(File bridgeDir) {
        try {
            // Codex SDK is installed in ~/.codemoss/dependencies/codex-sdk/
            // not in ai-bridge directory
            DependencyManager depManager = new DependencyManager();
            File sdkNodeModules = depManager.getSdkNodeModulesDir("codex-sdk").toFile();
            File vendorDir = new File(sdkNodeModules, "@openai/codex-sdk/vendor");

            if (!vendorDir.exists()) {
                LOG.info("Codex vendor directory not found at: " + vendorDir.getAbsolutePath() + ", skipping permission setup");
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
     * Note: Codex supports images via local_image type (requires file path, not base64)
     * Note: Codex does not support system prompts, so agentPrompt is appended to user message
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String threadId,  // Codex uses threadId, not sessionId
            String cwd,
            List<ClaudeSession.Attachment> attachments,  // Image attachments (saved to temp files for Codex)
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
            final List<File> tempImageFiles = new ArrayList<>();  // Track temp images for cleanup

            try {
                String node = nodeDetector.findNodeExecutable();
                File bridgeDir = getDirectoryResolver().findSdkDir();

                // Null check for bridgeDir
                if (bridgeDir == null || !bridgeDir.exists()) {
                    result.success = false;
                    result.error = "Bridge directory not ready or invalid";
                    return result;
                }

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

                // Process attachments for Codex (images need to be saved as temp files)
                // Codex SDK requires local file paths, not base64 data
                JsonArray attachmentsArray = buildCodexAttachments(attachments, tempImageFiles);
                if (attachmentsArray.size() > 0) {
                    stdinInput.add("attachments", attachmentsArray);
                    LOG.info("[Codex] ✓ Prepared " + attachmentsArray.size() + " image attachment(s)");
                }

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
                // 【Windows 特殊处理】Windows 沙箱支持是实验性的，使用 danger-full-access 模式
                // Windows sandbox support is experimental, use danger-full-access mode
                if (permissionMode != null && !permissionMode.isEmpty()) {
                    // Check if running on Windows - Windows sandbox is experimental and may not work properly
                    boolean isWindows = PlatformUtils.isWindows();

                    switch (permissionMode) {
                        case "bypassPermissions":
                            if (isWindows) {
                                // Windows: use danger-full-access to bypass experimental sandbox
                                env.put("CODEX_SANDBOX_MODE", "danger-full-access");
                            } else {
                                env.put("CODEX_SANDBOX_MODE", "workspace-write");
                            }
                            env.put("CODEX_APPROVAL_POLICY", "never");
                            break;
                        case "acceptEdits":
                            if (isWindows) {
                                // Windows: use danger-full-access to bypass experimental sandbox
                                env.put("CODEX_SANDBOX_MODE", "danger-full-access");
                            } else {
                                env.put("CODEX_SANDBOX_MODE", "workspace-write");
                            }
                            env.put("CODEX_APPROVAL_POLICY", "auto-edit");
                            break;
                        case "plan":
                            env.put("CODEX_SANDBOX_MODE", "read-only");
                            env.put("CODEX_APPROVAL_POLICY", "untrusted");
                            break;
                        default:
                            // Default mode: workspace-write with confirmation
                            if (isWindows) {
                                // Windows: use danger-full-access to bypass experimental sandbox
                                env.put("CODEX_SANDBOX_MODE", "danger-full-access");
                            } else {
                                env.put("CODEX_SANDBOX_MODE", "workspace-write");
                            }
                            env.put("CODEX_APPROVAL_POLICY", "untrusted");
                            break;
                    }
                    LOG.info("[Codex] Permission env override: SANDBOX_MODE=" +
                             env.get("CODEX_SANDBOX_MODE") + ", APPROVAL_POLICY=" +
                             env.get("CODEX_APPROVAL_POLICY") + " (from permissionMode=" + permissionMode +
                             ", isWindows=" + isWindows + ")");
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
                    cleanupTempImages(tempImageFiles);  // Cleanup temp image files
                }

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                callback.onError(e.getMessage());
                cleanupTempImages(tempImageFiles);  // Cleanup temp image files on error
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

    /**
     * Build Codex-compatible attachments array.
     * Codex SDK requires local file paths for images, not base64 data.
     * This method saves base64 image data to temporary files and returns file paths.
     * Files are marked for deletion on JVM exit and tracked for cleanup after message send.
     *
     * @param attachments List of attachments from the UI
     * @param tempFiles List to collect temp files for cleanup after send (optional, can be null)
     * @return JsonArray with local_image entries for Codex SDK
     */
    private JsonArray buildCodexAttachments(List<ClaudeSession.Attachment> attachments, List<File> tempFiles) {
        JsonArray result = new JsonArray();

        if (attachments == null || attachments.isEmpty()) {
            return result;
        }

        // Use system temp directory (clean, no project pollution)
        File tempDir = new File(System.getProperty("java.io.tmpdir"), "codex-images");

        // Create temp directory if not exists
        if (!tempDir.exists()) {
            tempDir.mkdirs();
        }

        for (ClaudeSession.Attachment attachment : attachments) {
            if (attachment == null) continue;

            String type = attachment.mediaType;
            String data = attachment.data;

            // Only process image types
            if (type == null || !type.startsWith("image/") || data == null) {
                LOG.debug("[Codex] Skipping non-image attachment: " + type);
                continue;
            }

            try {
                // Determine file extension from MIME type
                String extension = getImageExtension(type);

                // Generate unique filename
                String filename = "codex-img-" + System.currentTimeMillis() + "-" +
                                  java.util.UUID.randomUUID().toString().substring(0, 8) + extension;
                File imageFile = new File(tempDir, filename);

                // Decode base64 and write to file
                byte[] imageBytes = java.util.Base64.getDecoder().decode(data);
                try (java.io.FileOutputStream fos = new java.io.FileOutputStream(imageFile)) {
                    fos.write(imageBytes);
                }

                // Mark for deletion on JVM exit (fallback cleanup)
                imageFile.deleteOnExit();

                // Track for immediate cleanup after send
                if (tempFiles != null) {
                    tempFiles.add(imageFile);
                }

                LOG.info("[Codex] Saved temp image: " + imageFile.getAbsolutePath() +
                         " (" + imageBytes.length + " bytes, will auto-delete)");

                // Add to result array in Codex SDK format
                JsonObject imageEntry = new JsonObject();
                imageEntry.addProperty("type", "local_image");
                imageEntry.addProperty("path", imageFile.getAbsolutePath());
                result.add(imageEntry);

            } catch (Exception e) {
                LOG.warn("[Codex] Failed to process image attachment: " + e.getMessage());
            }
        }

        return result;
    }

    /**
     * Cleanup temporary image files after message send.
     */
    private void cleanupTempImages(List<File> tempFiles) {
        if (tempFiles == null || tempFiles.isEmpty()) {
            return;
        }
        for (File file : tempFiles) {
            try {
                if (file.exists() && file.delete()) {
                    LOG.debug("[Codex] Cleaned up temp image: " + file.getName());
                }
            } catch (Exception e) {
                LOG.debug("[Codex] Failed to cleanup temp image: " + e.getMessage());
            }
        }
    }

    /**
     * Get file extension from MIME type.
     */
    private String getImageExtension(String mimeType) {
        if (mimeType == null) return ".png";

        switch (mimeType.toLowerCase()) {
            case "image/jpeg":
            case "image/jpg":
                return ".jpg";
            case "image/gif":
                return ".gif";
            case "image/webp":
                return ".webp";
            case "image/bmp":
                return ".bmp";
            case "image/svg+xml":
                return ".svg";
            case "image/png":
            default:
                return ".png";
        }
    }

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
