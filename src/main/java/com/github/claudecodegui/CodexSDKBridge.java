package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;

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
 * Codex SDK 桥接类
 * 负责 Java 与 Node.js Codex SDK 的交互，支持流式响应
 * 使用统一的 ai-bridge 目录（与 Claude 共享）
 */
public class CodexSDKBridge {

    private static final Logger LOG = Logger.getInstance(CodexSDKBridge.class);
    private static final String CHANNEL_SCRIPT = "channel-manager.js";

    private final Gson gson = new Gson();
    private final NodeDetector nodeDetector = new NodeDetector();
    private final ProcessManager processManager = new ProcessManager();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();
    private final BridgeDirectoryResolver directoryResolver = new BridgeDirectoryResolver();

    // Codex API 配置
    private String baseUrl = null;
    private String apiKey = null;

    /**
     * SDK 消息回调接口（与ClaudeSDKBridge保持一致）
     */
    public interface MessageCallback {
        void onMessage(String type, String content);
        void onError(String error);
        void onComplete(SDKResult result);
    }

    /**
     * SDK 响应结果（与ClaudeSDKBridge保持一致）
     */
    public static class SDKResult {
        public boolean success;
        public String error;
        public int messageCount;
        public List<Object> messages;
        public String rawOutput;
        public String finalResult;

        public SDKResult() {
            this.messages = new ArrayList<>();
        }
    }

    /**
     * 清理所有活动的子进程
     */
    public void cleanupAllProcesses() {
        processManager.cleanupAllProcesses();
    }

    /**
     * 获取当前活动进程数量
     */
    public int getActiveProcessCount() {
        return processManager.getActiveProcessCount();
    }

    /**
     * 中断 channel
     */
    public void interruptChannel(String channelId) {
        processManager.interruptChannel(channelId);
    }

    /**
     * 设置 Codex API 基础 URL
     */
    public void setBaseUrl(String baseUrl) {
        this.baseUrl = baseUrl;
    }

    /**
     * 获取 Codex API 基础 URL
     */
    public String getBaseUrl() {
        return this.baseUrl;
    }

    /**
     * 设置 Codex API 密钥
     */
    public void setApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    /**
     * 获取 Codex API 密钥
     */
    public String getApiKey() {
        return this.apiKey;
    }

    /**
     * 手动设置 Node.js 可执行文件路径
     * @param path Node.js 路径，传 null 则清除手动设置，恢复自动检测
     */
    public void setNodeExecutable(String path) {
        nodeDetector.setNodeExecutable(path);
    }

    /**
     * 获取当前使用的 Node.js 路径
     */
    public String getNodeExecutable() {
        return nodeDetector.getNodeExecutable();
    }

    /**
     * 设置 codex 二进制文件的执行权限
     */
    private void setCodexExecutablePermission(File bridgeDir) {
        try {
            // SDK 内置的 codex 二进制文件路径
            File vendorDir = new File(bridgeDir, "node_modules/@openai/codex-sdk/vendor");
            if (!vendorDir.exists()) {
                LOG.info("vendor 目录不存在，跳过权限设置");
                return;
            }

            // 遍历所有平台目录，设置 codex 可执行权限
            File[] platformDirs = vendorDir.listFiles();
            if (platformDirs == null) return;

            for (File platformDir : platformDirs) {
                if (!platformDir.isDirectory()) continue;

                File codexDir = new File(platformDir, "codex");
                File codexBinary = new File(codexDir, "codex");
                File codexExe = new File(codexDir, "codex.exe");

                if (codexBinary.exists()) {
                    boolean success = codexBinary.setExecutable(true, false);
                    LOG.info("设置执行权限: " + codexBinary.getAbsolutePath() + " -> " + success);
                }
                if (codexExe.exists()) {
                    boolean success = codexExe.setExecutable(true, false);
                    LOG.info("设置执行权限: " + codexExe.getAbsolutePath() + " -> " + success);
                }
            }
        } catch (Exception e) {
            LOG.warn("设置执行权限失败: " + e.getMessage());
        }
    }

