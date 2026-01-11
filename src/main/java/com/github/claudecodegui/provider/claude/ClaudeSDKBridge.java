package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Claude Agent SDK bridge.
 * Handles Java to Node.js SDK communication, supports async and streaming responses.
 */
public class ClaudeSDKBridge extends BaseSDKBridge {

    private static final String NODE_SCRIPT = "simple-query.js";
    private static final String SLASH_COMMANDS_CHANNEL_ID = "__slash_commands__";
    private static final String MCP_STATUS_CHANNEL_ID = "__mcp_status__";

    public ClaudeSDKBridge() {
        super(ClaudeSDKBridge.class);
    }

    // ============================================================================
    // Abstract method implementations
    // ============================================================================

    @Override
    protected String getProviderName() {
        return "claude";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("CLAUDE_USE_STDIN", "true");
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
        // Capture additional Claude-specific error logs
        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[GET_SESSION_ERROR]")
                || line.startsWith("[PERSIST_ERROR]")) {
            LOG.warn("[Node.js ERROR] " + line);
            lastNodeError[0] = line;
        }

        if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                result.messages.add(msg);
                String type = msg.has("type") ? msg.get("type").getAsString() : "unknown";
                callback.onMessage(type, jsonStr);
            } catch (Exception e) {
                // JSON parse failed, skip
            }
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
        } else if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            assistantContent.append(content);
            callback.onMessage("content", content);
        } else if (line.startsWith("[CONTENT_DELTA]")) {
            // 🔧 流式传输：解析 JSON 编码的 delta，保留换行符
            String rawDelta = line.substring("[CONTENT_DELTA]".length());
            String jsonStr = rawDelta.startsWith(" ") ? rawDelta.substring(1) : rawDelta;
            String delta;
            try {
                // JSON 解码，还原换行符等特殊字符
                delta = new com.google.gson.Gson().fromJson(jsonStr, String.class);
            } catch (Exception e) {
                // 解析失败时使用原始字符串
                delta = jsonStr;
            }
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
        } else if (line.startsWith("[THINKING]")) {
            String thinkingContent = line.substring("[THINKING]".length()).trim();
            callback.onMessage("thinking", thinkingContent);
        } else if (line.startsWith("[THINKING_DELTA]")) {
            // 🔧 流式传输：解析 JSON 编码的 thinking delta
            String rawDelta = line.substring("[THINKING_DELTA]".length());
            String jsonStr = rawDelta.startsWith(" ") ? rawDelta.substring(1) : rawDelta;
            String thinkingDelta;
            try {
                thinkingDelta = new com.google.gson.Gson().fromJson(jsonStr, String.class);
            } catch (Exception e) {
                thinkingDelta = jsonStr;
            }
            callback.onMessage("thinking_delta", thinkingDelta);
        } else if (line.startsWith("[STREAM_START]")) {
            // 🔧 流式传输：开始标记
            callback.onMessage("stream_start", "");
        } else if (line.startsWith("[STREAM_END]")) {
            // 🔧 流式传输：结束标记
            callback.onMessage("stream_end", "");
        } else if (line.startsWith("[SESSION_ID]")) {
            String capturedSessionId = line.substring("[SESSION_ID]".length()).trim();
            callback.onMessage("session_id", capturedSessionId);
        } else if (line.startsWith("[SLASH_COMMANDS]")) {
            String slashCommandsJson = line.substring("[SLASH_COMMANDS]".length()).trim();
            callback.onMessage("slash_commands", slashCommandsJson);
        } else if (line.startsWith("[TOOL_RESULT]")) {
            String toolResultJson = line.substring("[TOOL_RESULT]".length()).trim();
            callback.onMessage("tool_result", toolResultJson);
        } else if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
        } else if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        }
    }

    // ============================================================================
    // Node.js detection methods (Claude-specific extensions)
    // ============================================================================

    /**
     * Detect Node.js and return detailed results.
     */
    public NodeDetectionResult detectNodeWithDetails() {
        return nodeDetector.detectNodeWithDetails();
    }

    /**
     * Clear Node.js detection cache.
     */
    public void clearNodeCache() {
        nodeDetector.clearCache();
    }

    /**
     * Verify Node.js path and return version.
     */
    public String verifyNodePath(String path) {
        return nodeDetector.verifyNodePath(path);
    }

    /**
     * Get cached Node.js version.
     */
    public String getCachedNodeVersion() {
        return nodeDetector.getCachedNodeVersion();
    }

    /**
     * Get cached Node.js path.
     */
    public String getCachedNodePath() {
        return nodeDetector.getCachedNodePath();
    }

    /**
     * Verify and cache Node.js path.
     */
    public NodeDetectionResult verifyAndCacheNodePath(String path) {
        return nodeDetector.verifyAndCacheNodePath(path);
    }

    // ============================================================================
    // Bridge directory methods
    // ============================================================================

    /**
     * Set claude-bridge directory path manually.
     */
    public void setSdkTestDir(String path) {
        getDirectoryResolver().setSdkDir(path);
    }

    /**
     * Get current claude-bridge directory.
     */
    public File getSdkTestDir() {
        return getDirectoryResolver().getSdkDir();
    }

    // ============================================================================
    // Sync query methods (Claude-specific)
    // ============================================================================

    /**
     * Execute query synchronously (blocking).
     */
    public SDKResult executeQuerySync(String prompt) {
        return executeQuerySync(prompt, 60);
    }

    /**
     * Execute query synchronously with timeout.
     */
    public SDKResult executeQuerySync(String prompt, int timeoutSeconds) {
        SDKResult result = new SDKResult();
        StringBuilder output = new StringBuilder();
        StringBuilder jsonBuffer = new StringBuilder();
        boolean inJson = false;

        try {
            String node = nodeDetector.findNodeExecutable();

            JsonObject stdinInput = new JsonObject();
            stdinInput.addProperty("prompt", prompt);
            String stdinJson = gson.toJson(stdinInput);

            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(NODE_SCRIPT);

            ProcessBuilder pb = new ProcessBuilder(command);
            File workDir = getDirectoryResolver().findSdkDir();
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            envConfigurator.updateProcessEnvironment(pb, node);
            pb.environment().put("CLAUDE_USE_STDIN", "true");

            Process process = pb.start();

            try (java.io.OutputStream stdin = process.getOutputStream()) {
                stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                stdin.flush();
            } catch (Exception e) {
                // Ignore stdin write error
            }

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");

                    if (line.contains("[JSON_START]")) {
                        inJson = true;
                        jsonBuffer.setLength(0);
                        continue;
                    }
                    if (line.contains("[JSON_END]")) {
                        inJson = false;
                        continue;
                    }
                    if (inJson) {
                        jsonBuffer.append(line).append("\n");
                    }

                    if (line.contains("[Assistant]:")) {
                        result.finalResult = line.substring(line.indexOf("[Assistant]:") + 12).trim();
                    }
                }
            }

            boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                result.success = false;
                result.error = "Process timeout";
                return result;
            }

            int exitCode = process.exitValue();
            result.rawOutput = output.toString();

            if (jsonBuffer.length() > 0) {
                try {
                    String jsonStr = jsonBuffer.toString().trim();
                    JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                    result.success = jsonResult.get("success").getAsBoolean();

                    if (result.success) {
                        result.messageCount = jsonResult.get("messageCount").getAsInt();
                    } else {
                        result.error = jsonResult.has("error") ?
                                jsonResult.get("error").getAsString() : "Unknown error";
                    }
                } catch (Exception e) {
                    result.success = false;
                    result.error = "JSON parse failed: " + e.getMessage();
                }
            } else {
                result.success = exitCode == 0;
                if (!result.success) {
                    result.error = "Process exit code: " + exitCode;
                }
            }

        } catch (Exception e) {
            result.success = false;
            result.error = e.getMessage();
            result.rawOutput = output.toString();
        }

        return result;
    }

    /**
     * Execute query asynchronously.
     */
    public CompletableFuture<SDKResult> executeQueryAsync(String prompt) {
        return CompletableFuture.supplyAsync(() -> executeQuerySync(prompt));
    }

    /**
     * Execute query with streaming.
     */
    public CompletableFuture<SDKResult> executeQueryStream(String prompt, MessageCallback callback) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder output = new StringBuilder();
            StringBuilder jsonBuffer = new StringBuilder();
            boolean inJson = false;

            try {
                String node = nodeDetector.findNodeExecutable();

                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("prompt", prompt);
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(NODE_SCRIPT);

                File processTempDir = processManager.prepareClaudeTempDir();
                Set<String> existingTempMarkers = processManager.snapshotClaudeCwdFiles(processTempDir);

                ProcessBuilder pb = new ProcessBuilder(command);
                File workDir = getDirectoryResolver().findSdkDir();
                pb.directory(workDir);
                pb.redirectErrorStream(true);

                Map<String, String> env = pb.environment();
                envConfigurator.configureTempDir(env, processTempDir);
                envConfigurator.updateProcessEnvironment(pb, node);
                env.put("CLAUDE_USE_STDIN", "true");

                Process process = null;
                try {
                    process = pb.start();

                    try (java.io.OutputStream stdin = process.getOutputStream()) {
                        stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                        stdin.flush();
                    } catch (Exception e) {
                        // Ignore
                    }

                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                        String line;
                        while ((line = reader.readLine()) != null) {
                            output.append(line).append("\n");

                            if (line.contains("[Message Type:")) {
                                String type = extractBetween(line, "[Message Type:", "]");
                                if (type != null) {
                                    callback.onMessage("type", type.trim());
                                }
                            }

                            if (line.contains("[Assistant]:")) {
                                String content = line.substring(line.indexOf("[Assistant]:") + 12).trim();
                                result.finalResult = content;
                                callback.onMessage("assistant", content);
                            }

                            if (line.contains("[Result]")) {
                                callback.onMessage("status", "Complete");
                            }

                            if (line.contains("[JSON_START]")) {
                                inJson = true;
                                jsonBuffer.setLength(0);
                                continue;
                            }
                            if (line.contains("[JSON_END]")) {
                                inJson = false;
                                continue;
                            }
                            if (inJson) {
                                jsonBuffer.append(line).append("\n");
                            }
                        }
                    }

                    int exitCode = process.waitFor();
                    result.rawOutput = output.toString();

                    if (jsonBuffer.length() > 0) {
                        try {
                            String jsonStr = jsonBuffer.toString().trim();
                            JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                            result.success = jsonResult.get("success").getAsBoolean();

                            if (result.success) {
                                result.messageCount = jsonResult.get("messageCount").getAsInt();
                                callback.onComplete(result);
                            } else {
                                result.error = jsonResult.has("error") ?
                                        jsonResult.get("error").getAsString() : "Unknown error";
                                callback.onError(result.error);
                            }
                        } catch (Exception e) {
                            result.success = false;
                            result.error = "JSON parse failed: " + e.getMessage();
                            callback.onError(result.error);
                        }
                    } else {
                        result.success = exitCode == 0;
                        if (result.success) {
                            callback.onComplete(result);
                        } else {
                            result.error = "Process exit code: " + exitCode;
                            callback.onError(result.error);
                        }
                    }

                } finally {
                    processManager.waitForProcessTermination(process);
                    processManager.cleanupClaudeTempFiles(processTempDir, existingTempMarkers);
                }

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                result.rawOutput = output.toString();
                callback.onError(e.getMessage());
            }

            return result;
        });
    }

    // ============================================================================
    // Multi-turn interaction support
    // ============================================================================

    /**
     * Send message in existing channel (streaming response).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, cwd, attachments, null, null, null, null, null, callback);
    }

    /**
     * Send message in existing channel (streaming response, with permission mode and model selection).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, cwd, attachments, permissionMode, model, openedFiles, agentPrompt, null, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag).
     */
    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            JsonObject openedFiles,
            String agentPrompt,
            Boolean streaming,
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            final boolean[] hadSendError = {false};
            final String[] lastNodeError = {null};

            try {
                // Serialize attachments
                String attachmentsJson = null;
                boolean hasAttachments = attachments != null && !attachments.isEmpty();
                if (hasAttachments) {
                    try {
                        List<Map<String, String>> serializable = new ArrayList<>();
                        for (ClaudeSession.Attachment att : attachments) {
                            if (att == null) continue;
                            Map<String, String> obj = new HashMap<>();
                            obj.put("fileName", att.fileName);
                            obj.put("mediaType", att.mediaType);
                            obj.put("data", att.data);
                            serializable.add(obj);
                        }
                        attachmentsJson = gson.toJson(serializable);
                    } catch (Exception e) {
                        hasAttachments = false;
                    }
                }

                String node = nodeDetector.findNodeExecutable();
                File workDir = getDirectoryResolver().findSdkDir();

                // Diagnostics
                LOG.info("[ClaudeSDKBridge] Environment diagnostics:");
                LOG.info("[ClaudeSDKBridge]   Node.js path: " + node);
                String nodeVersion = nodeDetector.verifyNodePath(node);
                LOG.info("[ClaudeSDKBridge]   Node.js version: " + (nodeVersion != null ? nodeVersion : "unknown"));
                LOG.info("[ClaudeSDKBridge]   SDK directory: " + workDir.getAbsolutePath());

                // Build stdin input
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("message", message);
                stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
                stdinInput.addProperty("model", model != null ? model : "");
                if (hasAttachments && attachmentsJson != null) {
                    stdinInput.add("attachments", gson.fromJson(attachmentsJson, JsonArray.class));
                }
                if (openedFiles != null && openedFiles.size() > 0) {
                    stdinInput.add("openedFiles", openedFiles);
                }
                if (agentPrompt != null && !agentPrompt.isEmpty()) {
                    stdinInput.addProperty("agentPrompt", agentPrompt);
                    LOG.info("[Agent] ✓ Adding agentPrompt to stdinInput (length: " + agentPrompt.length() + " chars)");
                }
                // 🔧 流式传输配置
                if (streaming != null) {
                    stdinInput.addProperty("streaming", streaming);
                    LOG.info("[Streaming] ✓ Adding streaming to stdinInput: " + streaming);
                }
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(workDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");
                command.add(hasAttachments ? "sendWithAttachments" : "send");

                File processTempDir = processManager.prepareClaudeTempDir();
                Set<String> existingTempMarkers = processManager.snapshotClaudeCwdFiles(processTempDir);

                ProcessBuilder pb = new ProcessBuilder(command);

                // Set working directory
                if (cwd != null && !cwd.isEmpty() && !"undefined".equals(cwd) && !"null".equals(cwd)) {
                    File userWorkDir = new File(cwd);
                    if (userWorkDir.exists() && userWorkDir.isDirectory()) {
                        pb.directory(userWorkDir);
                    } else {
                        pb.directory(getDirectoryResolver().findSdkDir());
                    }
                } else {
                    pb.directory(getDirectoryResolver().findSdkDir());
                }

                Map<String, String> env = pb.environment();
                envConfigurator.configureProjectPath(env, cwd);
                envConfigurator.configureTempDir(env, processTempDir);
                env.put("CLAUDE_USE_STDIN", "true");

                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);

                Process process = null;
                try {
                    process = pb.start();
                    LOG.info("[ClaudeSDKBridge] Node.js process started, PID: " + process.pid());

                    // Check for early exit
                    try {
                        Thread.sleep(500);
                        if (!process.isAlive()) {
                            int earlyExitCode = process.exitValue();
                            LOG.error("[ClaudeSDKBridge] Process exited immediately, exitCode: " + earlyExitCode);
                            try (BufferedReader earlyReader = new BufferedReader(
                                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                                StringBuilder earlyOutput = new StringBuilder();
                                String line;
                                while ((line = earlyReader.readLine()) != null) {
                                    earlyOutput.append(line).append("\n");
                                    LOG.error("[ClaudeSDKBridge] Process output: " + line);
                                }
                                LOG.debug("[ClaudeSDKBridge] Early exit - captured " + earlyOutput.length() + " chars");
                                if (earlyOutput.length() > 0) {
                                    lastNodeError[0] = earlyOutput.toString().trim();
                                }
                            }
                        }
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                    }

                    processManager.registerProcess(channelId, process);

                    // Write to stdin
                    try (java.io.OutputStream stdin = process.getOutputStream()) {
                        stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                        stdin.flush();
                    } catch (Exception e) {
                        // Ignore
                    }

                    // 🔧 诊断日志：记录前 50 行输出，帮助排查问题
                    final int[] lineCountHolder = {0};
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                        String line;
                        while ((line = reader.readLine()) != null) {
                            lineCountHolder[0]++;
                            // 🔧 诊断日志：输出前 50 行
                            if (lineCountHolder[0] <= 50) {
                                LOG.info("[DIAG-OUTPUT] Line " + lineCountHolder[0] + ": " + line);
                            }
                            // Capture error logs
                            if (line.startsWith("[UNCAUGHT_ERROR]")
                                    || line.startsWith("[UNHANDLED_REJECTION]")
                                    || line.startsWith("[COMMAND_ERROR]")
                                    || line.startsWith("[STARTUP_ERROR]")
                                    || line.startsWith("[ERROR]")
                                    || line.startsWith("[STDIN_ERROR]")
                                    || line.startsWith("[STDIN_PARSE_ERROR]")
                                    || line.startsWith("[GET_SESSION_ERROR]")
                                    || line.startsWith("[PERSIST_ERROR]")) {
                                LOG.warn("[Node.js ERROR] " + line);
                                lastNodeError[0] = line;
                            }

                            if (line.startsWith("[MESSAGE]")) {
                                String jsonStr = line.substring("[MESSAGE]".length()).trim();
                                try {
                                    JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                                    result.messages.add(msg);
                                    String type = msg.has("type") ? msg.get("type").getAsString() : "unknown";
                                    callback.onMessage(type, jsonStr);
                                } catch (Exception e) {
                                    // Skip
                                }
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

                                // Add diagnostics to error message
                                StringBuilder diagMsg = new StringBuilder();
                                diagMsg.append(errorMessage);
                                diagMsg.append("\n\n**【Environment Diagnostics】**  \n");
                                diagMsg.append("  Node.js path: `").append(node).append("`  \n");
                                diagMsg.append("  Node.js version: ").append(nodeVersion != null ? nodeVersion : "❌ unknown").append("  \n");
                                diagMsg.append("  SDK directory: `").append(workDir.getAbsolutePath()).append("`  \n");

                                errorMessage = diagMsg.toString();
                                hadSendError[0] = true;
                                result.success = false;
                                result.error = errorMessage;
                                callback.onError(errorMessage);
                            } else if (line.startsWith("[CONTENT]")) {
                                String content = line.substring("[CONTENT]".length()).trim();
                                assistantContent.append(content);
                                callback.onMessage("content", content);
                            } else if (line.startsWith("[CONTENT_DELTA]")) {
                                // 🔧 流式传输：解析 JSON 编码的 delta，保留换行符
                                String rawDelta = line.substring("[CONTENT_DELTA]".length());
                                String jsonStr = rawDelta.startsWith(" ") ? rawDelta.substring(1) : rawDelta;
                                String delta;
                                try {
                                    delta = new com.google.gson.Gson().fromJson(jsonStr, String.class);
                                } catch (Exception e) {
                                    delta = jsonStr;
                                }
                                assistantContent.append(delta);
                                callback.onMessage("content_delta", delta);
                            } else if (line.startsWith("[THINKING]")) {
                                String thinkingContent = line.substring("[THINKING]".length()).trim();
                                callback.onMessage("thinking", thinkingContent);
                            } else if (line.startsWith("[THINKING_DELTA]")) {
                                // 🔧 流式传输：解析 JSON 编码的 thinking delta
                                String rawDelta = line.substring("[THINKING_DELTA]".length());
                                String jsonStr = rawDelta.startsWith(" ") ? rawDelta.substring(1) : rawDelta;
                                String thinkingDelta;
                                try {
                                    thinkingDelta = new com.google.gson.Gson().fromJson(jsonStr, String.class);
                                } catch (Exception e) {
                                    thinkingDelta = jsonStr;
                                }
                                callback.onMessage("thinking_delta", thinkingDelta);
                            } else if (line.startsWith("[STREAM_START]")) {
                                // 🔧 流式传输：开始标记
                                callback.onMessage("stream_start", "");
                            } else if (line.startsWith("[STREAM_END]")) {
                                // 🔧 流式传输：结束标记
                                callback.onMessage("stream_end", "");
                            } else if (line.startsWith("[SESSION_ID]")) {
                                String capturedSessionId = line.substring("[SESSION_ID]".length()).trim();
                                callback.onMessage("session_id", capturedSessionId);
                            } else if (line.startsWith("[SLASH_COMMANDS]")) {
                                String slashCommandsJson = line.substring("[SLASH_COMMANDS]".length()).trim();
                                callback.onMessage("slash_commands", slashCommandsJson);
                            } else if (line.startsWith("[TOOL_RESULT]")) {
                                String toolResultJson = line.substring("[TOOL_RESULT]".length()).trim();
                                callback.onMessage("tool_result", toolResultJson);
                            } else if (line.startsWith("[MESSAGE_START]")) {
                                callback.onMessage("message_start", "");
                            } else if (line.startsWith("[MESSAGE_END]")) {
                                callback.onMessage("message_end", "");
                            } else {
                                // Forward all other Node.js output to frontend for debugging
                                callback.onMessage("node_log", line);
                            }
                        }
                    }

                    LOG.debug("[ClaudeSDKBridge] Output loop ended, waiting for process to exit...");
                    LOG.info("[DIAG-OUTPUT] Total lines received: " + lineCountHolder[0]);
                    process.waitFor();

                    int exitCode = process.exitValue();
                    boolean wasInterrupted = processManager.wasInterrupted(channelId);
                    LOG.info("[DIAG-OUTPUT] Process exited, exitCode=" + exitCode + ", wasInterrupted=" + wasInterrupted + ", hadSendError=" + hadSendError[0] + ", totalLines=" + lineCountHolder[0]);

                    result.finalResult = assistantContent.toString();
                    result.messageCount = result.messages.size();

                    if (wasInterrupted) {
                        callback.onComplete(result);
                    } else if (!hadSendError[0]) {
                        result.success = exitCode == 0 && !wasInterrupted;
                        if (result.success) {
                            callback.onComplete(result);
                        } else {
                            String errorMsg = "Process exited with code: " + exitCode;

                            if (lastNodeError[0] != null && !lastNodeError[0].isEmpty()) {
                                errorMsg = errorMsg + "\n\nDetails: " + lastNodeError[0];
                            }
                            result.success = false;
                            result.error = errorMsg;
                            callback.onError(errorMsg);
                        }
                    } else {
                        // 已经有 SEND_ERROR，不再附加输出
                        if (exitCode == 0) {
                            result.success = true;
                            callback.onComplete(result);
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
        }).exceptionally(ex -> {
            SDKResult errorResult = new SDKResult();
            errorResult.success = false;
            errorResult.error = ex.getCause() != null ? ex.getCause().getMessage() : ex.getMessage();
            callback.onError(errorResult.error);
            return errorResult;
        });
    }

    /**
     * Get session history messages.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            String node = nodeDetector.findNodeExecutable();

            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(CHANNEL_SCRIPT);
            command.add("claude");
            command.add("getSession");
            command.add(sessionId);
            command.add(cwd != null ? cwd : "");

            ProcessBuilder pb = new ProcessBuilder(command);
            File workDir = getDirectoryResolver().findSdkDir();
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            envConfigurator.updateProcessEnvironment(pb, node);

            Process process = pb.start();

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            process.waitFor();

            String outputStr = output.toString().trim();

            int jsonStart = outputStr.indexOf("{");
            if (jsonStart != -1) {
                String jsonStr = outputStr.substring(jsonStart);
                JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);

                if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                    List<JsonObject> messages = new ArrayList<>();
                    if (jsonResult.has("messages")) {
                        JsonArray messagesArray = jsonResult.getAsJsonArray("messages");
                        for (var msg : messagesArray) {
                            messages.add(msg.getAsJsonObject());
                        }
                    }
                    return messages;
                } else {
                    String errorMsg = (jsonResult.has("error") && !jsonResult.get("error").isJsonNull())
                            ? jsonResult.get("error").getAsString()
                            : "Unknown error";
                    throw new RuntimeException("Get session failed: " + errorMsg);
                }
            }

            return new ArrayList<>();

        } catch (Exception e) {
            throw new RuntimeException("Failed to get session messages: " + e.getMessage(), e);
        }
    }

    /**
     * Get slash commands list.
     */
    public CompletableFuture<List<JsonObject>> getSlashCommands(String cwd) {
        return CompletableFuture.supplyAsync(() -> {
            Process process = null;
            long startTime = System.currentTimeMillis();
            LOG.info("[SlashCommands] Starting getSlashCommands, cwd=" + cwd);

            try {
                String node = nodeDetector.findNodeExecutable();

                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                File bridgeDir = getDirectoryResolver().findSdkDir();
                command.add(new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");
                command.add("getSlashCommands");

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(bridgeDir);
                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);
                pb.environment().put("CLAUDE_USE_STDIN", "true");

                process = pb.start();
                processManager.registerProcess(SLASH_COMMANDS_CHANNEL_ID, process);
                final Process finalProcess = process;

                try (java.io.OutputStream stdin = process.getOutputStream()) {
                    stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                } catch (Exception e) {
                    LOG.warn("[SlashCommands] Failed to write stdin: " + e.getMessage());
                }

                final boolean[] found = {false};
                final String[] slashCommandsJson = {null};
                final StringBuilder output = new StringBuilder();

                Thread readerThread = new Thread(() -> {
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while (!found[0] && (line = reader.readLine()) != null) {
                            output.append(line).append("\n");

                            if (line.startsWith("[SLASH_COMMANDS]")) {
                                slashCommandsJson[0] = line.substring("[SLASH_COMMANDS]".length()).trim();
                                found[0] = true;
                                break;
                            }
                        }
                    } catch (Exception e) {
                        LOG.debug("[SlashCommands] Reader thread exception: " + e.getMessage());
                    }
                });
                readerThread.start();

                long deadline = System.currentTimeMillis() + 20000;
                while (!found[0] && System.currentTimeMillis() < deadline) {
                    Thread.sleep(100);
                }

                long elapsed = System.currentTimeMillis() - startTime;

                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }

                List<JsonObject> commands = new ArrayList<>();

                if (found[0] && slashCommandsJson[0] != null && !slashCommandsJson[0].isEmpty()) {
                    try {
                        JsonArray commandsArray = gson.fromJson(slashCommandsJson[0], JsonArray.class);
                        for (var cmd : commandsArray) {
                            commands.add(cmd.getAsJsonObject());
                        }
                        LOG.info("[SlashCommands] Successfully parsed " + commands.size() + " commands in " + elapsed + "ms");
                        return commands;
                    } catch (Exception e) {
                        LOG.warn("[SlashCommands] Failed to parse commands JSON: " + e.getMessage());
                    }
                }

                // Fallback
                String outputStr = output.toString().trim();
                int jsonStart = outputStr.lastIndexOf("{");
                if (jsonStart != -1) {
                    String jsonStr = outputStr.substring(jsonStart);
                    try {
                        JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                        if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                            if (jsonResult.has("commands")) {
                                JsonArray commandsArray = jsonResult.getAsJsonArray("commands");
                                for (var cmd : commandsArray) {
                                    commands.add(cmd.getAsJsonObject());
                                }
                            }
                        }
                    } catch (Exception e) {
                        LOG.debug("[SlashCommands] Fallback JSON parse failed: " + e.getMessage());
                    }
                }

                return commands;

            } catch (Exception e) {
                LOG.error("[SlashCommands] Exception: " + e.getMessage());
                return new ArrayList<>();
            } finally {
                if (process != null) {
                    try {
                        if (process.isAlive()) {
                            PlatformUtils.terminateProcess(process);
                        }
                    } finally {
                        processManager.unregisterProcess(SLASH_COMMANDS_CHANNEL_ID, process);
                    }
                }
            }
        });
    }

    /**
     * Get MCP server connection status.
     */
    public CompletableFuture<List<JsonObject>> getMcpServerStatus(String cwd) {
        return CompletableFuture.supplyAsync(() -> {
            Process process = null;
            long startTime = System.currentTimeMillis();
            LOG.info("[McpStatus] Starting getMcpServerStatus, cwd=" + cwd);

            try {
                String node = nodeDetector.findNodeExecutable();

                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                String stdinJson = this.gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                File bridgeDir = getDirectoryResolver().findSdkDir();
                command.add(new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");
                command.add("getMcpServerStatus");

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(bridgeDir);
                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);
                pb.environment().put("CLAUDE_USE_STDIN", "true");

                process = pb.start();
                processManager.registerProcess(MCP_STATUS_CHANNEL_ID, process);
                final Process finalProcess = process;

                try (java.io.OutputStream stdin = process.getOutputStream()) {
                    stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                } catch (Exception e) {
                    LOG.warn("[McpStatus] Failed to write stdin: " + e.getMessage());
                }

                final boolean[] found = {false};
                final String[] mcpStatusJson = {null};
                final StringBuilder output = new StringBuilder();

                Thread readerThread = new Thread(() -> {
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while (!found[0] && (line = reader.readLine()) != null) {
                            output.append(line).append("\n");

                            if (line.startsWith("[MCP_SERVER_STATUS]")) {
                                mcpStatusJson[0] = line.substring("[MCP_SERVER_STATUS]".length()).trim();
                                found[0] = true;
                                break;
                            }
                        }
                    } catch (Exception e) {
                        LOG.debug("[McpStatus] Reader thread exception: " + e.getMessage());
                    }
                });
                readerThread.start();

                long deadline = System.currentTimeMillis() + 30000;
                while (!found[0] && System.currentTimeMillis() < deadline) {
                    Thread.sleep(100);
                }

                long elapsed = System.currentTimeMillis() - startTime;

                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }

                List<JsonObject> servers = new ArrayList<>();

                if (found[0] && mcpStatusJson[0] != null && !mcpStatusJson[0].isEmpty()) {
                    try {
                        JsonArray serversArray = this.gson.fromJson(mcpStatusJson[0], JsonArray.class);
                        for (var server : serversArray) {
                            servers.add(server.getAsJsonObject());
                        }
                        LOG.info("[McpStatus] Successfully parsed " + servers.size() + " MCP servers in " + elapsed + "ms");
                        return servers;
                    } catch (Exception e) {
                        LOG.warn("[McpStatus] Failed to parse MCP status JSON: " + e.getMessage());
                    }
                }

                // Fallback
                String outputStr = output.toString().trim();
                int jsonStart = outputStr.lastIndexOf("{");
                if (jsonStart != -1) {
                    String jsonStr = outputStr.substring(jsonStart);
                    try {
                        JsonObject jsonResult = this.gson.fromJson(jsonStr, JsonObject.class);
                        if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                            if (jsonResult.has("servers")) {
                                JsonArray serversArray = jsonResult.getAsJsonArray("servers");
                                for (var server : serversArray) {
                                    servers.add(server.getAsJsonObject());
                                }
                            }
                        }
                    } catch (Exception e) {
                        LOG.debug("[McpStatus] Fallback JSON parse failed: " + e.getMessage());
                    }
                }

                return servers;

            } catch (Exception e) {
                LOG.error("[McpStatus] Exception: " + e.getMessage());
                return new ArrayList<>();
            } finally {
                if (process != null) {
                    try {
                        if (process.isAlive()) {
                            PlatformUtils.terminateProcess(process);
                        }
                    } finally {
                        processManager.unregisterProcess(MCP_STATUS_CHANNEL_ID, process);
                    }
                }
            }
        });
    }

    // ============================================================================
    // Rewind files support
    // ============================================================================

    /**
     * Rewind files to a specific user message state.
     * Uses the SDK's rewindFiles() API to restore files to their state at a given message.
     *
     * @param sessionId The session ID
     * @param userMessageId The user message UUID to rewind to
     * @param cwd Working directory for the session
     * @return CompletableFuture with the result
     */
    public CompletableFuture<JsonObject> rewindFiles(String sessionId, String userMessageId, String cwd) {
        return CompletableFuture.supplyAsync(() -> {
            JsonObject response = new JsonObject();

            try {
                String node = nodeDetector.findNodeExecutable();
                File workDir = getDirectoryResolver().findSdkDir();

                LOG.info("[Rewind] Starting rewind operation");
                LOG.info("[Rewind] Session ID: " + sessionId);
                LOG.info("[Rewind] Target message ID: " + userMessageId);

                // Build stdin input
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("sessionId", sessionId);
                stdinInput.addProperty("userMessageId", userMessageId);
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                String stdinJson = gson.toJson(stdinInput);

                // Build command: node channel-manager.js claude rewindFiles
                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(workDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");
                command.add("rewindFiles");

                ProcessBuilder pb = new ProcessBuilder(command);

                if (cwd != null && !cwd.isEmpty() && !"undefined".equals(cwd) && !"null".equals(cwd)) {
                    File userWorkDir = new File(cwd);
                    if (userWorkDir.exists() && userWorkDir.isDirectory()) {
                        pb.directory(userWorkDir);
                    } else {
                        pb.directory(workDir);
                    }
                } else {
                    pb.directory(workDir);
                }
                pb.redirectErrorStream(true);

                Map<String, String> env = pb.environment();
                envConfigurator.configureProjectPath(env, cwd);
                File processTempDir = processManager.prepareClaudeTempDir();
                envConfigurator.configureTempDir(env, processTempDir);
                env.put("CLAUDE_USE_STDIN", "true");
                envConfigurator.updateProcessEnvironment(pb, node);

                Process process = pb.start();
                LOG.info("[Rewind] Process started, PID: " + process.pid());

                // Write to stdin
                try (java.io.OutputStream stdin = process.getOutputStream()) {
                    stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                }

                CompletableFuture<String> outputFuture = CompletableFuture.supplyAsync(() -> {
                    StringBuilder output = new StringBuilder();
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            LOG.info("[Rewind] Output: " + line);
                            output.append(line).append("\n");
                        }
                    } catch (Exception ignored) {
                    }
                    return output.toString();
                });

                boolean finished = process.waitFor(60, TimeUnit.SECONDS);
                int exitCode;
                if (!finished) {
                    PlatformUtils.terminateProcess(process);
                    exitCode = -1;
                } else {
                    exitCode = process.exitValue();
                }
                LOG.info("[Rewind] Process exited with code: " + exitCode);

                // Parse result
                String outputStr;
                try {
                    outputStr = outputFuture.get(5, TimeUnit.SECONDS).trim();
                } catch (Exception e) {
                    outputStr = "";
                }
                int jsonStart = outputStr.lastIndexOf("{");
                if (jsonStart != -1) {
                    String jsonStr = outputStr.substring(jsonStart);
                    try {
                        JsonObject result = gson.fromJson(jsonStr, JsonObject.class);
                        return result;
                    } catch (Exception e) {
                        LOG.warn("[Rewind] Failed to parse JSON: " + e.getMessage());
                    }
                }

                // Default response
                response.addProperty("success", exitCode == 0);
                if (exitCode != 0) {
                    if (!finished) {
                        response.addProperty("error", "Rewind process timeout");
                    } else {
                        response.addProperty("error", "Process exited with code: " + exitCode);
                    }
                }
                return response;

            } catch (Exception e) {
                LOG.error("[Rewind] Exception: " + e.getMessage(), e);
                response.addProperty("success", false);
                response.addProperty("error", e.getMessage());
                return response;
            }
        });
    }

    public CompletableFuture<JsonObject> rewindFiles(String sessionId, String userMessageId) {
        return rewindFiles(sessionId, userMessageId, null);
    }

    // ============================================================================
    // Utility methods
    // ============================================================================

    private String extractBetween(String text, String start, String end) {
        int startIdx = text.indexOf(start);
        if (startIdx == -1) return null;
        startIdx += start.length();

        int endIdx = text.indexOf(end, startIdx);
        if (endIdx == -1) return null;

        return text.substring(startIdx, endIdx);
    }
}
