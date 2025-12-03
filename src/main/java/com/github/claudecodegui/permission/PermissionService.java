package com.github.claudecodegui.permission;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

/**
 * 权限服务 - 处理Node.js的权限请求
 */
public class PermissionService {

    private static final String LOG_TAG = "[PermissionService]";

    private static PermissionService instance;
    private final Project project;
    private final Path permissionDir;
    private final Gson gson = new Gson();
    private WatchService watchService;
    private Thread watchThread;
    private boolean running = false;

    // 记忆用户选择（工具+参数级别）
    private final Map<String, Integer> permissionMemory = new ConcurrentHashMap<>();
    // 工具级别权限记忆（仅工具名 -> 是否总是允许）
    private final Map<String, Boolean> toolOnlyPermissionMemory = new ConcurrentHashMap<>();
    private volatile PermissionDecisionListener decisionListener;

    // 调试日志辅助方法
    private void debugLog(String tag, String message) {
        String timestamp = java.time.LocalDateTime.now().toString();
        System.out.println(String.format("[%s]%s[%s] %s", timestamp, LOG_TAG, tag, message));
    }

    private void debugLog(String tag, String message, Object data) {
        String timestamp = java.time.LocalDateTime.now().toString();
        System.out.println(String.format("[%s]%s[%s] %s | Data: %s", timestamp, LOG_TAG, tag, message, gson.toJson(data)));
    }

    public enum PermissionResponse {
        ALLOW(1, "允许"),
        ALLOW_ALWAYS(2, "允许且不再询问"),
        DENY(3, "拒绝");

        private final int value;
        private final String description;

        PermissionResponse(int value, String description) {
            this.value = value;
            this.description = description;
        }

        public int getValue() {
            return value;
        }

        public String getDescription() {
            return description;
        }

        public static PermissionResponse fromValue(int value) {
            for (PermissionResponse response : values()) {
                if (response.value == value) {
                    return response;
                }
            }
            return null;
        }

        public boolean isAllow() {
            return this == ALLOW || this == ALLOW_ALWAYS;
        }
    }

    public static class PermissionDecision {
        private final String toolName;
        private final JsonObject inputs;
        private final PermissionResponse response;

        public PermissionDecision(String toolName, JsonObject inputs, PermissionResponse response) {
            this.toolName = toolName;
            this.inputs = inputs;
            this.response = response;
        }

        public String getToolName() {
            return toolName;
        }

        public JsonObject getInputs() {
            return inputs;
        }

        public PermissionResponse getResponse() {
            return response;
        }

        public boolean isAllowed() {
            return response != null && response.isAllow();
        }
    }

    public interface PermissionDecisionListener {
        void onDecision(PermissionDecision decision);
    }

    /**
     * 权限对话框显示器接口 - 用于显示前端弹窗
     */
    public interface PermissionDialogShower {
        /**
         * 显示权限对话框并返回用户决策
         * @param toolName 工具名称
         * @param inputs 输入参数
         * @return CompletableFuture<Integer> 返回 PermissionResponse 的值
         */
        CompletableFuture<Integer> showPermissionDialog(String toolName, JsonObject inputs);
    }

    private volatile PermissionDialogShower dialogShower;

    private PermissionService(Project project) {
        this.project = project;
        // 使用临时目录进行通信
        this.permissionDir = Paths.get(System.getProperty("java.io.tmpdir"), "claude-permission");
        debugLog("INIT", "Permission dir: " + permissionDir);
        debugLog("INIT", "java.io.tmpdir: " + System.getProperty("java.io.tmpdir"));
        try {
            Files.createDirectories(permissionDir);
            debugLog("INIT", "Permission directory created/verified: " + permissionDir);
        } catch (IOException e) {
            debugLog("INIT_ERROR", "Failed to create permission dir: " + e.getMessage());
            e.printStackTrace();
        }
    }

    public static synchronized PermissionService getInstance(Project project) {
        if (instance == null) {
            instance = new PermissionService(project);
        }
        return instance;
    }

    public void setDecisionListener(PermissionDecisionListener listener) {
        this.decisionListener = listener;
        debugLog("CONFIG", "Decision listener set: " + (listener != null));
    }