    /**
     * 启动一个新的 Codex channel（保持接口一致）
     */
    public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        if (sessionId != null) {
            result.addProperty("sessionId", sessionId);
        }
        result.addProperty("channelId", channelId);
        result.addProperty("message", "Codex channel ready (auto-launch on first send)");
        LOG.info("Channel ready for: " + channelId);
        return result;
    }

    /**
     * 发送消息到 Codex（流式响应）
     *
     * Note: Codex uses threadId instead of sessionId
     * Note: Codex does not support attachments
     */
    public CompletableFuture<SDKResult> sendMessage(
        String channelId,
        String message,
        String threadId,  // Codex uses threadId, not sessionId
        String cwd,
        List<ClaudeSession.Attachment> attachments,  // Ignored for Codex
        String permissionMode,
        String model,
        MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            final String[] lastNodeError = {null};
            final boolean[] hadSendError = {false};

            try {
                String node = nodeDetector.findNodeExecutable();
                // 使用统一的 ai-bridge 目录
                File bridgeDir = directoryResolver.findSdkDir();

                // 确保 Codex SDK 二进制文件有执行权限
                setCodexExecutablePermission(bridgeDir);

                // 构建 stdin 输入 JSON
                // Note: Codex uses 'threadId' (not 'sessionId')
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("message", message);
                stdinInput.addProperty("threadId", threadId != null ? threadId : "");
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
                stdinInput.addProperty("model", model != null ? model : "");
                // API 配置
                stdinInput.addProperty("baseUrl", baseUrl != null ? baseUrl : "");
                stdinInput.addProperty("apiKey", apiKey != null ? apiKey : "");
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("codex");  // provider
                command.add("send");

                File processTempDir = processManager.prepareClaudeTempDir();
                Set<String> existingTempMarkers = processManager.snapshotClaudeCwdFiles(processTempDir);

                ProcessBuilder pb = new ProcessBuilder(command);

                // 设置工作目录
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

                // 配置环境变量
                Map<String, String> env = pb.environment();
                envConfigurator.configureTempDir(env, processTempDir);
                env.put("CODEX_USE_STDIN", "true");

                // 如果指定了模型，设置环境变量
                if (model != null && !model.isEmpty()) {
                    env.put("CODEX_MODEL", model);
                }

                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);

                // Configure Codex-specific env vars from ~/.codex/config.toml (env_key support)
                envConfigurator.configureCodexEnv(env);

                LOG.info("Command: " + String.join(" ", command));

                Process process = null;
                try {
                    process = pb.start();
                    processManager.registerProcess(channelId, process);

                    // 通过 stdin 写入参数
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
                            // 捕获 Node.js 错误日志
                            if (line.startsWith("[UNCAUGHT_ERROR]")
                                    || line.startsWith("[UNHANDLED_REJECTION]")
                                    || line.startsWith("[COMMAND_ERROR]")) {
                                LOG.warn("[Node.js ERROR] " + line);
                                lastNodeError[0] = line;
                            }

                            // 打印调试日志
                            if (line.contains("[DEBUG]")) {
                                LOG.debug("[Codex] " + line);
                            }

                            // 解析消息
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
                                        result.messages.add(msg);
                                        String msgType = msg.has("type") && !msg.get("type").isJsonNull()
                                                ? msg.get("type").getAsString()
                                                : "unknown";

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
                                // 避免重复添加
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
     * 检查 Codex SDK 环境是否就绪
     */
    public boolean checkEnvironment() {
        try {
            // 检查 Node.js
            String node = nodeDetector.findNodeExecutable();
            ProcessBuilder pb = new ProcessBuilder(node, "--version");
            envConfigurator.updateProcessEnvironment(pb, node);
            Process process = pb.start();

            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String version = reader.readLine();
                LOG.info("Node.js 版本: " + version);
            }

            int exitCode = process.waitFor();
            if (exitCode != 0) {
                return false;
            }

            // 检查 ai-bridge 目录
            File bridgeDir = directoryResolver.findSdkDir();
            File scriptFile = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!scriptFile.exists()) {
                LOG.error("channel-manager.js not found at: " + scriptFile.getAbsolutePath());
                return false;
            }

            LOG.info("Environment check passed");
            return true;
        } catch (Exception e) {
            LOG.error("环境检查失败: " + e.getMessage());
            return false;
        }
    }

    /**
     * 获取会话历史消息（Codex不支持此功能，返回空列表）
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        // Codex SDK 不支持获取历史消息
        LOG.info("getSessionMessages not supported by Codex SDK");
        return new ArrayList<>();
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
