package com.github.claudecodegui.permission;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.awt.*;
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

    // 记忆用户选择
    private final Map<String, Integer> permissionMemory = new ConcurrentHashMap<>();

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
    }

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

    /**
     * 处理权限请求
     */
    private void handlePermissionRequest(Path requestFile) {
        try {
            Thread.sleep(100); // 等待文件写入完成

            String content = Files.readString(requestFile);
            JsonObject request = gson.fromJson(content, JsonObject.class);

            String requestId = request.get("requestId").getAsString();
            String toolName = request.get("toolName").getAsString();
            JsonObject inputs = request.get("inputs").getAsJsonObject();

            // 生成内存键
            String memoryKey = toolName + ":" + inputs.toString().hashCode();

            // 检查是否有记忆的选择
            if (permissionMemory.containsKey(memoryKey)) {
                int memorized = permissionMemory.get(memoryKey);
                writeResponse(requestId, memorized == PermissionResponse.DENY.value ? false : true);
                Files.delete(requestFile);
                return;
            }

            // 显示对话框
            CompletableFuture<Integer> future = new CompletableFuture<>();
            SwingUtilities.invokeLater(() -> {
                int response = showPermissionDialog(toolName, inputs);
                future.complete(response);
            });

            int response = future.get(30, TimeUnit.SECONDS);

            // 处理响应
            boolean allow = false;
            switch (response) {
                case 1: // 允许
                    allow = true;
                    break;
                case 2: // 允许且不再询问
                    allow = true;
                    permissionMemory.put(memoryKey, PermissionResponse.ALLOW_ALWAYS.value);
                    break;
                case 3: // 拒绝
                case -1: // 关闭对话框
                default:
                    allow = false;
                    break;
            }

            // 写入响应
            writeResponse(requestId, allow);

            // 删除请求文件
            Files.delete(requestFile);

        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    /**
     * 显示权限对话框
     */
    private int showPermissionDialog(String toolName, JsonObject inputs) {
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
            "允许且不再询问",
            "拒绝"
        };

        // 显示对话框
        int result = JOptionPane.showOptionDialog(
            null,
            message.toString(),
            "权限请求 - " + toolName,
            JOptionPane.YES_NO_CANCEL_OPTION,
            JOptionPane.QUESTION_MESSAGE,
            null,
            options,
            options[0]
        );

        // 转换结果（JOptionPane返回0,1,2，我们需要1,2,3）
        return result + 1;
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
}