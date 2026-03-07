package com.github.claudecodegui.provider.claude;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.DaemonBridge;
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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

/**
 * Claude Agent SDK bridge.
 * Handles Java to Node.js SDK communication, supports async and streaming responses.
 */
public class ClaudeSDKBridge extends BaseSDKBridge {

    private static final String NODE_SCRIPT = "simple-query.js";
    private static final String MCP_STATUS_CHANNEL_ID = "__mcp_status__";

    /** Maximum characters to preview in log output */
    private static final int LOG_PREVIEW_MAX_CHARS = 500;

    /**
     * Pattern to match sensitive data for log sanitization.
     * Matches common sensitive field names followed by their values:
     * - api_key, api-key, apikey
     * - token, access_token, refresh_token
     * - password, passwd
     * - secret, client_secret
     * - authorization, bearer
     * - credential, credentials
     * - private_key, private-key
     * - access_key, access-key
     */
    private static final Pattern SENSITIVE_DATA_PATTERN = Pattern.compile(
            "(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|" +
            "authorization|bearer|credential|credentials|private[_-]?key|access[_-]?key)" +
            "[\"']?\\s*[:=]\\s*[\"']?[^\"'\\s,}]{8,}",
            Pattern.CASE_INSENSITIVE
    );

    // Daemon bridge for long-running Node.js process (avoids per-request process spawning)
    private volatile DaemonBridge daemonBridge;
    private final Object daemonLock = new Object();
    private volatile long daemonRetryAfter = 0;
    private volatile CompletableFuture<?> prewarmFuture;

    public ClaudeSDKBridge() {
        super(ClaudeSDKBridge.class);
    }

    // ============================================================================
    // Daemon lifecycle
    // ============================================================================

    /**
     * Get or initialize the daemon bridge.
     * Returns null if daemon cannot be started (falls back to per-process mode).
     */
    private DaemonBridge getDaemonBridge() {
        DaemonBridge db = daemonBridge;
        if (db != null && db.isAlive()) {
            return db;
        }
        if (System.currentTimeMillis() < daemonRetryAfter) {
            return null;
        }
        synchronized (daemonLock) {
            db = daemonBridge;
            if (db != null && db.isAlive()) return db;
            daemonRetryAfter = System.currentTimeMillis() + 60_000;
            try {
                if (db != null) db.stop();
                db = new DaemonBridge(nodeDetector, getDirectoryResolver(), envConfigurator);
                if (db.start()) {
                    daemonBridge = db;
                    daemonRetryAfter = 0;
                    LOG.info("[ClaudeSDKBridge] Daemon bridge started successfully");
                    return db;
                }
                LOG.warn("[ClaudeSDKBridge] Failed to start daemon, using per-process mode");
            } catch (Exception e) {
                LOG.debug("[ClaudeSDKBridge] Daemon init failed: " + e.getMessage());
            }
            return null;
        }
    }

    /**
     * Shut down the daemon process.
     */
    public void shutdownDaemon() {
        CompletableFuture<?> pf = prewarmFuture;
        if (pf != null) {
            pf.cancel(true);
            prewarmFuture = null;
        }
        DaemonBridge db = daemonBridge;
        if (db != null) {
            db.stop();
            daemonBridge = null;
            daemonRetryAfter = 0;
        }
    }

