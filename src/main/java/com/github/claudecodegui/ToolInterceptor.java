package com.github.claudecodegui;

import com.google.gson.*;
import com.github.claudecodegui.permission.PermissionDialog;
import com.github.claudecodegui.permission.PermissionRequest;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Tool call interceptor.
 * Intercepts and handles tool call permissions before messages are sent to the SDK.
 */
public class ToolInterceptor {

    private static final Logger LOG = Logger.getInstance(ToolInterceptor.class);
    private final Project project;
    private final Set<String> controlledTools;

    public ToolInterceptor(Project project) {
        this.project = project;

        // List of tools that require permission control
        this.controlledTools = new HashSet<>(Arrays.asList(
            "Write",           // Write to file
            "Edit",            // Edit file
            "Delete",          // Delete file
            "Bash",            // Execute shell command
            "ExecuteCommand",  // Execute system command
            "CreateDirectory", // Create directory
            "MoveFile",        // Move file
            "CopyFile"         // Copy file
        ));
    }

    /**
     * Checks whether a message requires permission confirmation.
     */
    public boolean needsPermission(String message) {
        // Simple check logic, can be extended as needed
        // Check if the message contains keywords that require permission
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
     * Pre-processes the message and shows a permission confirmation dialog.
     * @return "bypassPermissions" if the user approves; null if rejected
     */
    public String preprocessMessage(String message) {
        if (!needsPermission(message)) {
            // No permission needed, use default mode
            return "default";
        }

        // Permission confirmation required
        AtomicBoolean userApproved = new AtomicBoolean(false);
        CountDownLatch latch = new CountDownLatch(1);

        ApplicationManager.getApplication().invokeLater(() -> {
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
            // Set a 30-second timeout to prevent indefinite waiting
            boolean responded = latch.await(30, TimeUnit.SECONDS);
            if (!responded) {
                LOG.warn("权限请求超时，自动拒绝");
                return null; // Timeout is treated as rejection
            }
        } catch (InterruptedException e) {
            LOG.error("Error occurred", e);
            return null;
        }

        if (userApproved.get()) {
            // User approved, use bypassPermissions mode
            return "bypassPermissions";
        } else {
            // User rejected
            return null;
        }
    }

    /**
     * Shows a detailed permission dialog.
     */
    public CompletableFuture<Boolean> showDetailedPermissionDialog(String toolName, Map<String, Object> inputs) {
        CompletableFuture<Boolean> future = new CompletableFuture<>();

        ApplicationManager.getApplication().invokeLater(() -> {
            // Create permission request
            PermissionRequest request = new PermissionRequest(
                UUID.randomUUID().toString(),
                toolName,
                inputs,
                null,
                this.project
            );

            // Show permission dialog
            PermissionDialog dialog = new PermissionDialog(this.project, request);
            dialog.setDecisionCallback(decision -> {
                future.complete(decision.allow);
            });
            dialog.show();
        });

        return future;
    }

    /**
     * Parses the SDK response and detects tool calls.
     */
    public List<ToolCall> parseToolCalls(String sdkResponse) {
        List<ToolCall> toolCalls = new ArrayList<>();

        try {
            // Parse SDK response and find tool calls
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

                                // Convert input parameters
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
            // Parse failed, return empty list
        }

        return toolCalls;
    }

    /**
     * Tool call information.
     */
    public static class ToolCall {
        public String toolName;
        public Map<String, Object> inputs;
    }
}
