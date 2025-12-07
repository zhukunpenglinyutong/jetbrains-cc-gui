package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonObject;

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
     * 设置 codex 二进制文件的执行权限
     */
    private void setCodexExecutablePermission(File bridgeDir) {
        try {
            // SDK 内置的 codex 二进制文件路径
            File vendorDir = new File(bridgeDir, "node_modules/@openai/codex-sdk/vendor");
            if (!vendorDir.exists()) {
                System.out.println("[CodexSDKBridge] vendor 目录不存在，跳过权限设置");
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
                    System.out.println("[CodexSDKBridge] 设置执行权限: " + codexBinary.getAbsolutePath() + " -> " + success);
                }
                if (codexExe.exists()) {
                    boolean success = codexExe.setExecutable(true, false);
                    System.out.println("[CodexSDKBridge] 设置执行权限: " + codexExe.getAbsolutePath() + " -> " + success);
                }
            }
        } catch (Exception e) {
            System.err.println("[CodexSDKBridge] 设置执行权限失败: " + e.getMessage());
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
        System.out.println("[CodexSDKBridge] Channel ready for: " + channelId);
        return result;
    }

    /**
     * 发送消息到 Codex（流式响应）
     */
    public CompletableFuture<SDKResult> sendMessage(
        String channelId,
        String message,
        String sessionId,
        String cwd,
        List<ClaudeSession.Attachment> attachments,
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
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("message", message);
                stdinInput.addProperty("threadId", sessionId != null ? sessionId : "");
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                stdinInput.addProperty("model", model != null ? model : "");
                // 添加 API 配置
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

                System.out.println("[CodexSDKBridge] Command: " + String.join(" ", command));

                Process process = null;
                try {
                    process = pb.start();
                    processManager.registerProcess(channelId, process);

                    // 通过 stdin 写入参数
                    try (java.io.OutputStream stdin = process.getOutputStream()) {
                        stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                        stdin.flush();
                    } catch (Exception e) {
                        System.err.println("[CodexSDKBridge] Failed to write stdin: " + e.getMessage());
                    }

                    try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                        String line;
                        while ((line = reader.readLine()) != null) {
                            // 捕获 Node.js 错误日志
                            if (line.startsWith("[UNCAUGHT_ERROR]")
                                    || line.startsWith("[UNHANDLED_REJECTION]")
                                    || line.startsWith("[COMMAND_ERROR]")) {
                                System.err.println("[Node.js ERROR] " + line);
                                lastNodeError[0] = line;
                            }

                            // 打印调试日志
                            if (line.contains("[DEBUG]")) {
                                System.out.println("[Codex] " + line);
                            }

                            // 解析消息
                            if (line.startsWith("[MESSAGE_START]")) {
                                callback.onMessage("message_start", "");
                            } else if (line.startsWith("[MESSAGE_END]")) {
                                callback.onMessage("message_end", "");
                            } else if (line.startsWith("[THREAD_ID]")) {
                                String threadId = line.substring("[THREAD_ID]".length()).trim();
                                callback.onMessage("session_id", threadId);
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
                System.out.println("[CodexSDKBridge] Node.js 版本: " + version);
            }

            int exitCode = process.waitFor();
            if (exitCode != 0) {
                return false;
            }

            // 检查 ai-bridge 目录
            File bridgeDir = directoryResolver.findSdkDir();
            File scriptFile = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!scriptFile.exists()) {
                System.err.println("[CodexSDKBridge] channel-manager.js not found at: " + scriptFile.getAbsolutePath());
                return false;
            }

            System.out.println("[CodexSDKBridge] Environment check passed");
            return true;
        } catch (Exception e) {
            System.err.println("[CodexSDKBridge] 环境检查失败: " + e.getMessage());
            return false;
        }
    }

    /**
     * 获取会话历史消息（Codex不支持此功能，返回空列表）
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        // Codex SDK 不支持获取历史消息
        System.out.println("[CodexSDKBridge] getSessionMessages not supported by Codex SDK");
        return new ArrayList<>();
    }
}