    /**
     * Prewarm daemon asynchronously to reduce first-message latency.
     */
    public void prewarmDaemonAsync(String cwd) {
        // Cancel any previous prewarm in progress
        CompletableFuture<?> prev = prewarmFuture;
        if (prev != null && !prev.isDone()) {
            prev.cancel(true);
        }
        prewarmFuture = CompletableFuture.runAsync(() -> {
            try {
                DaemonBridge db = getDaemonBridge();
                if (db != null) {
                    JsonObject preconnectParams = new JsonObject();
                    preconnectParams.addProperty("cwd", cwd != null ? cwd : "");
                    preconnectParams.addProperty("sessionId", "");
                    preconnectParams.addProperty("permissionMode", "");
                    preconnectParams.addProperty("model", "");
                    preconnectParams.addProperty("streaming", true);

                    JsonObject envVars = new JsonObject();
                    envVars.addProperty("CLAUDE_USE_STDIN", "true");
                    if (cwd != null && !cwd.isEmpty()
                            && !"undefined".equals(cwd) && !"null".equals(cwd)) {
                        envVars.addProperty("IDEA_PROJECT_PATH", cwd);
                        envVars.addProperty("PROJECT_PATH", cwd);
                    }
                    preconnectParams.add("env", envVars);

                    CompletableFuture<Boolean> preconnectFuture = db.sendCommand(
                            "claude.preconnect",
                            preconnectParams,
                            new DaemonBridge.DaemonOutputCallback() {
                                @Override
                                public void onLine(String line) {
                                    if (line.startsWith("[SEND_ERROR]")) {
                                        LOG.warn("[ClaudeSDKBridge] Daemon preconnect error line: " + line);
                                    }
                                }

                                @Override
                                public void onStderr(String text) {
                                    LOG.debug("[ClaudeSDKBridge] Daemon preconnect stderr: " + text);
                                }

                                @Override
                                public void onError(String error) {
                                    LOG.warn("[ClaudeSDKBridge] Daemon preconnect failed: " + error);
                                }

                                @Override
                                public void onComplete(boolean success) {
                                    LOG.info("[ClaudeSDKBridge] Daemon preconnect completed: success=" + success);
                                }
                            }
                    );

                    preconnectFuture.get(45, TimeUnit.SECONDS);
                    LOG.info("[ClaudeSDKBridge] Daemon prewarm completed");
                } else {
                    LOG.info("[ClaudeSDKBridge] Daemon prewarm skipped (daemon unavailable)");
                }
            } catch (Exception e) {
                LOG.debug("[ClaudeSDKBridge] Daemon prewarm failed: " + e.getMessage());
            }
        });
    }

    @Override
    public void cleanupAllProcesses() {
        shutdownDaemon();
        super.cleanupAllProcesses();
    }

    /**
     * Interrupt a channel. In daemon mode, sends an abort command to cancel the
     * active request. Also delegates to ProcessManager for per-process fallback.
     */
    @Override
    public void interruptChannel(String channelId) {
        DaemonBridge db = daemonBridge;
        if (db != null && db.isAlive()) {
            LOG.info("[ClaudeSDKBridge] Sending daemon abort for channel: " + channelId);
            try {
                db.sendAbort();
            } catch (Exception e) {
                LOG.error("[ClaudeSDKBridge] Daemon abort failed: " + e.getMessage());
            }
        }
        // Also try per-process interrupt (covers per-process fallback mode)
        super.interruptChannel(channelId);
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
            // Streaming: parse JSON-encoded delta, preserving newlines
            String rawDelta = line.substring("[CONTENT_DELTA]".length());
            String jsonStr = rawDelta.startsWith(" ") ? rawDelta.substring(1) : rawDelta;
            String delta;
            try {
                // JSON decode to restore newlines and other special characters
                delta = new com.google.gson.Gson().fromJson(jsonStr, String.class);
            } catch (Exception e) {
                // Fall back to raw string on parse failure
                delta = jsonStr;
            }
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
        } else if (line.startsWith("[THINKING]")) {
            String thinkingContent = line.substring("[THINKING]".length()).trim();
            callback.onMessage("thinking", thinkingContent);
        } else if (line.startsWith("[THINKING_DELTA]")) {
            // Streaming: parse JSON-encoded thinking delta
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
            // Streaming: start marker
            callback.onMessage("stream_start", "");
        } else if (line.startsWith("[STREAM_END]")) {
            // Streaming: end marker
            callback.onMessage("stream_end", "");
        } else if (line.startsWith("[SESSION_ID]")) {
            String capturedSessionId = line.substring("[SESSION_ID]".length()).trim();
            callback.onMessage("session_id", capturedSessionId);
        } else if (line.startsWith("[TOOL_RESULT]")) {
            String toolResultJson = line.substring("[TOOL_RESULT]".length()).trim();
            callback.onMessage("tool_result", toolResultJson);
        } else if (line.startsWith("[USAGE]")) {
            String usageJson = line.substring("[USAGE]".length()).trim();
            callback.onMessage("usage", usageJson);
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

            File workDir = getDirectoryResolver().findSdkDir();
            if (workDir == null || !workDir.exists()) {
                result.success = false;
                result.error = "Bridge directory not ready or invalid";
                return result;
            }

            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(NODE_SCRIPT);

            ProcessBuilder pb = new ProcessBuilder(command);
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

                File workDir = getDirectoryResolver().findSdkDir();
                if (workDir == null || !workDir.exists()) {
                    result.success = false;
                    result.error = "Bridge directory not ready or invalid";
                    return result;
                }

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(NODE_SCRIPT);

                File processTempDir = processManager.prepareClaudeTempDir();

                ProcessBuilder pb = new ProcessBuilder(command);
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
        return sendMessage(channelId, message, sessionId, cwd, attachments, permissionMode, model, openedFiles, agentPrompt, null, false, callback);
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
        return sendMessage(channelId, message, sessionId, cwd, attachments, permissionMode, model, openedFiles, agentPrompt, streaming, false, callback);
    }