    /**
     * 设置权限对话框显示器（用于显示前端弹窗）
     */
    public void setDialogShower(PermissionDialogShower shower) {
        this.dialogShower = shower;
        debugLog("CONFIG", "Dialog shower set: " + (shower != null));
    }

    /**
     * 启动权限服务
     */
    public void start() {
        if (running) {
            debugLog("START", "Already running, skipping start");
            return;
        }

        running = true;

        watchThread = new Thread(this::watchLoop, "PermissionWatcher");
        watchThread.setDaemon(true);
        watchThread.start();

        debugLog("START", "Started polling on: " + permissionDir);
    }

    /**
     * 监控文件变化
     * 改为轮询模式，以提高在 macOS /tmp 目录下的可靠性
     */
    private void watchLoop() {
        debugLog("WATCH_LOOP", "Starting polling loop on: " + permissionDir);
        int pollCount = 0;
        while (running) {
            try {
                pollCount++;
                File dir = permissionDir.toFile();
                if (!dir.exists()) {
                    dir.mkdirs();
                }

                File[] files = dir.listFiles((d, name) -> name.startsWith("request-") && name.endsWith(".json"));

                // 每20次轮询（约10秒）输出一次状态
                // 降低日志频率：每100次轮询（约50秒）记录一次状态
                if (pollCount % 100 == 0) {
                    int fileCount = files != null ? files.length : 0;
                    debugLog("POLL_STATUS", String.format("Poll #%d, found %d request files", pollCount, fileCount));
                }

                if (files != null && files.length > 0) {
                    for (File file : files) {
                        // 简单防重：检查文件是否还存在（可能被其他线程处理了）
                        if (file.exists()) {
                            debugLog("REQUEST_FOUND", "Found request file: " + file.getName());
                            handlePermissionRequest(file.toPath());
                        }
                    }
                }

                // 轮询间隔 500ms
                Thread.sleep(500);
            } catch (Exception e) {
                debugLog("POLL_ERROR", "Error in poll loop: " + e.getMessage());
                e.printStackTrace();
                try {
                    Thread.sleep(1000); // 出错后稍作等待
                } catch (InterruptedException ex) {
                    break;
                }
            }
        }
        debugLog("WATCH_LOOP", "Polling loop ended");
    }

    // 记录正在处理的请求文件，避免重复处理
    private final Set<String> processingRequests = ConcurrentHashMap.newKeySet();

    /**
     * 处理权限请求
     */
    private void handlePermissionRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();
        long startTime = System.currentTimeMillis();
        debugLog("HANDLE_REQUEST", "Processing request file: " + fileName);

        // 检查是否正在处理该请求
        if (!processingRequests.add(fileName)) {
            debugLog("SKIP_DUPLICATE", "Request already being processed, skipping: " + fileName);
            return;
        }

