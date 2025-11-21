package com.github.claudecodegui;

import com.google.gson.*;
import com.github.claudecodegui.permission.PermissionDialog;
import com.github.claudecodegui.permission.PermissionRequest;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 工具调用拦截器
 * 在消息发送到SDK之前拦截并处理工具调用权限
 */
public class ToolInterceptor {

    private final Project project;
    private final Set<String> controlledTools;

    public ToolInterceptor(Project project) {
        this.project = project;

        // 需要权限控制的工具列表
        this.controlledTools = new HashSet<>(Arrays.asList(
            "Write",           // 写入文件
            "Edit",            // 编辑文件
            "Delete",          // 删除文件
            "Bash",            // 执行Shell命令
            "ExecuteCommand",  // 执行系统命令
            "CreateDirectory", // 创建目录
            "MoveFile",        // 移动文件
            "CopyFile"         // 复制文件
        ));
    }

    /**
     * 检查消息是否需要权限确认
     */
    public boolean needsPermission(String message) {
        // 简单的检查逻辑，可以根据需要扩展
        // 检查消息是否包含需要权限的关键词
        String lowerMessage = message.toLowerCase();
        return lowerMessage.contains("创建") ||
               lowerMessage.contains("写入") ||
               lowerMessage.contains("文件") ||
               lowerMessage.contains("执行") ||
               lowerMessage.contains("运行") ||
               lowerMessage.contains("删除") ||
               lowerMessage.contains("编辑");
    }

    /**
     * 预处理消息，显示权限确认对话框
     * @return 如果用户同意，返回"bypassPermissions"；否则返回null表示拒绝
     */
    public String preprocessMessage(String message) {
        if (!needsPermission(message)) {
            // 不需要权限，使用默认模式
            return "default";
        }

        // 需要权限确认
        AtomicBoolean userApproved = new AtomicBoolean(false);
        CountDownLatch latch = new CountDownLatch(1);

        SwingUtilities.invokeLater(() -> {
            int result = JOptionPane.showConfirmDialog(
                null,
                "Claude 需要执行以下操作：\n\n" +
                message + "\n\n" +
                "这可能涉及文件写入或系统命令执行。\n" +
                "是否允许执行？",
                "权限请求",
                JOptionPane.YES_NO_OPTION,
                JOptionPane.QUESTION_MESSAGE
            );

            userApproved.set(result == JOptionPane.YES_OPTION);
            latch.countDown();
        });

        try {
            // 设置30秒超时，防止无限等待
            boolean responded = latch.await(30, TimeUnit.SECONDS);
            if (!responded) {
                System.err.println("权限请求超时，自动拒绝");
                return null; // 超时视为拒绝
            }
        } catch (InterruptedException e) {
            e.printStackTrace();
            return null;
        }

        if (userApproved.get()) {
            // 用户同意，使用bypassPermissions模式
            return "bypassPermissions";
        } else {
            // 用户拒绝
            return null;
        }
    }

    /**
     * 显示详细的权限对话框
     */
    public CompletableFuture<Boolean> showDetailedPermissionDialog(String toolName, Map<String, Object> inputs) {
        CompletableFuture<Boolean> future = new CompletableFuture<>();

        SwingUtilities.invokeLater(() -> {
            // 创建权限请求
            PermissionRequest request = new PermissionRequest(
                UUID.randomUUID().toString(),
                toolName,
                inputs,
                null
            );

            // 显示权限对话框
            PermissionDialog dialog = new PermissionDialog(project, request);
            dialog.setDecisionCallback(decision -> {
                future.complete(decision.allow);
            });
            dialog.show();
        });

        return future;
    }

    /**
     * 解析SDK响应，检测工具调用
     */
    public List<ToolCall> parseToolCalls(String sdkResponse) {
        List<ToolCall> toolCalls = new ArrayList<>();

        try {
            // 解析SDK响应，查找工具调用
            JsonObject response = JsonParser.parseString(sdkResponse).getAsJsonObject();

            if (response.has("message")) {
                JsonObject message = response.getAsJsonObject("message");
                if (message.has("content")) {
                    JsonArray content = message.getAsJsonArray("content");
                    for (JsonElement element : content) {
                        if (element.isJsonObject()) {
                            JsonObject contentItem = element.getAsJsonObject();
                            if (contentItem.has("type") &&
                                "tool_use".equals(contentItem.get("type").getAsString())) {

                                String toolName = contentItem.get("name").getAsString();
                                JsonObject inputs = contentItem.getAsJsonObject("input");

                                ToolCall call = new ToolCall();
                                call.toolName = toolName;
                                call.inputs = new HashMap<>();

                                // 转换输入参数
                                for (Map.Entry<String, JsonElement> entry : inputs.entrySet()) {
                                    call.inputs.put(entry.getKey(), entry.getValue().toString());
                                }

                                toolCalls.add(call);
                            }
                        }
                    }
                }
            }
        } catch (Exception e) {
            // 解析失败，返回空列表
        }

        return toolCalls;
    }

    /**
     * 工具调用信息
     */
    public static class ToolCall {
        public String toolName;
        public Map<String, Object> inputs;
    }
}