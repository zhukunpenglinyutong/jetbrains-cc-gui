package com.github.claudecodegui.provider.claude;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;

/**
 * ACP (Agent Client Protocol) bridge for Claude.
 * Spawns claude-code-acp as a subprocess and communicates via stdio JSON-RPC 2.0.
 * Replaces the Node.js ai-bridge + Claude Agent SDK approach.
 */
public class ACPBridge {

    private static final Logger LOG = Logger.getInstance(ACPBridge.class);
    private static final Gson GSON = new Gson();
    private static final int INIT_TIMEOUT_SECONDS = 30;
    private static final int SESSION_TIMEOUT_SECONDS = 30;

    private static final Pattern SENSITIVE_DATA_PATTERN = Pattern.compile(
            "(api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|" +
            "authorization|bearer|credential|credentials|private[_-]?key|access[_-]?key)" +
            "[\"']?\\s*[:=]\\s*[\"']?[^\"'\\s,}]{8,}",
            Pattern.CASE_INSENSITIVE
    );

    private final String acpBinaryPath;
    private final AtomicInteger requestIdCounter = new AtomicInteger(0);

    /** Canonical root directory for the session; filesystem operations are restricted to this tree. */
    private volatile Path sessionRoot;

    private volatile Process acpProcess;
    private volatile BufferedWriter stdinWriter;
    private volatile Thread readerThread;
    private volatile String currentSessionId;
    private volatile boolean initialized = false;

    private final ConcurrentHashMap<Integer, CompletableFuture<JsonObject>> pendingRequests = new ConcurrentHashMap<>();
    private volatile MessageCallback activeCallback;
    private volatile SDKResult activeResult;
    private volatile StringBuilder activeContent;

    private final Object processLock = new Object();

    public ACPBridge() {
        String home = System.getProperty("user.home");
        this.acpBinaryPath = Paths.get(home, ".devbox", "ai", "claude", "claude-code-acp").toString();
    }

    public ACPBridge(String binaryPath) {
        this.acpBinaryPath = binaryPath;
    }

    public boolean isAvailable() {
        return Files.isExecutable(Path.of(acpBinaryPath));
    }

    public boolean isConnected() {
        return acpProcess != null && acpProcess.isAlive() && initialized;
    }

    /**
     * Start the ACP agent subprocess and initialize the connection.
     */
    public boolean connect(String cwd) {
        synchronized (processLock) {
            if (isConnected()) {
                return true;
            }
            disconnect();

            try {
                ProcessBuilder pb = new ProcessBuilder(acpBinaryPath);
                if (cwd != null && !cwd.isEmpty()) {
                    pb.directory(new File(cwd));
                    sessionRoot = Path.of(cwd).toRealPath();
                } else {
                    sessionRoot = Path.of(System.getProperty("user.dir")).toRealPath();
                }
                pb.redirectErrorStream(false);

                Map<String, String> env = pb.environment();
                String apiKey = System.getenv("ANTHROPIC_API_KEY");
                if (apiKey != null) {
                    env.put("ANTHROPIC_API_KEY", apiKey);
                }

                acpProcess = pb.start();
                stdinWriter = new BufferedWriter(
                    new OutputStreamWriter(acpProcess.getOutputStream(), StandardCharsets.UTF_8));

                startReaderThread();
                startStderrDrainer();

                JsonObject initResult = sendInitialize();
                if (initResult != null) {
                    initialized = true;
                    LOG.info("[ACPBridge] Initialized successfully. Agent info: " + initResult);
                    return true;
                } else {
                    LOG.error("[ACPBridge] Initialize failed - no response");
                    disconnect();
                    return false;
                }
            } catch (Exception e) {
                LOG.error("[ACPBridge] Failed to start ACP process: " + e.getMessage(), e);
                disconnect();
                return false;
            }
        }
    }

