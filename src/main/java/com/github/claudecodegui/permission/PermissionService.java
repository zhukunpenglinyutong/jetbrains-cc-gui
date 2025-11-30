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
        try {
            Files.createDirectories(permissionDir);
        } catch (IOException e) {
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
    }

    /**
     * 设置权限对话框显示器（用于显示前端弹窗）
     */
    public void setDialogShower(PermissionDialogShower shower) {
        this.dialogShower = shower;
    }

    /**
     * 启动权限服务
     */
    public void start() {
        if (running) return;

        running = true;

        watchThread = new Thread(this::watchLoop, "PermissionWatcher");
        watchThread.setDaemon(true);
        watchThread.start();

        System.out.println("[PermissionService] Started polling: " + permissionDir);
    }

    /**
     * 监控文件变化
     * 改为轮询模式，以提高在 macOS /tmp 目录下的可靠性
     */
    private void watchLoop() {
        System.out.println("[PermissionService] Starting polling loop on: " + permissionDir);
        while (running) {
            try {
                File dir = permissionDir.toFile();
                if (!dir.exists()) {
                    dir.mkdirs();
                }

                File[] files = dir.listFiles((d, name) -> name.startsWith("request-") && name.endsWith(".json"));

                if (files != null) {
                    for (File file : files) {
                        // 简单防重：检查文件是否还存在（可能被其他线程处理了）
                        if (file.exists()) {
                            System.out.println("[PermissionService] Found request: " + file.getName());
                            handlePermissionRequest(file.toPath());
                        }
                    }
                }

                // 轮询间隔 500ms
                Thread.sleep(500);
            } catch (Exception e) {
                e.printStackTrace();
                try {
                    Thread.sleep(1000); // 出错后稍作等待
                } catch (InterruptedException ex) {
                    break;
                }
            }
        }
    }

    // 记录正在处理的请求文件，避免重复处理
    private final Set<String> processingRequests = ConcurrentHashMap.newKeySet();

    /**
     * 处理权限请求
     */
    private void handlePermissionRequest(Path requestFile) {
        String fileName = requestFile.getFileName().toString();

        // 检查是否正在处理该请求
        if (!processingRequests.add(fileName)) {
            System.out.println("[PermissionService] 请求已在处理中，跳过: " + fileName);
            return;
        }

        try {
            Thread.sleep(100); // 等待文件写入完成

            String content = Files.readString(requestFile);
            JsonObject request = gson.fromJson(content, JsonObject.class);

            String requestId = request.get("requestId").getAsString();
            String toolName = request.get("toolName").getAsString();
            JsonObject inputs = request.get("inputs").getAsJsonObject();

            // 首先检查工具级别的权限记忆（总是允许）
            if (toolOnlyPermissionMemory.containsKey(toolName)) {
                boolean allow = toolOnlyPermissionMemory.get(toolName);
                System.out.println("[PermissionService] 使用工具级别权限记忆: " + toolName + " -> " + (allow ? "允许" : "拒绝"));
                writeResponse(requestId, allow);
                notifyDecision(toolName, inputs, allow ? PermissionResponse.ALLOW_ALWAYS : PermissionResponse.DENY);
                Files.deleteIfExists(requestFile);
                processingRequests.remove(fileName);
                return;
            }

            // 生成内存键（工具+参数）
            String memoryKey = toolName + ":" + inputs.toString().hashCode();

            // 检查是否有记忆的选择（工具+参数级别）
            if (permissionMemory.containsKey(memoryKey)) {
                int memorized = permissionMemory.get(memoryKey);
                PermissionResponse rememberedResponse = PermissionResponse.fromValue(memorized);
                boolean allow = rememberedResponse != PermissionResponse.DENY;
                writeResponse(requestId, allow);
                notifyDecision(toolName, inputs, rememberedResponse);
                Files.deleteIfExists(requestFile);
                processingRequests.remove(fileName);
                return;
            }

            // 如果有前端弹窗显示器，使用异步方式
            if (dialogShower != null) {
                System.out.println("[PermissionService] 使用前端弹窗显示权限请求 (异步): " + toolName);

                // 立即删除请求文件，避免重复处理
                try {
                    Files.deleteIfExists(requestFile);
                    System.out.println("[PermissionService] 已删除请求文件: " + fileName);
                } catch (Exception e) {
                    System.err.println("[PermissionService] 删除请求文件失败: " + e.getMessage());
                }

                final String memKey = memoryKey;
                final String tool = toolName;

                // 异步调用前端弹窗
                CompletableFuture<Integer> future = dialogShower.showPermissionDialog(toolName, inputs);

                // 异步处理结果
                future.thenAccept(response -> {
                    try {
                        PermissionResponse decision = PermissionResponse.fromValue(response);
                        if (decision == null) {
                            decision = PermissionResponse.DENY;
                        }

                        boolean allow;
                        switch (decision) {
                            case ALLOW:
                                allow = true;
                                break;
                            case ALLOW_ALWAYS:
                                allow = true;
                                // 保存到工具级别权限记忆（按工具类型，不是按参数）
                                toolOnlyPermissionMemory.put(tool, true);
                                System.out.println("[PermissionService] 已记住工具权限: " + tool + " -> 总是允许");
                                break;
                            case DENY:
                            default:
                                allow = false;
                                break;
                        }

                        notifyDecision(toolName, inputs, decision);
                        writeResponse(requestId, allow);

                        System.out.println("[PermissionService] 前端弹窗处理完成: allow=" + allow);
                    } catch (Exception e) {
                        System.err.println("[PermissionService] 处理前端弹窗结果失败: " + e.getMessage());
                        e.printStackTrace();
                    } finally {
                        processingRequests.remove(fileName);
                    }
                }).exceptionally(ex -> {
                    System.err.println("[PermissionService] 前端弹窗异常: " + ex.getMessage());
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
            System.out.println("[PermissionService] 使用系统弹窗显示权限请求: " + toolName);
            CompletableFuture<Integer> future = new CompletableFuture<>();
            SwingUtilities.invokeLater(() -> {
                int response = showSystemPermissionDialog(toolName, inputs);
                future.complete(response);
            });

            int response = future.get(30, TimeUnit.SECONDS);
            PermissionResponse decision = PermissionResponse.fromValue(response);
            if (decision == null) {
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
                    break;
                case DENY:
                default:
                    allow = false;
                    break;
            }

            notifyDecision(toolName, inputs, decision);

            // 写入响应
            writeResponse(requestId, allow);

            // 删除请求文件
            Files.delete(requestFile);

        } catch (Exception e) {
            e.printStackTrace();
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
        try {
            JsonObject response = new JsonObject();
            response.addProperty("allow", allow);

            Path responseFile = permissionDir.resolve("response-" + requestId + ".json");
            Files.writeString(responseFile, gson.toJson(response));

            System.out.println("[PermissionService] Written response: " + responseFile);
        } catch (IOException e) {
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