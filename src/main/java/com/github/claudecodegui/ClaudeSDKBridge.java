package com.github.claudecodegui;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Claude Agent SDK 桥接类
 * 负责 Java 与 Node.js SDK 的交互，支持异步和流式响应
 */
public class ClaudeSDKBridge {

    private static final Logger LOG = Logger.getInstance(ClaudeSDKBridge.class);
    private static final String NODE_SCRIPT = "simple-query.js";
    private static final String CHANNEL_SCRIPT = "channel-manager.js";

    private final Gson gson = new Gson();
    private final NodeDetector nodeDetector = new NodeDetector();
    private final BridgeDirectoryResolver directoryResolver = new BridgeDirectoryResolver();
    private final ProcessManager processManager = new ProcessManager();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

    /**
     * SDK 消息回调接口
     */
    public interface MessageCallback {
        void onMessage(String type, String content);
        void onError(String error);
        void onComplete(SDKResult result);
    }

    /**
     * SDK 响应结果
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

    // ============================================================================
    // Node.js 检测相关方法（委托给 NodeDetector）
    // ============================================================================

    /**
     * 检测 Node.js 并返回详细结果
     */
    public NodeDetectionResult detectNodeWithDetails() {
        return nodeDetector.detectNodeWithDetails();
    }

    /**
     * 手动设置 Node.js 可执行文件路径
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

    // ============================================================================
    // Bridge 目录相关方法（委托给 BridgeDirectoryResolver）
    // ============================================================================

    /**
     * 手动设置 claude-bridge 目录路径
     */
    public void setSdkTestDir(String path) {
        directoryResolver.setSdkDir(path);
    }

    /**
     * 获取当前使用的 claude-bridge 目录
     */
    public File getSdkTestDir() {
        return directoryResolver.getSdkDir();
    }

    // ============================================================================
    // 进程管理相关方法（委托给 ProcessManager）
    // ============================================================================

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

    // ============================================================================
    // 同步查询方法
    // ============================================================================

    /**
     * 同步执行查询（阻塞方法）
     */
    public SDKResult executeQuerySync(String prompt) {
        return executeQuerySync(prompt, 60); // 默认 60 秒超时
    }