    public void disconnect() {
        synchronized (processLock) {
            initialized = false;
            currentSessionId = null;
            sessionRoot = null;

            if (readerThread != null) {
                readerThread.interrupt();
                readerThread = null;
            }

            if (stdinWriter != null) {
                try {
                    stdinWriter.close();
                } catch (IOException ignored) {
                }
                stdinWriter = null;
            }

            if (acpProcess != null) {
                acpProcess.destroyForcibly();
                try {
                    acpProcess.waitFor(5, TimeUnit.SECONDS);
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
                acpProcess = null;
            }

            pendingRequests.values().forEach(f ->
                f.completeExceptionally(new RuntimeException("ACP connection closed")));
            pendingRequests.clear();
        }
    }

    /**
     * Create a new ACP session.
     */
    public String createSession(String cwd) throws Exception {
        JsonObject params = new JsonObject();
        if (cwd != null) {
            params.addProperty("cwd", cwd);
        }
        params.add("mcpServers", new JsonArray());

        JsonObject result = sendRequest("session/new", params, SESSION_TIMEOUT_SECONDS);
        if (result != null && result.has("sessionId")) {
            currentSessionId = result.get("sessionId").getAsString();
            LOG.info("[ACPBridge] Session created: " + currentSessionId);
            return currentSessionId;
        }
        throw new RuntimeException("Failed to create ACP session: " + result);
    }

    /**
     * Send a prompt to the agent and stream responses via the callback.
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

            try {
                if (!isConnected()) {
                    if (!connect(cwd)) {
                        result.success = false;
                        result.error = "Failed to connect to ACP agent at: " + acpBinaryPath;
                        callback.onError(result.error);
                        return result;
                    }
                }

                String activeSessionId = currentSessionId;
                if (activeSessionId == null) {
                    activeSessionId = createSession(cwd);
                }

                activeCallback = callback;
                activeResult = result;
                activeContent = assistantContent;

                callback.onMessage("stream_start", "");

                JsonObject params = new JsonObject();
                params.addProperty("sessionId", activeSessionId);

                JsonArray promptContent = new JsonArray();

                if (agentPrompt != null && !agentPrompt.isEmpty()) {
                    JsonObject agentBlock = new JsonObject();
                    agentBlock.addProperty("type", "text");
                    agentBlock.addProperty("text", agentPrompt + "\n\n" + message);
                    promptContent.add(agentBlock);
                } else {
                    JsonObject textBlock = new JsonObject();
                    textBlock.addProperty("type", "text");
                    textBlock.addProperty("text", message);
                    promptContent.add(textBlock);
                }

                if (attachments != null) {
                    for (ClaudeSession.Attachment att : attachments) {
                        if (att != null && att.mediaType != null && att.mediaType.startsWith("image/") && att.data != null) {
                            JsonObject imageBlock = new JsonObject();
                            imageBlock.addProperty("type", "image");
                            imageBlock.addProperty("mimeType", att.mediaType);
                            imageBlock.addProperty("data", att.data);
                            promptContent.add(imageBlock);
                        }
                    }
                }

                params.add("prompt", promptContent);

                JsonObject promptResult = sendRequest("session/prompt", params, 600);

                callback.onMessage("stream_end", "");

                result.finalResult = assistantContent.toString();
                result.success = true;

                if (promptResult != null && promptResult.has("stopReason")) {
                    String stopReason = promptResult.get("stopReason").getAsString();
                    if ("cancelled".equals(stopReason)) {
                        result.success = false;
                        result.error = "User interrupted";
                    }
                }

                callback.onComplete(result);
                return result;

            } catch (Exception e) {
                result.success = false;
                result.error = e.getMessage();
                callback.onError(result.error);
                return result;
            } finally {
                activeCallback = null;
                activeResult = null;
                activeContent = null;
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
     * Cancel an ongoing prompt.
     */
    public void cancel() {
        if (currentSessionId == null || !isConnected()) return;

        try {
            JsonObject params = new JsonObject();
            params.addProperty("sessionId", currentSessionId);
            sendNotification("session/cancel", params);
        } catch (Exception e) {
            LOG.warn("[ACPBridge] Failed to send cancel: " + e.getMessage());
        }
    }

    public void cleanupAllProcesses() {
        disconnect();
    }

    public void interruptChannel(String channelId) {
        cancel();
    }

    public String getSessionId() {
        return currentSessionId;
    }

    // ========================================================================
    // JSON-RPC 2.0 transport
    // ========================================================================

    private JsonObject sendInitialize() {
        JsonObject params = new JsonObject();
        params.addProperty("protocolVersion", 1);

        JsonObject clientCapabilities = new JsonObject();
        JsonObject fsCapability = new JsonObject();
        fsCapability.addProperty("readTextFile", true);
        fsCapability.addProperty("writeTextFile", true);
        clientCapabilities.add("fs", fsCapability);
        clientCapabilities.addProperty("terminal", true);
        params.add("clientCapabilities", clientCapabilities);

        JsonObject clientInfo = new JsonObject();
        clientInfo.addProperty("name", "idea-claude-code-gui");
        clientInfo.addProperty("title", "Claude Code GUI");
        clientInfo.addProperty("version", "0.2.4");
        params.add("clientInfo", clientInfo);

        try {
            return sendRequest("initialize", params, INIT_TIMEOUT_SECONDS);
        } catch (Exception e) {
            LOG.error("[ACPBridge] Initialize request failed: " + e.getMessage());
            return null;
        }
    }

    private JsonObject sendRequest(String method, JsonObject params, int timeoutSeconds) throws Exception {
        int id = requestIdCounter.incrementAndGet();

        JsonObject request = new JsonObject();
        request.addProperty("jsonrpc", "2.0");
        request.addProperty("id", id);
        request.addProperty("method", method);
        request.add("params", params);

        CompletableFuture<JsonObject> future = new CompletableFuture<>();
        pendingRequests.put(id, future);

        writeMessage(request);

        try {
            return future.get(timeoutSeconds, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            pendingRequests.remove(id);
            throw new RuntimeException("ACP request timed out: " + method + " (id=" + id + ")");
        }
    }

    private void sendNotification(String method, JsonObject params) throws IOException {
        JsonObject notification = new JsonObject();
        notification.addProperty("jsonrpc", "2.0");
        notification.addProperty("method", method);
        notification.add("params", params);
        writeMessage(notification);
    }

    private void writeMessage(JsonObject message) throws IOException {
        BufferedWriter writer = stdinWriter;
        if (writer == null) {
            throw new IOException("ACP connection is closed");
        }

        String json = GSON.toJson(message);
        synchronized (writer) {
            writer.write(json);
            writer.newLine();
            writer.flush();
        }
        LOG.debug("[ACPBridge] >> " + sanitize(truncate(json, 200)));
    }

    // ========================================================================
    // Reader thread - processes all stdout from the ACP process
    // ========================================================================

    private void startReaderThread() {
        readerThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(acpProcess.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    processIncomingMessage(line);
                }
            } catch (IOException e) {
                if (!Thread.currentThread().isInterrupted()) {
                    LOG.warn("[ACPBridge] Reader thread error: " + e.getMessage());
                }
            } finally {
                LOG.info("[ACPBridge] Reader thread ended");
                pendingRequests.values().forEach(f ->
                    f.completeExceptionally(new RuntimeException("ACP process terminated")));
                pendingRequests.clear();
            }
        }, "ACP-Reader");
        readerThread.setDaemon(true);
        readerThread.start();
    }

    private void startStderrDrainer() {
        Thread stderrThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(acpProcess.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    LOG.debug("[ACPBridge:stderr] " + line);
                }
            } catch (IOException ignored) {
            }
        }, "ACP-Stderr");
        stderrThread.setDaemon(true);
        stderrThread.start();
    }

    private void processIncomingMessage(String line) {
        if (line == null || line.isBlank()) return;
        LOG.debug("[ACPBridge] << " + sanitize(truncate(line, 300)));

        try {
            JsonObject msg = GSON.fromJson(line, JsonObject.class);

            if (msg.has("method")) {
                handleServerMessage(msg);
            } else if (msg.has("id") && !msg.get("id").isJsonNull()) {
                handleResponse(msg);
            }
        } catch (Exception e) {
            LOG.warn("[ACPBridge] Failed to parse message: " + e.getMessage());
        }
    }

    private void handleResponse(JsonObject msg) {
        int id = msg.get("id").getAsInt();
        CompletableFuture<JsonObject> future = pendingRequests.remove(id);
        if (future == null) {
            LOG.warn("[ACPBridge] No pending request for id: " + id);
            return;
        }

        if (msg.has("error")) {
            JsonObject error = msg.getAsJsonObject("error");
            String errorMsg = error.has("message") ? error.get("message").getAsString() : "Unknown error";
            future.completeExceptionally(new RuntimeException("ACP error: " + errorMsg));
        } else if (msg.has("result")) {
            future.complete(msg.getAsJsonObject("result"));
        } else {
            future.complete(new JsonObject());
        }
    }

    /**
     * Handle incoming notifications and method calls from the agent.
     */
    private void handleServerMessage(JsonObject msg) {
        String method = msg.get("method").getAsString();
        JsonObject params = msg.has("params") ? msg.getAsJsonObject("params") : new JsonObject();

        switch (method) {
            case "session/update":
                handleSessionUpdate(params);
                break;
            case "session/request_permission":
                handlePermissionRequest(msg, params);
                break;
            case "fs/read_text_file":
                handleFsReadFile(msg, params);
                break;
            case "fs/write_text_file":
                handleFsWriteFile(msg, params);
                break;
            default:
                if (msg.has("id")) {
                    sendErrorResponse(msg.get("id").getAsInt(), -32601, "Method not found: " + method);
                }
                break;
        }
    }

    private void handleSessionUpdate(JsonObject params) {
        if (!params.has("update")) return;
        JsonObject update = params.getAsJsonObject("update");
        String updateType = update.has("sessionUpdate") ? update.get("sessionUpdate").getAsString() : "";

        MessageCallback cb = activeCallback;
        StringBuilder content = activeContent;

        switch (updateType) {
            case "agent_message_chunk":
                if (cb != null && update.has("content")) {
                    JsonObject contentBlock = update.getAsJsonObject("content");
                    if (contentBlock.has("type") && "text".equals(contentBlock.get("type").getAsString())) {
                        String text = contentBlock.get("text").getAsString();
                        if (content != null) {
                            content.append(text);
                        }
                        cb.onMessage("content_delta", text);
                    }
                }
                break;

            case "agent_thought_chunk":
                if (cb != null && update.has("content")) {
                    JsonObject contentBlock = update.getAsJsonObject("content");
                    if (contentBlock.has("type") && "text".equals(contentBlock.get("type").getAsString())) {
                        String text = contentBlock.get("text").getAsString();
                        cb.onMessage("thinking_delta", text);
                    }
                }
                break;

            case "tool_call":
            case "tool_call_update":
                if (cb != null) {
                    JsonObject assistantMsg = buildToolCallAssistantMessage(update);
                    cb.onMessage("assistant", GSON.toJson(assistantMsg));
                }
                break;

            case "plan":
                if (cb != null) {
                    cb.onMessage("thinking_delta", formatPlan(update));
                }
                break;

            case "available_commands_update":
                if (cb != null && update.has("commands")) {
                    cb.onMessage("slash_commands", GSON.toJson(update.getAsJsonArray("commands")));
                }
                break;

            default:
                LOG.debug("[ACPBridge] Unhandled session update type: " + updateType);
                break;
        }
    }

    private void handlePermissionRequest(JsonObject msg, JsonObject params) {
        if (!msg.has("id")) return;
        int id = msg.get("id").getAsInt();

        JsonArray permissions = params.has("permissions") ? params.getAsJsonArray("permissions") : new JsonArray();
        String description = params.has("description") ? params.get("description").getAsString() : "(none)";
        LOG.info("[ACPBridge] Permission request: " + description + " | options=" + permissions.size());

        JsonObject result = new JsonObject();
        if (permissions.size() > 0) {
            JsonObject firstOption = permissions.get(0).getAsJsonObject();
            if (firstOption.has("optionId")) {
                String optionId = firstOption.get("optionId").getAsString();
                LOG.info("[ACPBridge] Auto-approving permission option: " + optionId);
                result.addProperty("optionId", optionId);
            }
        }

        sendJsonRpcResponse(id, result);
    }

    private void handleFsReadFile(JsonObject msg, JsonObject params) {
        if (!msg.has("id")) return;
        int id = msg.get("id").getAsInt();

        String path = params.has("path") ? params.get("path").getAsString() : null;
        if (path == null) {
            sendErrorResponse(id, -32602, "Missing path parameter");
            return;
        }

        if (!isPathAllowed(path)) {
            LOG.warn("[ACPBridge] Blocked read outside session root: " + path);
            sendErrorResponse(id, -32600, "Access denied: path is outside the project directory");
            return;
        }

        int startLine = params.has("line") ? params.get("line").getAsInt() : 1;
        int lineLimit = params.has("limit") ? params.get("limit").getAsInt() : -1;

        try {
            List<String> allLines = Files.readAllLines(Path.of(path), StandardCharsets.UTF_8);

            int fromIndex = Math.max(0, startLine - 1);
            int toIndex = allLines.size();
            if (lineLimit > 0) {
                toIndex = Math.min(toIndex, fromIndex + lineLimit);
            }
            fromIndex = Math.min(fromIndex, allLines.size());

            String fileContent = String.join("\n", allLines.subList(fromIndex, toIndex));
            JsonObject result = new JsonObject();
            result.addProperty("content", fileContent);
            sendJsonRpcResponse(id, result);
        } catch (Exception e) {
            sendErrorResponse(id, -32000, "Failed to read file: " + e.getMessage());
        }
    }

    private void handleFsWriteFile(JsonObject msg, JsonObject params) {
        if (!msg.has("id")) return;
        int id = msg.get("id").getAsInt();

        String path = params.has("path") ? params.get("path").getAsString() : null;
        String fileContent = params.has("content") ? params.get("content").getAsString() : null;

        if (path == null || fileContent == null) {
            sendErrorResponse(id, -32602, "Missing path or content parameter");
            return;
        }

        if (!isPathAllowed(path)) {
            LOG.warn("[ACPBridge] Blocked write outside session root: " + path);
            sendErrorResponse(id, -32600, "Access denied: path is outside the project directory");
            return;
        }

        try {
            Files.writeString(Path.of(path), fileContent, StandardCharsets.UTF_8);
            sendJsonRpcResponse(id, new JsonObject());
        } catch (Exception e) {
            sendErrorResponse(id, -32000, "Failed to write file: " + e.getMessage());
        }
    }

    private void sendJsonRpcResponse(int id, JsonObject result) {
        try {
            JsonObject response = new JsonObject();
            response.addProperty("jsonrpc", "2.0");
            response.addProperty("id", id);
            response.add("result", result);
            writeMessage(response);
        } catch (IOException e) {
            LOG.error("[ACPBridge] Failed to send response: " + e.getMessage());
        }
    }

    private void sendErrorResponse(int id, int code, String message) {
        try {
            JsonObject response = new JsonObject();
            response.addProperty("jsonrpc", "2.0");
            response.addProperty("id", id);
            JsonObject error = new JsonObject();
            error.addProperty("code", code);
            error.addProperty("message", message);
            response.add("error", error);
            writeMessage(response);
        } catch (IOException e) {
            LOG.error("[ACPBridge] Failed to send error response: " + e.getMessage());
        }
    }

    // ========================================================================
    // Utilities
    // ========================================================================

    /**
     * Build an assistant message JSON with a tool_use content block from an ACP tool_call/tool_call_update event.
     * The structure matches what ClaudeMessageHandler.handleAssistantMessage() expects.
     */
    private JsonObject buildToolCallAssistantMessage(JsonObject update) {
        String toolCallId = update.has("toolCallId") ? update.get("toolCallId").getAsString() : "unknown";
        String status = update.has("status") ? update.get("status").getAsString() : "pending";
        String title = update.has("title") ? update.get("title").getAsString() : "";

        String toolName = "";
        if (update.has("_meta") && update.getAsJsonObject("_meta").has("claudeCode")) {
            JsonObject claudeCode = update.getAsJsonObject("_meta").getAsJsonObject("claudeCode");
            if (claudeCode.has("toolName")) {
                toolName = claudeCode.get("toolName").getAsString();
            }
        }
        if (toolName.isEmpty()) {
            toolName = title;
        }

        JsonObject toolUseBlock = new JsonObject();
        toolUseBlock.addProperty("type", "tool_use");
        toolUseBlock.addProperty("id", toolCallId);
        toolUseBlock.addProperty("name", toolName);
        if (update.has("rawInput")) {
            toolUseBlock.add("input", update.get("rawInput"));
        } else {
            toolUseBlock.add("input", new JsonObject());
        }

        if (!title.isEmpty()) {
            toolUseBlock.addProperty("title", title);
        }
        toolUseBlock.addProperty("status", status);

        if (update.has("_meta")) {
            toolUseBlock.add("_meta", update.get("_meta"));
        }

        JsonArray contentArray = new JsonArray();
        contentArray.add(toolUseBlock);

        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        message.add("content", contentArray);

        JsonObject wrapper = new JsonObject();
        wrapper.addProperty("type", "assistant");
        wrapper.add("message", message);

        return wrapper;
    }

    private String formatPlan(JsonObject planUpdate) {
        if (!planUpdate.has("entries")) return "";
        JsonArray entries = planUpdate.getAsJsonArray("entries");
        StringBuilder sb = new StringBuilder();
        for (JsonElement entry : entries) {
            if (entry.isJsonObject()) {
                JsonObject e = entry.getAsJsonObject();
                String entryContent = e.has("content") ? e.get("content").getAsString() : "";
                String status = e.has("status") ? e.get("status").getAsString() : "pending";
                sb.append("- [").append(status).append("] ").append(entryContent).append("\n");
            }
        }
        return sb.toString();
    }

    /**
     * Check whether the given path is inside the session root directory.
     * Resolves symlinks and normalizes before comparison to prevent traversal attacks.
     */
    private boolean isPathAllowed(String pathStr) {
        if (pathStr == null || pathStr.isEmpty()) return false;
        Path root = sessionRoot;
        if (root == null) return false;

        try {
            Path target = Path.of(pathStr).toAbsolutePath().normalize();
            if (Files.exists(target)) {
                target = target.toRealPath();
            }
            return target.startsWith(root);
        } catch (Exception e) {
            LOG.warn("[ACPBridge] Path validation failed for: " + pathStr + " - " + e.getMessage());
            return false;
        }
    }

    private static String sanitize(String s) {
        if (s == null || s.isEmpty()) return s;
        return SENSITIVE_DATA_PATTERN.matcher(s).replaceAll("$1: [REDACTED]");
    }

    private static String truncate(String s, int maxLen) {
        if (s == null) return "";
        return s.length() <= maxLen ? s : s.substring(0, maxLen) + "...";
    }
}