        try {
            Thread.sleep(100); // 等待文件写入完成

            String content = Files.readString(requestFile);
            debugLog("FILE_READ", "Read request content: " + content.substring(0, Math.min(200, content.length())) + "...");

            JsonObject request = gson.fromJson(content, JsonObject.class);

            String requestId = request.get("requestId").getAsString();
            String toolName = request.get("toolName").getAsString();
            JsonObject inputs = request.get("inputs").getAsJsonObject();

            debugLog("REQUEST_PARSED", String.format("requestId=%s, toolName=%s", requestId, toolName));

            // 首先检查工具级别的权限记忆（总是允许）
            if (toolOnlyPermissionMemory.containsKey(toolName)) {
                boolean allow = toolOnlyPermissionMemory.get(toolName);
                debugLog("MEMORY_HIT", "Using tool-level memory for " + toolName + " -> " + (allow ? "ALLOW" : "DENY"));
                writeResponse(requestId, allow);
                notifyDecision(toolName, inputs, allow ? PermissionResponse.ALLOW_ALWAYS : PermissionResponse.DENY);
                Files.deleteIfExists(requestFile);
                processingRequests.remove(fileName);
                return;
            }

            // 生成内存键（工具+参数）
            String memoryKey = toolName + ":" + inputs.toString().hashCode();
            debugLog("MEMORY_KEY", "Generated memory key: " + memoryKey);

            // 检查是否有记忆的选择（工具+参数级别）
            if (permissionMemory.containsKey(memoryKey)) {
                int memorized = permissionMemory.get(memoryKey);
                PermissionResponse rememberedResponse = PermissionResponse.fromValue(memorized);
                boolean allow = rememberedResponse != PermissionResponse.DENY;
                debugLog("PARAM_MEMORY_HIT", "Using param-level memory: " + memoryKey + " -> " + (allow ? "ALLOW" : "DENY"));
                writeResponse(requestId, allow);
                notifyDecision(toolName, inputs, rememberedResponse);
                Files.deleteIfExists(requestFile);
                processingRequests.remove(fileName);
                return;
            }

            // 如果有前端弹窗显示器，使用异步方式
            if (dialogShower != null) {
                debugLog("DIALOG_SHOWER", "Using frontend dialog for: " + toolName);

                // 立即删除请求文件，避免重复处理
                try {
                    Files.deleteIfExists(requestFile);
                    debugLog("FILE_DELETE", "Deleted request file: " + fileName);
                } catch (Exception e) {
                    debugLog("FILE_DELETE_ERROR", "Failed to delete request file: " + e.getMessage());
                }

                final String memKey = memoryKey;
                final String tool = toolName;
                final long dialogStartTime = System.currentTimeMillis();

                // 异步调用前端弹窗
                debugLog("DIALOG_SHOW", "Calling dialogShower.showPermissionDialog for: " + toolName);
                CompletableFuture<Integer> future = dialogShower.showPermissionDialog(toolName, inputs);

                // 异步处理结果
                future.thenAccept(response -> {
                    long dialogElapsed = System.currentTimeMillis() - dialogStartTime;
                    debugLog("DIALOG_RESPONSE", String.format("Got response %d after %dms for %s", response, dialogElapsed, tool));
                    try {
                        PermissionResponse decision = PermissionResponse.fromValue(response);
                        if (decision == null) {
                            debugLog("RESPONSE_NULL", "Response value " + response + " mapped to null, defaulting to DENY");
                            decision = PermissionResponse.DENY;
                        }

                        boolean allow;
                        switch (decision) {
                            case ALLOW:
                                allow = true;
                                debugLog("DECISION", "ALLOW (single) for " + tool);
                                break;
                            case ALLOW_ALWAYS:
                                allow = true;
                                // 保存到工具级别权限记忆（按工具类型，不是按参数）
                                toolOnlyPermissionMemory.put(tool, true);
                                debugLog("DECISION", "ALLOW_ALWAYS for " + tool + ", saved to memory");
                                break;
                            case DENY:
                            default:
                                allow = false;
                                debugLog("DECISION", "DENY for " + tool);
                                break;
                        }

                        notifyDecision(toolName, inputs, decision);
                        debugLog("WRITE_RESPONSE", String.format("Writing response for %s: allow=%s", requestId, allow));
                        writeResponse(requestId, allow);

                        debugLog("DIALOG_COMPLETE", "Frontend dialog processing complete: allow=" + allow);
                    } catch (Exception e) {
                        debugLog("DIALOG_ERROR", "Error processing dialog result: " + e.getMessage());
                        e.printStackTrace();
                    } finally {
                        processingRequests.remove(fileName);
                    }
                }).exceptionally(ex -> {
                    debugLog("DIALOG_EXCEPTION", "Frontend dialog exception: " + ex.getMessage());
                    try {
                        writeResponse(requestId, false);
                    } catch (Exception e) {
                        e.printStackTrace();
                    }
                    notifyDecision(toolName, inputs, PermissionResponse.DENY);
                    processingRequests.remove(fileName);
                    return null;
                });

                // 异步处理，直接返回，不阻塞
                return;
            }

            // 降级方案：使用系统弹窗（同步阻塞）
            debugLog("FALLBACK_DIALOG", "Using system dialog (JOptionPane) for: " + toolName);
            CompletableFuture<Integer> future = new CompletableFuture<>();
            SwingUtilities.invokeLater(() -> {
                int response = showSystemPermissionDialog(toolName, inputs);
                future.complete(response);
            });

            debugLog("DIALOG_WAIT", "Waiting for system dialog response (timeout: 30s)");
            int response = future.get(30, TimeUnit.SECONDS);
            debugLog("DIALOG_RESPONSE", "Got system dialog response: " + response);

            PermissionResponse decision = PermissionResponse.fromValue(response);
            if (decision == null) {
                debugLog("RESPONSE_NULL", "Response mapped to null, defaulting to DENY");
                decision = PermissionResponse.DENY;
            }

            boolean allow;
            switch (decision) {
                case ALLOW:
                    allow = true;
                    break;
                case ALLOW_ALWAYS:
                    allow = true;
                    permissionMemory.put(memoryKey, PermissionResponse.ALLOW_ALWAYS.value);
                    debugLog("MEMORY_SAVE", "Saved param-level memory: " + memoryKey);
                    break;
                case DENY:
                default:
                    allow = false;
                    break;
            }

            notifyDecision(toolName, inputs, decision);

            // 写入响应
            debugLog("WRITE_RESPONSE", String.format("Writing response for %s: allow=%s", requestId, allow));
            writeResponse(requestId, allow);

            // 删除请求文件
            Files.delete(requestFile);
            debugLog("FILE_DELETE", "Deleted request file after processing: " + fileName);

            long elapsed = System.currentTimeMillis() - startTime;
            debugLog("REQUEST_COMPLETE", String.format("Request %s completed in %dms", requestId, elapsed));

        } catch (Exception e) {
            debugLog("HANDLE_ERROR", "Error handling request: " + e.getMessage());
            e.printStackTrace();
        } finally {
            processingRequests.remove(fileName);
        }
    }

    /**
     * 显示系统权限对话框（JOptionPane）- 降级方案
     */
    private int showSystemPermissionDialog(String toolName, JsonObject inputs) {
        // 构建消息内容
        StringBuilder message = new StringBuilder();
        message.append("Claude 请求执行以下操作：\n\n");
        message.append("工具：").append(toolName).append("\n");

        // 显示重要参数
        if (inputs.has("file_path")) {
            message.append("文件：").append(inputs.get("file_path").getAsString()).append("\n");
        }
        if (inputs.has("command")) {
            message.append("命令：").append(inputs.get("command").getAsString()).append("\n");
        }

        message.append("\n是否允许执行？");

        // 创建选项
        Object[] options = {
            "允许",
            "拒绝"
        };

        // 显示对话框
        int result = JOptionPane.showOptionDialog(
            null,
            message.toString(),
            "权限请求 - " + toolName,
            JOptionPane.DEFAULT_OPTION,
            JOptionPane.QUESTION_MESSAGE,
            null,
            options,
            options[0]
        );

        if (result == 0) {
            return PermissionResponse.ALLOW.getValue();
        }
        return PermissionResponse.DENY.getValue();
    }

    /**
     * 写入响应文件
     */
    private void writeResponse(String requestId, boolean allow) {
        debugLog("WRITE_RESPONSE_START", String.format("Writing response for requestId=%s, allow=%s", requestId, allow));
        try {
            JsonObject response = new JsonObject();
            response.addProperty("allow", allow);

            Path responseFile = permissionDir.resolve("response-" + requestId + ".json");
            String responseContent = gson.toJson(response);
            debugLog("RESPONSE_CONTENT", "Response JSON: " + responseContent);
            debugLog("RESPONSE_FILE", "Target file: " + responseFile);

            Files.writeString(responseFile, responseContent);

            // 验证文件是否写入成功
            if (Files.exists(responseFile)) {
                long fileSize = Files.size(responseFile);
                debugLog("WRITE_SUCCESS", String.format("Response file written successfully, size=%d bytes", fileSize));
            } else {
                debugLog("WRITE_VERIFY_FAIL", "Response file does NOT exist after write!");
            }
        } catch (IOException e) {
            debugLog("WRITE_ERROR", "Failed to write response file: " + e.getMessage());
            e.printStackTrace();
        }
    }

    /**
     * 停止权限服务
     */
    public void stop() {
        running = false;
        if (watchThread != null) {
            try {
                watchThread.join(1000);
            } catch (InterruptedException e) {
                e.printStackTrace();
            }
        }
        if (watchService != null) {
            try {
                watchService.close();
            } catch (IOException e) {
                e.printStackTrace();
            }
        }
    }

    private void notifyDecision(String toolName, JsonObject inputs, PermissionResponse response) {
        PermissionDecisionListener listener = this.decisionListener;
        if (listener == null || response == null) {
            return;
        }

        try {
            listener.onDecision(new PermissionDecision(toolName, inputs, response));
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
}