    /**
     * Send message in existing channel (streaming response, with all options including streaming flag and disableThinking).
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
            Boolean disableThinking,
            MessageCallback callback
    ) {
        // Try daemon mode first (avoids per-request Node.js process spawning)
        DaemonBridge db = getDaemonBridge();
        if (db != null) {
            return sendMessageViaDaemon(db, channelId, message, sessionId, cwd,
                    attachments, permissionMode, model, openedFiles, agentPrompt,
                    streaming, disableThinking, callback);
        }

        // Fallback: per-process mode (spawns a new Node.js process per request)
        LOG.info("[ClaudeSDKBridge] Using per-process mode (daemon not available)");
        final boolean[] errorAlreadyReported = {false};
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

                // Check if bridge directory is ready
                if (workDir == null || !workDir.exists()) {
                    result.success = false;
                    result.error = "Bridge directory not ready or invalid. Please wait for extraction to complete or reinstall the plugin.";
                    callback.onError(result.error);
                    return result;
                }

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
                // Streaming configuration
                if (streaming != null) {
                    stdinInput.addProperty("streaming", streaming);
                    LOG.info("[Streaming] ✓ Adding streaming to stdinInput: " + streaming);
                }
                // Disable thinking mode configuration
                if (disableThinking != null && disableThinking) {
                    stdinInput.addProperty("disableThinking", true);
                    LOG.info("[Thinking] ✓ Disabling thinking mode for this request");
                }
                String stdinJson = gson.toJson(stdinInput);

                // Log prompt preview with sensitive data sanitized
                String sanitizedJson = sanitizeSensitiveData(stdinJson);
                String preview = sanitizedJson.length() > LOG_PREVIEW_MAX_CHARS
                    ? sanitizedJson.substring(0, LOG_PREVIEW_MAX_CHARS) + "\n... (truncated, total: " + stdinJson.length() + " chars)"
                    : sanitizedJson;
                LOG.debug("[PROMPT] Sending to Node.js (" + stdinJson.length() + " chars):\n" + preview);

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(workDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");
                command.add(hasAttachments ? "sendWithAttachments" : "send");

                File processTempDir = processManager.prepareClaudeTempDir();

                ProcessBuilder pb = new ProcessBuilder(command);

                // Set working directory
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
                    processManager.registerProcess(channelId, process);

                    // Check for immediate early exit
                    try {
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
                    } catch (Exception earlyCheckError) {
                        LOG.debug("[ClaudeSDKBridge] Early exit check failed: " + earlyCheckError.getMessage());
                    }

                    // Write to stdin
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
                                // Streaming: parse JSON-encoded delta, preserving newlines
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
                                // Streaming: parse JSON-encoded thinking delta
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
                                // Streaming: start marker
                                callback.onMessage("stream_start", "");
                            } else if (line.startsWith("[STREAM_END]")) {
                                // Streaming: end marker
                                callback.onMessage("stream_end", "");
                            } else if (line.startsWith("[SESSION_ID]")) {
                                String capturedSessionId = line.substring("[SESSION_ID]".length()).trim();
                                callback.onMessage("session_id", capturedSessionId);
                            } else if (line.startsWith("[TOOL_RESULT]")) {
                                String toolResultJson = line.substring("[TOOL_RESULT]".length()).trim();
                                callback.onMessage("tool_result", toolResultJson);
                            } else if (line.startsWith("[USAGE]")) {
                                String usageJson = line.substring("[USAGE]".length()).trim();
                                callback.onMessage("usage", usageJson);
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
                    process.waitFor();

                    int exitCode = process.exitValue();
                    boolean wasInterrupted = processManager.wasInterrupted(channelId);
                    LOG.debug("[ClaudeSDKBridge] Process exited, exitCode=" + exitCode + ", wasInterrupted=" + wasInterrupted + ", hadSendError=" + hadSendError[0]);

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
                        // Already had a SEND_ERROR — error was already reported via onError.
                        // Still need to signal completion so the handler cleans up stream state.
                        result.success = exitCode == 0;
                        callback.onComplete(result);
                    }

                    return result;
                } finally {
                    processManager.unregisterProcess(channelId, process);
                    processManager.waitForProcessTermination(process);
                }

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                errorAlreadyReported[0] = true;
                callback.onError(e.getMessage());
                return result;
            }
        }).exceptionally(ex -> {
            if (errorAlreadyReported[0]) {
                LOG.debug("[ClaudeSDKBridge] Skipping duplicate onError in exceptionally (already reported by catch)");
                return new SDKResult();
            }
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

            File workDir = getDirectoryResolver().findSdkDir();
            if (workDir == null || !workDir.exists()) {
                throw new RuntimeException("Bridge directory not ready or invalid");
            }

            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(CHANNEL_SCRIPT);
            command.add("claude");
            command.add("getSession");
            command.add(sessionId);
            command.add(cwd != null ? cwd : "");

            ProcessBuilder pb = new ProcessBuilder(command);
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
            LOG.info("[getSessionMessages] Raw output length: " + outputStr.length());
            LOG.info("[getSessionMessages] Raw output (first 300 chars): " +
                     (outputStr.length() > 300 ? outputStr.substring(0, 300) + "..." : outputStr));

            // Find the last complete JSON object in the output
            // This handles cases where Node.js outputs multiple lines (logs, warnings)
            // before the actual JSON result
            String jsonStr = extractLastJsonLine(outputStr);
            if (jsonStr != null) {
                LOG.info("[getSessionMessages] Extracted JSON: " + (jsonStr.length() > 500 ? jsonStr.substring(0, 500) + "..." : jsonStr));
                JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
                LOG.info("[getSessionMessages] JSON parsed successfully, success=" +
                         (jsonResult.has("success") ? jsonResult.get("success").getAsBoolean() : "null"));

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
            } else {
                LOG.error("[getSessionMessages] Failed to extract JSON from output");
                throw new RuntimeException("Failed to extract JSON from Node.js output");
            }

        } catch (Exception e) {
            throw new RuntimeException("Failed to get session messages: " + e.getMessage(), e);
        }
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

                File bridgeDir = getDirectoryResolver().findSdkDir();
                if (bridgeDir == null || !bridgeDir.exists()) {
                    LOG.warn("[McpStatus] Bridge directory not ready or invalid");
                    LOG.warn("[McpStatus] This is usually caused by missing node_modules in development environment.");
                    LOG.warn("[McpStatus] Please run: cd ai-bridge && npm install");
                    return new ArrayList<>();
                }

                List<String> command = new ArrayList<>();
                command.add(node);
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
                final boolean[] readerDone = {false};
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
                    } finally {
                        readerDone[0] = true;
                    }
                });
                readerThread.start();

                // 65-second timeout: STDIO verification 30s + process startup/npm download overhead
                long deadline = System.currentTimeMillis() + 65000;
                while (!found[0] && !readerDone[0] && System.currentTimeMillis() < deadline) {
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

                LOG.info("[McpStatus] Marker not found (found=" + found[0] + ", readerDone=" + readerDone[0] + ", elapsed=" + elapsed + "ms), trying fallback");

                // Fallback: first try to find the [MCP_SERVER_STATUS] marker line in the output
                String outputStr = output.toString().trim();
                for (String line : outputStr.split("\n")) {
                    if (line.startsWith("[MCP_SERVER_STATUS]")) {
                        String markerJson = line.substring("[MCP_SERVER_STATUS]".length()).trim();
                        try {
                            JsonArray serversArray = this.gson.fromJson(markerJson, JsonArray.class);
                            for (var server : serversArray) {
                                servers.add(server.getAsJsonObject());
                            }
                            LOG.info("[McpStatus] Fallback marker parse: " + servers.size() + " servers in " + elapsed + "ms");
                            return servers;
                        } catch (Exception e) {
                            LOG.debug("[McpStatus] Fallback marker parse failed: " + e.getMessage());
                        }
                    }
                }

                // Fallback: use extractLastJsonLine for multi-line output handling
                String jsonStr = extractLastJsonLine(outputStr);
                if (jsonStr != null) {
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

    /**
     * Get MCP server tools list.
     */
    public CompletableFuture<JsonObject> getMcpServerTools(String serverId) {
        return CompletableFuture.supplyAsync(() -> {
            Process process = null;
            long startTime = System.currentTimeMillis();
            LOG.info("[McpTools] Starting getMcpServerTools, serverId=" + serverId);

            try {
                String node = nodeDetector.findNodeExecutable();

                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("serverId", serverId != null ? serverId : "");
                String stdinJson = this.gson.toJson(stdinInput);

                File bridgeDir = getDirectoryResolver().findSdkDir();
                if (bridgeDir == null || !bridgeDir.exists()) {
                    LOG.warn("[McpTools] Bridge directory not ready or invalid");
                    LOG.warn("[McpTools] This is usually caused by missing node_modules in development environment.");
                    LOG.warn("[McpTools] Please run: cd ai-bridge && npm install");
                    JsonObject errorResult = new JsonObject();
                    errorResult.addProperty("serverId", serverId);
                    errorResult.addProperty("error", "Bridge directory not ready");
                    return errorResult;
                }

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");
                command.add("getMcpServerTools");

                ProcessBuilder pb = new ProcessBuilder(command);
                pb.directory(bridgeDir);
                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);
                pb.environment().put("CLAUDE_USE_STDIN", "true");

                process = pb.start();
                processManager.registerProcess("__mcp_tools__", process);
                final Process finalProcess = process;

                try (java.io.OutputStream stdin = process.getOutputStream()) {
                    stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                } catch (Exception e) {
                    LOG.warn("[McpTools] Failed to write stdin: " + e.getMessage());
                }

                final boolean[] found = {false};
                final boolean[] readerDone = {false};
                final String[] mcpToolsJson = {null};
                final StringBuilder output = new StringBuilder();

                Thread readerThread = new Thread(() -> {
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while (!found[0] && (line = reader.readLine()) != null) {
                            output.append(line).append("\n");

                            if (line.startsWith("[MCP_SERVER_TOOLS]")) {
                                mcpToolsJson[0] = line.substring("[MCP_SERVER_TOOLS]".length()).trim();
                                found[0] = true;
                                break;
                            }
                        }
                    } catch (Exception e) {
                        LOG.debug("[McpTools] Reader thread exception: " + e.getMessage());
                    } finally {
                        readerDone[0] = true;
                    }
                });
                readerThread.start();

                // 65-second timeout: tool retrieval may take longer
                long deadline = System.currentTimeMillis() + 65000;
                while (!found[0] && !readerDone[0] && System.currentTimeMillis() < deadline) {
                    Thread.sleep(100);
                }

                long elapsed = System.currentTimeMillis() - startTime;

                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }

                if (found[0] && mcpToolsJson[0] != null && !mcpToolsJson[0].isEmpty()) {
                    try {
                        JsonObject result = this.gson.fromJson(mcpToolsJson[0], JsonObject.class);
                        LOG.info("[McpTools] Successfully got tools for server " + serverId + " in " + elapsed + "ms");
                        return result;
                    } catch (Exception e) {
                        LOG.warn("[McpTools] Failed to parse MCP tools JSON: " + e.getMessage());
                    }
                }

                // Fallback: use extractLastJsonLine for multi-line output handling
                String outputStr = output.toString().trim();
                String jsonStr = extractLastJsonLine(outputStr);
                if (jsonStr != null) {
                    try {
                        JsonObject jsonResult = this.gson.fromJson(jsonStr, JsonObject.class);
                        if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                            return jsonResult;
                        }
                    } catch (Exception e) {
                        LOG.debug("[McpTools] Fallback JSON parse failed: " + e.getMessage());
                    }
                }