    /**
     * 同步执行查询（可指定超时）
     */
    public SDKResult executeQuerySync(String prompt, int timeoutSeconds) {
        SDKResult result = new SDKResult();
        StringBuilder output = new StringBuilder();
        StringBuilder jsonBuffer = new StringBuilder();
        boolean inJson = false;

        try {
            String node = nodeDetector.findNodeExecutable();

            // 构建 stdin 输入 JSON，避免命令行参数中特殊字符导致解析错误
            JsonObject stdinInput = new JsonObject();
            stdinInput.addProperty("prompt", prompt);
            String stdinJson = gson.toJson(stdinInput);

            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(NODE_SCRIPT);
            // 不再通过命令行参数传递 prompt

            ProcessBuilder pb = new ProcessBuilder(command);
            File workDir = directoryResolver.findSdkDir();
            pb.directory(workDir);
            pb.redirectErrorStream(true);
            envConfigurator.updateProcessEnvironment(pb, node);
            // 设置环境变量启用 stdin 输入
            pb.environment().put("CLAUDE_USE_STDIN", "true");

            Process process = pb.start();

            // 通过 stdin 写入 prompt
            try (java.io.OutputStream stdin = process.getOutputStream()) {
                stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                stdin.flush();
            } catch (Exception e) {
                // System.err.println("[ClaudeSDKBridge] Failed to write stdin: " + e.getMessage());
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
                result.error = "进程超时";
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
                    result.error = "JSON 解析失败: " + e.getMessage();
                }
            } else {
                result.success = exitCode == 0;
                if (!result.success) {
                    result.error = "进程退出码: " + exitCode;
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
     * 异步执行查询
     */
    public CompletableFuture<SDKResult> executeQueryAsync(String prompt) {
        return CompletableFuture.supplyAsync(() -> executeQuerySync(prompt));
    }

    /**
     * 流式执行查询
     */
    public CompletableFuture<SDKResult> executeQueryStream(String prompt, MessageCallback callback) {
        return CompletableFuture.supplyAsync(() -> {
            SDKResult result = new SDKResult();
            StringBuilder output = new StringBuilder();
            StringBuilder jsonBuffer = new StringBuilder();
            boolean inJson = false;

            try {
                String node = nodeDetector.findNodeExecutable();

                // 构建 stdin 输入 JSON，避免命令行参数中特殊字符导致解析错误
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("prompt", prompt);
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(NODE_SCRIPT);
                // 不再通过命令行参数传递 prompt

                File processTempDir = processManager.prepareClaudeTempDir();
                Set<String> existingTempMarkers = processManager.snapshotClaudeCwdFiles(processTempDir);

                ProcessBuilder pb = new ProcessBuilder(command);
                File workDir = directoryResolver.findSdkDir();
                pb.directory(workDir);
                pb.redirectErrorStream(true);

                Map<String, String> env = pb.environment();
                envConfigurator.configureTempDir(env, processTempDir);
                envConfigurator.updateProcessEnvironment(pb, node);
                // 设置环境变量启用 stdin 输入
                env.put("CLAUDE_USE_STDIN", "true");

                Process process = null;
                try {
                    process = pb.start();

                    // 通过 stdin 写入 prompt
                    try (java.io.OutputStream stdin = process.getOutputStream()) {
                        stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                        stdin.flush();
                    } catch (Exception e) {
                        // System.err.println("[ClaudeSDKBridge] Failed to write stdin: " + e.getMessage());
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
                                callback.onMessage("status", "完成");
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
                            result.error = "JSON 解析失败: " + e.getMessage();
                            callback.onError(result.error);
                        }
                    } else {
                        result.success = exitCode == 0;
                        if (result.success) {
                            callback.onComplete(result);
                        } else {
                            result.error = "进程退出码: " + exitCode;
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

    /**
     * 检查环境是否就绪
     */
    public boolean checkEnvironment() {
        try {
            String node = nodeDetector.findNodeExecutable();
            ProcessBuilder pb = new ProcessBuilder(node, "--version");
            envConfigurator.updateProcessEnvironment(pb, node);
            Process process = pb.start();

            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String version = reader.readLine();
                // System.out.println("Node.js 版本: " + version);
            }

            int exitCode = process.waitFor();
            return exitCode == 0;
        } catch (Exception e) {
            // System.err.println("环境检查失败: " + e.getMessage());
            return false;
        }
    }

    // ============================================================================
    // 多轮交互支持方法
    // ============================================================================

    /**
     * 启动一个新的 Claude Agent channel
     */
    public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
        JsonObject result = new JsonObject();
        result.addProperty("success", true);
        if (sessionId != null) {
            result.addProperty("sessionId", sessionId);
        }
        result.addProperty("channelId", channelId);
        result.addProperty("message", "Channel ready (auto-launch on first send)");
        // System.out.println("[Launch] Channel ready for: " + channelId + " (auto-launch on first send)");
        return result;
    }

    /**
     * 在已有 channel 中发送消息（流式响应）
     */
    public CompletableFuture<SDKResult> sendMessage(
        String channelId,
        String message,
        String sessionId,
        String cwd,
        List<ClaudeSession.Attachment> attachments,
        MessageCallback callback
    ) {
        return sendMessage(channelId, message, sessionId, cwd, attachments, null, null, null, callback);
    }

    /**
     * 在已有 channel 中发送消息（流式响应，支持权限模式和模型选择）
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
        MessageCallback callback
    ) {
        return CompletableFuture.supplyAsync(() -> {
            // long sendStartTime = System.currentTimeMillis();
            // LOG.info("[PERF][" + sendStartTime + "] ClaudeSDKBridge.sendMessage() 开始执行");
            // LOG.info("[PERF] 消息内容: " + (message != null ? message.substring(0, Math.min(50, message.length())) + "..." : "null"));

            SDKResult result = new SDKResult();
            StringBuilder assistantContent = new StringBuilder();
            final boolean[] hadSendError = {false};
            // 记录 Node.js 进程中最后一条错误日志，方便在 "Process exited with code" 时附加具体原因
            final String[] lastNodeError = {null};

            // // [PERF] 记录关键时间点
            // final long[] perfTimestamps = new long[10];
            // // 0: 开始序列化附件
            // // 1: 附件序列化完成
            // // 2: 进程启动前
            // // 3: 进程启动后
            // // 4: stdin 写入完成
            // // 5: 第一行输出
            // // 6: 第一个 content_delta
            // // 7: message_end
            // // 8: 进程结束

            try {
                // 序列化附件
                // perfTimestamps[0] = System.currentTimeMillis();
                String attachmentsJson = null;
                boolean hasAttachments = attachments != null && !attachments.isEmpty();
                if (hasAttachments) {
                    try {
                        List<Map<String, String>> serializable = new ArrayList<>();
                        for (ClaudeSession.Attachment att : attachments) {
                            if (att == null) continue;
                            Map<String, String> obj = new java.util.HashMap<>();
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
                // perfTimestamps[1] = System.currentTimeMillis();
                // LOG.info("[PERF][" + perfTimestamps[1] + "] 附件序列化完成，耗时: " + (perfTimestamps[1] - perfTimestamps[0]) + "ms");

                String node = nodeDetector.findNodeExecutable();
                File workDir = directoryResolver.findSdkDir();

                // 诊断：打印关键环境信息
                // System.out.println("[ClaudeSDKBridge] 环境诊断:");
                // System.out.println("[ClaudeSDKBridge]   Node.js 路径: " + node);
                // System.out.println("[ClaudeSDKBridge]   SDK 目录: " + workDir.getAbsolutePath());
                // System.out.println("[ClaudeSDKBridge]   HOME: " + System.getProperty("user.home"));
                // String settingsPath = System.getProperty("user.home") + "/.claude/settings.json";
                // System.out.println("[ClaudeSDKBridge]   settings.json: " + settingsPath + " (存在: " + new File(settingsPath).exists() + ")");

                // 构建 stdin 输入 JSON，避免命令行参数中特殊字符导致解析错误
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("message", message);
                stdinInput.addProperty("sessionId", sessionId != null ? sessionId : "");
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                stdinInput.addProperty("permissionMode", permissionMode != null ? permissionMode : "");
                stdinInput.addProperty("model", model != null ? model : "");
                if (hasAttachments && attachmentsJson != null) {
                    stdinInput.add("attachments", gson.fromJson(attachmentsJson, JsonArray.class));
                }
                // 添加打开的文件信息（包含激活文件和其他文件）
                if (openedFiles != null && openedFiles.size() > 0) {
                    stdinInput.add("openedFiles", openedFiles);
                    // System.out.println("[ClaudeSDKBridge] Adding opened files info to context");
                }
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                command.add(new File(workDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");  // provider
                command.add(hasAttachments ? "sendWithAttachments" : "send");
                // 不再传递 message 等参数到命令行，改用 stdin

                File processTempDir = processManager.prepareClaudeTempDir();
                Set<String> existingTempMarkers = processManager.snapshotClaudeCwdFiles(processTempDir);

                ProcessBuilder pb = new ProcessBuilder(command);

                // 设置工作目录
                if (cwd != null && !cwd.isEmpty() && !"undefined".equals(cwd) && !"null".equals(cwd)) {
                    File userWorkDir = new File(cwd);
                    if (userWorkDir.exists() && userWorkDir.isDirectory()) {
                        pb.directory(userWorkDir);
                    } else {
                        pb.directory(directoryResolver.findSdkDir());
                    }
                } else {
                    pb.directory(directoryResolver.findSdkDir());
                }

                Map<String, String> env = pb.environment();
                envConfigurator.configureProjectPath(env, cwd);
                envConfigurator.configureTempDir(env, processTempDir);
                // 始终使用 stdin 传递参数
                env.put("CLAUDE_USE_STDIN", "true");

                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);

                Process process = null;
                try {
                    // perfTimestamps[2] = System.currentTimeMillis();
                    // LOG.info("[PERF][" + perfTimestamps[2] + "] 准备启动 Node.js 进程，准备耗时: " + (perfTimestamps[2] - perfTimestamps[1]) + "ms");

                    process = pb.start();

                    // perfTimestamps[3] = System.currentTimeMillis();
                    // LOG.info("[PERF][" + perfTimestamps[3] + "] Node.js 进程已启动，PID: " + process.pid() + "，启动耗时: " + (perfTimestamps[3] - perfTimestamps[2]) + "ms");

                    processManager.registerProcess(channelId, process);

                    // 通过 stdin 写入所有参数（包括消息和附件）
                    try (java.io.OutputStream stdin = process.getOutputStream()) {
                        stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                        stdin.flush();
                        // perfTimestamps[4] = System.currentTimeMillis();
                        // LOG.info("[PERF][" + perfTimestamps[4] + "] stdin 写入完成，数据长度: " + stdinJson.length() + " 字节，写入耗时: " + (perfTimestamps[4] - perfTimestamps[3]) + "ms");
                    } catch (Exception e) {
                        // LOG.warn("[PERF] stdin 写入失败: " + e.getMessage());
                    }

                    try {
                        // LOG.info("[PERF] 开始读取 Node.js 输出...");
                        long lastOutputTime = System.currentTimeMillis();
                        int lineCount = 0;
                        // final boolean[] firstLineReceived = {false};
                        // final boolean[] firstContentReceived = {false};

                        try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {

                            String line;
                            while ((line = reader.readLine()) != null) {
                                lineCount++;
                                long now = System.currentTimeMillis();

                                // // [PERF] 记录第一行输出时间
                                // if (!firstLineReceived[0]) {
                                //     firstLineReceived[0] = true;
                                //     perfTimestamps[5] = now;
                                //     LOG.info("[PERF][" + now + "] >>> 收到第一行输出 <<<，距 stdin 写入: " + (now - perfTimestamps[4]) + "ms，距开始: " + (now - sendStartTime) + "ms");
                                //     LOG.info("[PERF] 第一行内容: " + line.substring(0, Math.min(100, line.length())));
                                // }

                                // 每 30 秒打印一次状态，或者收到第一行输出时
                                // if (lineCount == 1 || now - lastOutputTime > 30000) {
                                //     System.out.println("[ClaudeSDKBridge] 已读取 " + lineCount + " 行输出，耗时 " + (now - sendStartTime) / 1000 + " 秒");
                                //     lastOutputTime = now;
                                // }
                                // 先捕获并输出 Node.js 侧的错误日志，便于在 IDE 日志中直接看到具体原因
                                if (line.startsWith("[UNCAUGHT_ERROR]")
                                        || line.startsWith("[UNHANDLED_REJECTION]")
                                        || line.startsWith("[COMMAND_ERROR]")) {
                                    LOG.warn("[Node.js ERROR] " + line);
                                    lastNodeError[0] = line;
                                }

                                // 打印权限/调试日志
                                // if (line.contains("[PERM_DEBUG]") || line.contains("[DEBUG]")) {
                                //     System.out.println("[Node.js] " + line);
                                // }
                                if (line.startsWith("[MESSAGE]")) {
                                    String jsonStr = line.substring("[MESSAGE]".length()).trim();
                                    try {
                                        JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                                        result.messages.add(msg);
                                        String type = msg.has("type") ? msg.get("type").getAsString() : "unknown";
                                        callback.onMessage(type, jsonStr);
                                    } catch (Exception e) {
                                        // JSON 解析失败，跳过
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
                                        // 如果不是 JSON，则直接使用原始字符串
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
                                    String delta = line.substring("[CONTENT_DELTA]".length()).trim();
                                    assistantContent.append(delta);

                                    // // [PERF] 记录第一个 content_delta
                                    // if (!firstContentReceived[0]) {
                                    //     firstContentReceived[0] = true;
                                    //     perfTimestamps[6] = now;
                                    //     LOG.info("[PERF][" + now + "] >>> 收到第一个 content_delta <<<，距开始: " + (now - sendStartTime) + "ms");
                                    // }

                                    callback.onMessage("content_delta", delta);
                                } else if (line.startsWith("[THINKING]")) {
                                    String thinkingContent = line.substring("[THINKING]".length()).trim();
                                    callback.onMessage("thinking", thinkingContent);
                                } else if (line.startsWith("[SESSION_ID]")) {
                                    String capturedSessionId = line.substring("[SESSION_ID]".length()).trim();
                                    callback.onMessage("session_id", capturedSessionId);
                                } else if (line.startsWith("[SLASH_COMMANDS]")) {
                                    String slashCommandsJson = line.substring("[SLASH_COMMANDS]".length()).trim();
                                    callback.onMessage("slash_commands", slashCommandsJson);
                                } else if (line.startsWith("[TOOL_RESULT]")) {
                                    // 实时输出工具调用结果，前端可以立即更新工具状态
                                    String toolResultJson = line.substring("[TOOL_RESULT]".length()).trim();
                                    callback.onMessage("tool_result", toolResultJson);
                                } else if (line.startsWith("[MESSAGE_START]")) {
                                    callback.onMessage("message_start", "");
                                } else if (line.startsWith("[MESSAGE_END]")) {
                                    // perfTimestamps[7] = now;
                                    // LOG.info("[PERF][" + now + "] >>> 收到 MESSAGE_END <<<，距开始: " + (now - sendStartTime) + "ms");
                                    // 立即通知前端消息结束，不等待进程退出
                                    callback.onMessage("message_end", "");
                                    // 标记响应完成时间，用于计算用户体验时间
                                    // LOG.info("[PERF][" + now + "] 用户可见响应完成，距开始: " + (now - sendStartTime) + "ms");
                                }
                            }
                        }

                        // System.out.println("[ClaudeSDKBridge] Node.js 输出读取完毕，共 " + lineCount + " 行");
                        // System.out.println("[ClaudeSDKBridge] 等待进程结束...");
	                        // 设置60秒超时等待进程结束的逻辑存在严重问题，先恢复为无限等待进程结束
	                        // boolean finished = process.waitFor(60, TimeUnit.SECONDS);
	                        // if (!finished) {
	                        //     System.out.println("[ClaudeSDKBridge] Process timeout after 60 seconds, force killing...");
	                        //     process.destroyForcibly();
	                        //     result.success = false;
	                        //     result.error = "响应超时（60s），已自动终止本次请求，请检查您的配置，或者在终端运行claude 测试是否可以正常使用";
	                        //     callback.onError("响应超时（60s），已自动终止本次请求，请检查您的配置，或者在终端运行claude 测试是否可以正常使用");
	                        //     return result;
	                        // }
	                        process.waitFor();

                        // perfTimestamps[8] = System.currentTimeMillis();
                        // long totalTime = perfTimestamps[8] - sendStartTime;
                        // LOG.info("[PERF][" + perfTimestamps[8] + "] ====== 消息发送完成 ======");
                        // LOG.info("[PERF] 总耗时: " + totalTime + "ms (" + (totalTime / 1000) + "秒)");
                        // LOG.info("[PERF] 耗时分解:");
                        // LOG.info("[PERF]   - 附件序列化: " + (perfTimestamps[1] - perfTimestamps[0]) + "ms");
                        // LOG.info("[PERF]   - 进程准备: " + (perfTimestamps[2] - perfTimestamps[1]) + "ms");
                        // LOG.info("[PERF]   - 进程启动: " + (perfTimestamps[3] - perfTimestamps[2]) + "ms");
                        // LOG.info("[PERF]   - stdin 写入: " + (perfTimestamps[4] - perfTimestamps[3]) + "ms");
                        // if (perfTimestamps[5] > 0) {
                        //     LOG.info("[PERF]   - 等待第一行输出: " + (perfTimestamps[5] - perfTimestamps[4]) + "ms");
                        // }
                        // if (perfTimestamps[6] > 0) {
                        //     LOG.info("[PERF]   - 首个 content_delta: " + (perfTimestamps[6] - sendStartTime) + "ms (距开始)");
                        // }
                        // if (perfTimestamps[7] > 0) {
                        //     LOG.info("[PERF]   - MESSAGE_END: " + (perfTimestamps[7] - sendStartTime) + "ms (距开始)");
                        // }
                        // LOG.info("[PERF]   - 进程结束: " + (perfTimestamps[8] - (perfTimestamps[7] > 0 ? perfTimestamps[7] : perfTimestamps[4])) + "ms");

                        int exitCode = process.exitValue();
                        boolean wasInterrupted = processManager.wasInterrupted(channelId);

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
                                
                                // 针对 exitCode 1 (通常是环境配置问题) 提供更友好的提示
                                if (exitCode == 1 && (lastNodeError[0] == null || lastNodeError[0].isEmpty())) {
                                    String friendlyMsg = "Node环境配置错误，请前往设置页面检查 Node 路径配置。";
                                    // 将友好提示放在最前面
                                    errorMsg = friendlyMsg + " (" + errorMsg + ")";
                                }

                                // 如果 Node.js 侧有明确的错误日志，将其附加到错误消息中，提升可读性
                                if (lastNodeError[0] != null && !lastNodeError[0].isEmpty()) {
                                    errorMsg = errorMsg + " | Last node error: " + lastNodeError[0];
                                }
                                result.success = false;
                                result.error = errorMsg;
                                callback.onError(errorMsg);
                            }
                        }

                        return result;
                    } finally {
                        processManager.unregisterProcess(channelId, process);
                    }
                } finally {
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
     * 获取会话历史消息
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            // System.out.println("[ClaudeSDKBridge] getSessionMessages: sessionId=" + sessionId + ", cwd=" + cwd);
            String node = nodeDetector.findNodeExecutable();

            List<String> command = new ArrayList<>();
            command.add(node);
            command.add(CHANNEL_SCRIPT);
            command.add("claude");  // provider
            command.add("getSession");
            command.add(sessionId);
            command.add(cwd != null ? cwd : "");

            // System.out.println("[ClaudeSDKBridge] Command: " + String.join(" ", command));

            ProcessBuilder pb = new ProcessBuilder(command);
            File workDir = directoryResolver.findSdkDir();
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
            // System.out.println("[ClaudeSDKBridge] Node.js output: " + outputStr);

            int jsonStart = outputStr.indexOf("{");
            if (jsonStart != -1) {
                String jsonStr = outputStr.substring(jsonStart);
                // System.out.println("[ClaudeSDKBridge] Extracting JSON from position " + jsonStart);
                JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);

                if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                    List<JsonObject> messages = new ArrayList<>();
                    if (jsonResult.has("messages")) {
                        JsonArray messagesArray = jsonResult.getAsJsonArray("messages");
                        // System.out.println("[ClaudeSDKBridge] Found " + messagesArray.size() + " messages in response");
                        for (var msg : messagesArray) {
                            messages.add(msg.getAsJsonObject());
                        }
                    }
                    return messages;
                } else {
                    String errorMsg = (jsonResult.has("error") && !jsonResult.get("error").isJsonNull())
                        ? jsonResult.get("error").getAsString()
                        : "Unknown error";
                    // System.err.println("[ClaudeSDKBridge] Get session failed: " + errorMsg);
                    throw new RuntimeException("Get session failed: " + errorMsg);
                }
            }

            // System.err.println("[ClaudeSDKBridge] No JSON found in output");
            return new ArrayList<>();

        } catch (Exception e) {
            // System.err.println("[ClaudeSDKBridge] Exception: " + e.getMessage());
            // e.printStackTrace();
            throw new RuntimeException("Failed to get session messages: " + e.getMessage(), e);
        }
    }

    /**
     * 获取斜杠命令列表.
     * 在插件启动时调用，获取完整的命令列表（包含 name 和 description）
     *
     * 关键修复：Node.js 进程输出 [SLASH_COMMANDS] 后不会自动退出，
     * 因此一旦检测到数据就立即返回，不再等待进程结束。
     */
    public CompletableFuture<List<JsonObject>> getSlashCommands(String cwd) {
        return CompletableFuture.supplyAsync(() -> {
            Process process = null;
            long startTime = System.currentTimeMillis();
            LOG.info("[SlashCommands] Starting getSlashCommands, cwd=" + cwd);

            try {
                String node = nodeDetector.findNodeExecutable();

                // 构建 stdin 输入 JSON
                JsonObject stdinInput = new JsonObject();
                stdinInput.addProperty("cwd", cwd != null ? cwd : "");
                String stdinJson = gson.toJson(stdinInput);

                List<String> command = new ArrayList<>();
                command.add(node);
                File bridgeDir = directoryResolver.findSdkDir();
                command.add(new File(bridgeDir, CHANNEL_SCRIPT).getAbsolutePath());
                command.add("claude");  // provider
                command.add("getSlashCommands");

                ProcessBuilder pb = new ProcessBuilder(command);
                File workDir = bridgeDir;
                pb.directory(workDir);
                pb.redirectErrorStream(true);
                envConfigurator.updateProcessEnvironment(pb, node);
                pb.environment().put("CLAUDE_USE_STDIN", "true");

                process = pb.start();
                final Process finalProcess = process;

                // 通过 stdin 写入参数
                try (java.io.OutputStream stdin = process.getOutputStream()) {
                    stdin.write(stdinJson.getBytes(StandardCharsets.UTF_8));
                    stdin.flush();
                    LOG.debug("[SlashCommands] Wrote stdin: " + stdinJson);
                } catch (Exception e) {
                    LOG.warn("[SlashCommands] Failed to write stdin: " + e.getMessage());
                }

                // 使用标志变量，一旦找到数据就立即退出
                final boolean[] found = {false};
                final String[] slashCommandsJson = {null};
                final StringBuilder output = new StringBuilder();

                Thread readerThread = new Thread(() -> {
                    try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(finalProcess.getInputStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while (!found[0] && (line = reader.readLine()) != null) {
                            output.append(line).append("\n");
                            LOG.debug("[SlashCommands] Read line: " + line.substring(0, Math.min(100, line.length())));

                            if (line.startsWith("[SLASH_COMMANDS]")) {
                                slashCommandsJson[0] = line.substring("[SLASH_COMMANDS]".length()).trim();
                                found[0] = true;  // 设置标志，立即停止读取
                                LOG.info("[SlashCommands] Found SLASH_COMMANDS marker, data length=" + slashCommandsJson[0].length());
                                break;  // 立即退出循环
                            }
                        }
                    } catch (Exception e) {
                        LOG.debug("[SlashCommands] Reader thread exception: " + e.getMessage());
                    }
                });
                readerThread.start();

                // 轮询等待，最多 20 秒
                long deadline = System.currentTimeMillis() + 20000;
                while (!found[0] && System.currentTimeMillis() < deadline) {
                    Thread.sleep(100);  // 每 100ms 检查一次
                }

                long elapsed = System.currentTimeMillis() - startTime;

                // 无论是否找到数据，都立即终止进程
                if (process.isAlive()) {
                    process.destroyForcibly();
                    LOG.debug("[SlashCommands] Process forcibly destroyed after " + elapsed + "ms");
                }

                // 解析结果
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
                } else {
                    LOG.warn("[SlashCommands] No commands found after " + elapsed + "ms, found=" + found[0]);
                }

                // 回退到解析最终 JSON 输出
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
                                LOG.info("[SlashCommands] Fallback: parsed " + commands.size() + " commands from JSON");
                            }
                        }
                    } catch (Exception e) {
                        LOG.debug("[SlashCommands] Fallback JSON parse failed: " + e.getMessage());
                    }
                }

                return commands;

            } catch (Exception e) {
                long elapsed = System.currentTimeMillis() - startTime;
                LOG.error("[SlashCommands] Exception after " + elapsed + "ms: " + e.getMessage());
                return new ArrayList<>();
            } finally {
                if (process != null && process.isAlive()) {
                    process.destroyForcibly();
                }
            }
        });
    }

    // ============================================================================
    // 工具方法
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
