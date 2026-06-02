package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.provider.common.BaseSDKBridge;
import com.github.claudecodegui.provider.common.DaemonBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

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
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * opencode SDK bridge.
 *
 * Uses the user-installed opencode CLI through @opencode-ai/sdk. Provider auth,
 * model selection, and LLM configuration stay owned by the user's opencode
 * installation/config.
 */
public class OpenCodeSDKBridge extends BaseSDKBridge {

    private static final int QUERY_TIMEOUT_SECONDS = 30;
    private static final int MCP_STATUS_QUERY_TIMEOUT_SECONDS = 45;
    private static final long DAEMON_RETRY_DELAY_MS = 60_000;
    private final Object daemonLock = new Object();
    private volatile DaemonBridge daemonBridge;
    private volatile long daemonRetryAfter = 0;

    public OpenCodeSDKBridge() {
        super(OpenCodeSDKBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "opencode";
    }

    @Override
    protected void configureProviderEnv(Map<String, String> env, String stdinJson) {
        env.put("OPENCODE_USE_STDIN", "true");
    }

    @Override
    protected void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    ) {
        if (line.contains("[DEBUG]")) {
            LOG.debug("[opencode] " + line);
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
        } else if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
        } else if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
        } else if (line.startsWith("[BLOCK_RESET]")) {
            callback.onMessage("block_reset", "");
        } else if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        } else if (line.startsWith("[THREAD_ID]")) {
            String receivedSessionId = line.substring("[THREAD_ID]".length()).trim();
            callback.onMessage("session_id", receivedSessionId);
        } else if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                if (msg != null) {
                    result.messages.add(msg);
                    String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                            ? msg.get("type").getAsString()
                            : "unknown";
                    if ("status".equals(msgType) && msg.has("message") && !msg.get("message").isJsonNull()) {
                        callback.onMessage(msgType, msg.get("message").getAsString());
                    } else {
                        callback.onMessage(msgType, jsonStr);
                    }
                }
            } catch (Exception ignored) {
            }
        } else if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
        } else if (line.startsWith("[THINKING_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", delta);
        } else if (line.startsWith("[SEND_ERROR]")) {
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj != null && obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
        }
    }

    public CompletableFuture<SDKResult> sendMessage(
            String channelId,
            String message,
            String sessionId,
            String cwd,
            List<ClaudeSession.Attachment> attachments,
            String permissionMode,
            String model,
            String agent,
            String modelVariant,
            MessageCallback callback
    ) {
        JsonObject stdinInput = new JsonObject();
        stdinInput.addProperty("message", message != null ? message : "");
        stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
        stdinInput.addProperty("cwd", cwd != null ? cwd : "");
        stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
        stdinInput.addProperty("model", model != null ? model : "");
        stdinInput.addProperty("agent", agent != null ? agent : "");
        stdinInput.add("attachments", buildAttachments(attachments));
        if (modelVariant != null) {
            String normalizedVariant = modelVariant.trim();
            if (!normalizedVariant.isEmpty() && !"default".equalsIgnoreCase(normalizedVariant)) {
                stdinInput.addProperty("variant", normalizedVariant);
            }
        }

        DaemonBridge db = getDaemonBridge();
        if (db != null) {
            return sendMessageViaDaemon(db, channelId, stdinInput, callback);
        }

        return executeStreamingCommand(
                channelId,
                buildBaseCommand("send"),
                gson.toJson(stdinInput),
                cwd,
                callback
        );
    }

    private CompletableFuture<SDKResult> sendMessageViaDaemon(
            DaemonBridge daemon,
            String channelId,
            JsonObject params,
            MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            AtomicBoolean hadSendError = new AtomicBoolean(false);
            AtomicBoolean wasAborted = new AtomicBoolean(false);
            AtomicReference<String> lastNodeError = new AtomicReference<>(null);

            try {
                params.addProperty("persistentRuntime", true);
                params.add("env", buildDaemonEnv());

                CompletableFuture<Boolean> commandFuture = daemon.sendCommand(
                        "opencode.send",
                        params,
                        new DaemonBridge.DaemonOutputCallback() {
                            @Override
                            public void onLine(String line) {
                                if (line.startsWith("[UNCAUGHT_ERROR]")
                                        || line.startsWith("[UNHANDLED_REJECTION]")
                                        || line.startsWith("[COMMAND_ERROR]")
                                        || line.startsWith("[STARTUP_ERROR]")
                                        || line.startsWith("[ERROR]")) {
                                    LOG.warn("[Node.js ERROR] " + line);
                                    lastNodeError.set(line);
                                }
                                processOutputLine(line, callback, result, assistantContent, hadSendError, lastNodeError);
                            }

                            @Override
                            public void onStderr(String text) {
                                if (text != null && text.startsWith("[SEND_ERROR]")) {
                                    processOutputLine(text, callback, result, assistantContent, hadSendError, lastNodeError);
                                    return;
                                }
                                LOG.debug("[opencode daemon:stderr] " + text);
                            }

                            @Override
                            public void onError(String error) {
                                if (!hadSendError.get()) {
                                    result.success = false;
                                    result.error = error;
                                }
                            }

                            @Override
                            public void onAbort() {
                                wasAborted.set(true);
                                onComplete(false);
                            }

                            @Override
                            public void onComplete(boolean success) {
                            }
                        }
                );

                Boolean success;
                while (true) {
                    try {
                        success = commandFuture.get(30, TimeUnit.SECONDS);
                        break;
                    } catch (TimeoutException timeout) {
                        if (!daemon.isAlive()) {
                            throw new RuntimeException("opencode daemon process is not alive while waiting for response", timeout);
                        }
                        LOG.info("[OpenCodeSDKBridge] opencode daemon request still running for channel: " + channelId);
                    }
                }

                result.finalResult = assistantContent.toString();
                result.messageCount = result.messages.size();

                if (!hadSendError.get()) {
                    result.success = success != null && success;
                    if (result.success) {
                        callback.onComplete(result);
                    } else if (wasAborted.get()) {
                        result.error = "User interrupted";
                        callback.onComplete(result);
                    } else {
                        String errorMsg = result.error != null ? result.error : "opencode daemon command failed";
                        String nodeErr = lastNodeError.get();
                        if (nodeErr != null && !nodeErr.isEmpty()) {
                            errorMsg += "\n\nDetails: " + nodeErr;
                        }
                        result.error = errorMsg;
                        callback.onError(errorMsg);
                    }
                }

                return result;
            } catch (Exception e) {
                if (wasAborted.get()) {
                    result.success = false;
                    result.error = "User interrupted";
                    callback.onComplete(result);
                } else if (!hadSendError.get()) {
                    result.success = false;
                    result.error = e.getMessage();
                    callback.onError(result.error);
                }
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

    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            JsonObject jsonResult = runSessionMessagesQuery(sessionId, cwd);
            if (!jsonResult.has("success") || !jsonResult.get("success").getAsBoolean()) {
                String error = jsonResult.has("error") && !jsonResult.get("error").isJsonNull()
                        ? jsonResult.get("error").getAsString()
                        : "Unknown opencode session history error";
                LOG.warn("[OpenCodeSDKBridge] Failed to get session messages: " + error);
                return List.of();
            }

            List<JsonObject> messages = new ArrayList<>();
            if (jsonResult.has("messages") && jsonResult.get("messages").isJsonArray()) {
                JsonArray array = jsonResult.getAsJsonArray("messages");
                for (var element : array) {
                    if (element != null && element.isJsonObject()) {
                        messages.add(element.getAsJsonObject());
                    }
                }
            }
            return messages;
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to load opencode session messages: " + e.getMessage(), e);
            return List.of();
        }
    }

    public JsonObject listModels(String cwd) {
        try {
            return runJsonProcessCommand("listModels", List.of(cwd != null ? cwd : ""));
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to list opencode models: " + e.getMessage(), e);
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    public JsonObject listSessions(String cwd) {
        try {
            return runJsonProcessCommand("listSessions", List.of(cwd != null ? cwd : ""));
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to list opencode sessions: " + e.getMessage(), e);
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    public JsonObject deleteSession(String sessionId, String cwd) {
        try {
            return runJsonCommand("deleteSession", List.of(
                    sessionId != null ? sessionId : "",
                    cwd != null ? cwd : ""
            ));
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to delete opencode session: " + e.getMessage(), e);
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    public JsonObject listAgents(String cwd) {
        try {
            return runJsonProcessCommand("listAgents", List.of(cwd != null ? cwd : ""));
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to list opencode agents: " + e.getMessage(), e);
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    public JsonObject listCommands(String cwd) {
        try {
            return runJsonProcessCommand("listCommands", List.of(cwd != null ? cwd : ""));
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to list opencode commands: " + e.getMessage(), e);
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    public JsonObject listMcpServers(String cwd) {
        try {
            return runJsonCommand("listMcpServers", List.of(cwd != null ? cwd : ""));
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to list opencode MCP servers: " + e.getMessage(), e);
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    public JsonObject listMcpServerStatus(String cwd) {
        try {
            return runJsonCommand("listMcpServerStatus", List.of(cwd != null ? cwd : ""));
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to list opencode MCP server status: " + e.getMessage(), e);
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("error", e.getMessage());
            return error;
        }
    }

    public JsonObject getMcpServerTools(String serverId, String cwd) {
        try {
            return runJsonCommand("getMcpServerTools", List.of(
                    serverId != null ? serverId : "",
                    cwd != null ? cwd : ""
            ));
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to get opencode MCP server tools: " + e.getMessage(), e);
            JsonObject error = new JsonObject();
            error.addProperty("success", false);
            error.addProperty("serverId", serverId != null ? serverId : "");
            error.addProperty("error", e.getMessage());
            error.add("tools", new JsonArray());
            return error;
        }
    }

    private JsonObject runSessionMessagesQuery(String sessionId, String cwd) throws Exception {
        if (sessionId == null || sessionId.trim().isEmpty()) {
            throw new IllegalArgumentException("sessionId is required");
        }

        return runJsonCommand("getSessionMessages", List.of(
                sessionId,
                cwd != null ? cwd : ""
        ));
    }

    private JsonObject runJsonCommand(String action, List<String> args) throws Exception {
        DaemonBridge db = getDaemonBridge();
        if (db != null) {
            try {
                return runJsonDaemonCommand(db, action, args);
            } catch (Exception e) {
                LOG.warn("[OpenCodeSDKBridge] Daemon opencode " + action
                        + " failed, falling back to per-process query: " + e.getMessage());
            }
        }

        return runJsonProcessCommand(action, args);
    }

    private JsonObject runJsonDaemonCommand(DaemonBridge daemon, String action, List<String> args) throws Exception {
        JsonObject params = buildJsonCommandParams(action, args);
        params.addProperty("persistentRuntime", true);
        params.add("env", buildDaemonEnv());

        AtomicReference<JsonObject> resultRef = new AtomicReference<>();
        AtomicReference<String> errorRef = new AtomicReference<>();
        CompletableFuture<Boolean> commandFuture = daemon.sendCommand(
                "opencode." + action,
                params,
                new DaemonBridge.DaemonOutputCallback() {
                    @Override
                    public void onLine(String line) {
                        JsonObject parsed = parseJsonLine(line);
                        if (parsed != null) {
                            resultRef.set(parsed);
                        }
                    }

                    @Override
                    public void onStderr(String text) {
                        LOG.debug("[opencode daemon:stderr] " + text);
                    }

                    @Override
                    public void onError(String error) {
                        errorRef.set(error);
                    }

                    @Override
                    public void onComplete(boolean success) {
                    }
                }
        );

        boolean success;
        int timeoutSeconds = jsonCommandTimeoutSeconds(action);
        try {
            success = Boolean.TRUE.equals(commandFuture.get(timeoutSeconds, TimeUnit.SECONDS));
        } catch (TimeoutException timeout) {
            shutdownDaemon();
            throw new RuntimeException("opencode daemon query timed out after "
                    + timeoutSeconds + " seconds", timeout);
        }

        JsonObject result = resultRef.get();
        if (result != null) {
            return result;
        }
        if (!success && errorRef.get() != null) {
            throw new RuntimeException(errorRef.get());
        }
        throw new RuntimeException("No JSON response received from opencode daemon");
    }

    private JsonObject parseJsonLine(String line) {
        if (line == null) {
            return null;
        }
        String trimmed = line.trim();
        if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
            return null;
        }
        try {
            return gson.fromJson(trimmed, JsonObject.class);
        } catch (Exception ignored) {
            return null;
        }
    }

    private JsonObject buildJsonCommandParams(String action, List<String> args) {
        JsonObject params = new JsonObject();
        switch (action) {
            case "deleteSession":
            case "getSessionMessages":
                params.addProperty("sessionId", args.size() > 0 ? args.get(0) : "");
                params.addProperty("cwd", args.size() > 1 ? args.get(1) : "");
                break;
            case "getMcpServerTools":
                params.addProperty("serverId", args.size() > 0 ? args.get(0) : "");
                params.addProperty("cwd", args.size() > 1 ? args.get(1) : "");
                break;
            case "listModels":
            case "listSessions":
            case "listAgents":
            case "listCommands":
            case "listMcpServers":
            case "listMcpServerStatus":
            default:
                params.addProperty("cwd", args.size() > 0 ? args.get(0) : "");
                break;
        }
        return params;
    }

    private JsonObject runJsonProcessCommand(String action, List<String> args) throws Exception {
        String node = nodeDetector.findNodeExecutable();
        File bridgeDir = getDirectoryResolver().findSdkDir();
        if (bridgeDir == null || !bridgeDir.exists()) {
            throw new RuntimeException("Bridge directory not ready or invalid");
        }

        List<String> command = buildBaseCommand(action);
        command.addAll(args);

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(bridgeDir);
        pb.redirectErrorStream(true);
        envConfigurator.updateProcessEnvironment(pb, node);

        Process process = pb.start();
        CompletableFuture<String> outputFuture = CompletableFuture.supplyAsync(() -> readProcessOutput(process));

        int timeoutSeconds = jsonCommandTimeoutSeconds(action);
        boolean finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            outputFuture.cancel(true);
            throw new RuntimeException("opencode query timed out after "
                    + timeoutSeconds + " seconds");
        }

        String jsonLine = extractLastJsonLine(outputFuture.get(5, TimeUnit.SECONDS));
        if (jsonLine == null) {
            throw new RuntimeException("Failed to extract JSON from opencode query output");
        }
        return gson.fromJson(jsonLine, JsonObject.class);
    }

    private int jsonCommandTimeoutSeconds(String action) {
        return "listMcpServerStatus".equals(action)
                ? MCP_STATUS_QUERY_TIMEOUT_SECONDS
                : QUERY_TIMEOUT_SECONDS;
    }

    private DaemonBridge getDaemonBridge() {
        DaemonBridge current = daemonBridge;
        if (current != null && current.isAlive()) {
            return current;
        }
        if (System.currentTimeMillis() < daemonRetryAfter) {
            return null;
        }

        synchronized (daemonLock) {
            current = daemonBridge;
            if (current != null && current.isAlive()) {
                return current;
            }

            daemonRetryAfter = System.currentTimeMillis() + DAEMON_RETRY_DELAY_MS;
            try {
                if (current != null) {
                    current.stop();
                }
                DaemonBridge newBridge = new DaemonBridge(
                        nodeDetector,
                        getDirectoryResolver(),
                        envConfigurator,
                        Map.of("AI_BRIDGE_DAEMON_PRELOAD", "opencode")
                );
                if (newBridge.start()) {
                    daemonBridge = newBridge;
                    daemonRetryAfter = 0;
                    LOG.info("[OpenCodeSDKBridge] opencode daemon bridge started successfully");
                    return newBridge;
                }
                LOG.warn("[OpenCodeSDKBridge] Failed to start opencode daemon, using per-process mode");
            } catch (Exception e) {
                LOG.warn("[OpenCodeSDKBridge] opencode daemon init failed: " + e.getMessage());
            }
            return null;
        }
    }

    private void shutdownDaemon() {
        DaemonBridge current = daemonBridge;
        if (current != null) {
            current.stop();
            daemonBridge = null;
            daemonRetryAfter = 0;
        }
    }

    private JsonObject buildDaemonEnv() {
        Map<String, String> env = new HashMap<>();
        env.put("OPENCODE_USE_STDIN", "true");
        envConfigurator.configurePermissionEnv(env);

        JsonObject json = new JsonObject();
        for (Map.Entry<String, String> entry : env.entrySet()) {
            if (entry.getValue() != null) {
                json.addProperty(entry.getKey(), entry.getValue());
            }
        }
        return json;
    }

    @Override
    public void interruptChannel(String channelId) {
        DaemonBridge db = daemonBridge;
        if (db != null && db.isAlive()) {
            try {
                db.sendAbort();
            } catch (Exception e) {
                LOG.warn("[OpenCodeSDKBridge] opencode daemon abort failed: " + e.getMessage());
            }
        }
        super.interruptChannel(channelId);
    }

    @Override
    public void cleanupAllProcesses() {
        shutdownDaemon();
        super.cleanupAllProcesses();
    }

    @Override
    public void setNodeExecutable(String path) {
        shutdownDaemon();
        super.setNodeExecutable(path);
    }

    private String readProcessOutput(Process process) {
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to read opencode query output", e);
        }
        return output.toString();
    }

    private String extractLastJsonLine(String output) {
        if (output == null || output.trim().isEmpty()) {
            return null;
        }
        String[] lines = output.split("\\R");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (line.startsWith("{") && line.endsWith("}")) {
                return line;
            }
        }
        return null;
    }

    private JsonArray buildAttachments(List<ClaudeSession.Attachment> attachments) {
        JsonArray attachmentsArray = new JsonArray();
        if (attachments == null || attachments.isEmpty()) {
            return attachmentsArray;
        }

        for (ClaudeSession.Attachment attachment : attachments) {
            if (attachment == null) {
                continue;
            }
            JsonObject obj = new JsonObject();
            obj.addProperty("fileName", attachment.fileName != null ? attachment.fileName : "");
            obj.addProperty("mediaType", attachment.mediaType != null ? attachment.mediaType : "");
            obj.addProperty("data", attachment.data != null ? attachment.data : "");
            attachmentsArray.add(obj);
        }
        return attachmentsArray;
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            String decoded = gson.fromJson(jsonStr, String.class);
            return decoded != null ? decoded : "";
        } catch (Exception e) {
            LOG.warn("[OpenCodeSDKBridge] Failed to decode JSON string payload, falling back to raw: " + e.getMessage());
            return jsonStr;
        }
    }
}