                // Return error result if nothing found
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("serverId", serverId);
                errorResult.addProperty("error", "Failed to get tools list");
                return errorResult;

            } catch (Exception e) {
                LOG.error("[McpTools] Exception: " + e.getMessage());
                JsonObject errorResult = new JsonObject();
                errorResult.addProperty("serverId", serverId);
                errorResult.addProperty("error", e.getMessage());
                return errorResult;
            } finally {
                if (process != null) {
                    try {
                        if (process.isAlive()) {
                            PlatformUtils.terminateProcess(process);
                        }
                    } finally {
                        processManager.unregisterProcess("__mcp_tools__", process);
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

                // Check if bridge directory is ready
                if (workDir == null || !workDir.exists()) {
                    response.addProperty("success", false);
                    response.addProperty("error", "Bridge directory not ready or invalid");
                    return response;
                }

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

                // Parse result: use extractLastJsonLine for multi-line output handling
                String outputStr;
                try {
                    outputStr = outputFuture.get(5, TimeUnit.SECONDS).trim();
                } catch (Exception e) {
                    outputStr = "";
                }
                String jsonStr = extractLastJsonLine(outputStr);
                if (jsonStr != null) {
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
    // Daemon mode message sending
    // ============================================================================

    /**
     * Send message via the long-running daemon process.
     * This avoids the ~5-10s overhead of spawning a new Node.js process per request.
     */
    private CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
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
            Boolean disableThinking,
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            final boolean[] hadSendError = {false};
            final String[] lastNodeError = {null};

            try {
                // Build params (same fields as stdinInput in process mode)
                JsonObject params = buildSendParams(
                        message, sessionId, cwd, permissionMode, model,
                        attachments, openedFiles, agentPrompt, streaming, disableThinking);

                boolean hasAttachments = attachments != null && !attachments.isEmpty()
                        && params.has("attachments");

                // Add per-request environment variables
                JsonObject envVars = new JsonObject();
                envVars.addProperty("CLAUDE_USE_STDIN", "true");
                if (cwd != null && !cwd.isEmpty()
                        && !"undefined".equals(cwd) && !"null".equals(cwd)) {
                    envVars.addProperty("IDEA_PROJECT_PATH", cwd);
                    envVars.addProperty("PROJECT_PATH", cwd);
                }
                params.add("env", envVars);

                String method = hasAttachments ? "claude.sendWithAttachments" : "claude.send";
                LOG.info("[ClaudeSDKBridge] Sending via daemon: " + method);

                CompletableFuture<Boolean> cmdFuture = daemon.sendCommand(
                        method, params, new DaemonBridge.DaemonOutputCallback() {
                    @Override
                    public void onLine(String line) {
                        // Capture Node.js error logs
                        if (line.startsWith("[UNCAUGHT_ERROR]")
                                || line.startsWith("[UNHANDLED_REJECTION]")
                                || line.startsWith("[COMMAND_ERROR]")
                                || line.startsWith("[STARTUP_ERROR]")
                                || line.startsWith("[ERROR]")) {
                            LOG.warn("[Node.js ERROR] " + line);
                            lastNodeError[0] = line;
                        }
                        // Delegate to existing tag processing
                        processOutputLine(line, callback, result,
                                assistantContent, hadSendError, lastNodeError);
                    }

                    @Override
                    public void onStderr(String text) {
                        if (text != null && text.startsWith("[SEND_ERROR]")) {
                            processOutputLine(text, callback, result,
                                    assistantContent, hadSendError, lastNodeError);
                            return;
                        }
                        LOG.debug("[DaemonBridge:stderr] " + text);
                    }

                    @Override
                    public void onError(String error) {
                        if (!hadSendError[0]) {
                            result.success = false;
                            result.error = error;
                        }
                    }

                    @Override
                    public void onComplete(boolean success) {
                        // Completion is handled after future.get() below
                    }
                });

                // Block until daemon signals completion.
                // Use bounded polling instead of a hard 5-minute timeout to avoid
                // false failures for long-running tasks that are still streaming.
                Boolean success;
                long waitStart = System.currentTimeMillis();
                long lastProgressLogAt = waitStart;
                while (true) {
                    try {
                        success = cmdFuture.get(30, TimeUnit.SECONDS);
                        break;
                    } catch (TimeoutException timeout) {
                        if (!daemon.isAlive()) {
                            throw new RuntimeException("Daemon process is not alive while waiting for response", timeout);
                        }
                        long now = System.currentTimeMillis();
                        // Throttle progress logs (once per minute)
                        if (now - lastProgressLogAt >= 60_000) {
                            long elapsedSec = (now - waitStart) / 1000;
                            LOG.info("[ClaudeSDKBridge] Daemon request still running (" + elapsedSec + "s), waiting...");
                            lastProgressLogAt = now;
                        }
                    }
                }

                // Finalize result
                result.finalResult = assistantContent.toString();
                result.messageCount = result.messages.size();

                if (!hadSendError[0]) {
                    result.success = success != null && success;
                    if (result.success) {
                        callback.onComplete(result);
                    } else {
                        String errorMsg = "Daemon command failed";
                        if (lastNodeError[0] != null) {
                            errorMsg += "\n\nDetails: " + lastNodeError[0];
                        }
                        if (result.error == null) {
                            result.error = errorMsg;
                        }
                        callback.onError(result.error);
                    }
                }

                return result;
            } catch (Exception e) {
                if (!hadSendError[0]) {
                    result.success = false;
                    result.error = "Daemon request failed: " + extractErrorMessage(e);
                    callback.onError(result.error);
                }
                return result;
            }
        }).exceptionally(ex -> {
            SDKResult errorResult = new SDKResult();
            errorResult.success = false;
            errorResult.error = extractErrorMessage(ex);
            callback.onError(errorResult.error);
            return errorResult;
        });
    }

    private String extractErrorMessage(Throwable throwable) {
        if (throwable == null) {
            return "Unknown error";
        }

        Throwable current = throwable;
        while (current != null) {
            String msg = current.getMessage();
            if (msg != null && !msg.trim().isEmpty()) {
                return msg;
            }
            current = current.getCause();
        }
        return throwable.getClass().getSimpleName();
    }

    /**
     * Build the params JSON for a send command (shared between daemon and process modes).
     */
    private JsonObject buildSendParams(
            String message, String sessionId, String cwd,
            String permissionMode, String model,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFiles, String agentPrompt,
            Boolean streaming, Boolean disableThinking
    ) {
        JsonObject params = new JsonObject();
        params.addProperty("message", message);
        params.addProperty("sessionId", sessionId != null ? sessionId : "");
        params.addProperty("cwd", cwd != null ? cwd : "");
        params.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        params.addProperty("model", model != null ? model : "");

        if (attachments != null && !attachments.isEmpty()) {
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
                params.add("attachments", gson.fromJson(gson.toJson(serializable), JsonArray.class));
            } catch (Exception e) {
                LOG.debug("Failed to serialize attachments: " + e.getMessage());
            }
        }

        if (openedFiles != null && openedFiles.size() > 0) {
            params.add("openedFiles", openedFiles);
        }
        if (agentPrompt != null && !agentPrompt.isEmpty()) {
            params.addProperty("agentPrompt", agentPrompt);
        }
        if (streaming != null) {
            params.addProperty("streaming", streaming);
        }
        if (disableThinking != null && disableThinking) {
            params.addProperty("disableThinking", true);
        }

        return params;
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

    /**
     * Sanitize sensitive data from JSON string for logging.
     * Replaces API keys, tokens, passwords, and secrets with [REDACTED].
     *
     * @param json The JSON string to sanitize
     * @return Sanitized JSON string safe for logging
     */
    private String sanitizeSensitiveData(String json) {
        if (json == null || json.isEmpty()) {
            return json;
        }
        return SENSITIVE_DATA_PATTERN.matcher(json).replaceAll("$1: [REDACTED]");
    }

    /**
     * Extract the last complete JSON object from multi-line output.
     * Handles cases where Node.js outputs debug logs before the JSON result.
     *
     * @param outputStr The complete output string
     * @return The extracted JSON string, or null if not found
     */
    private String extractLastJsonLine(String outputStr) {
        if (outputStr == null || outputStr.isEmpty()) {
            return null;
        }

        // Split by newlines and search backwards for a line starting with '{'
        String[] lines = outputStr.split("\\r?\\n");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (line.startsWith("{") && line.endsWith("}")) {
                // This looks like a complete JSON object
                return line;
            }
        }

        // Fallback: If no complete JSON line found, try to parse the entire output
        // This handles single-line output without newlines
        if (outputStr.startsWith("{") && outputStr.endsWith("}")) {
            return outputStr;
        }

        // Last resort: find the first '{' and try to extract from there
        int jsonStart = outputStr.indexOf("{");
        if (jsonStart != -1) {
            return outputStr.substring(jsonStart);
        }

        return null;
    }
}
