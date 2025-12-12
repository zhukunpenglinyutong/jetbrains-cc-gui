package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * 权限管理器，管理所有权限请求和决策
 */
public class PermissionManager {

    // 权限模式枚举
    public enum PermissionMode {
        DEFAULT,    // 默认模式，每次询问
        ALLOW_ALL,  // 允许所有工具调用
        DENY_ALL    // 拒绝所有工具调用
    }

    private PermissionMode mode = PermissionMode.DEFAULT;
    private final Map<String, PermissionRequest> pendingRequests = new ConcurrentHashMap<>();
    private final Map<String, Boolean> toolPermissionMemory = new ConcurrentHashMap<>(); // 记住工具权限决策（工具+参数）
    private final Map<String, Boolean> toolOnlyPermissionMemory = new ConcurrentHashMap<>(); // 工具级别权限记忆（仅工具名）
    private Consumer<PermissionRequest> onPermissionRequestedCallback;

    /**
     * 创建新的权限请求.
     *
     * @param channelId 通道ID
     * @param toolName 工具名称
     * @param inputs 输入参数
     * @param suggestions 建议
     * @param project 所属项目
     * @return 权限请求对象
     */
    public PermissionRequest createRequest(String channelId, String toolName, Map<String, Object> inputs, JsonObject suggestions, Project project) {
        // 首先检查工具级别的权限记忆（总是允许）
        if (toolOnlyPermissionMemory.containsKey(toolName)) {
            PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
            if (toolOnlyPermissionMemory.get(toolName)) {
                request.accept();
            } else {
                request.reject("Previously denied by user", true);
            }
            return request;
        }

        // 检查是否有记忆的权限决策（工具+参数）
        String memoryKey = toolName + ":" + generateInputHash(inputs);
        if (toolPermissionMemory.containsKey(memoryKey)) {
            // 自动处理基于记忆的决策
            PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
            if (toolPermissionMemory.get(memoryKey)) {
                request.accept();
            } else {
                request.reject("Previously denied by user", true);
            }
            return request;
        }

        // 检查全局权限模式
        if (mode == PermissionMode.ALLOW_ALL) {
            PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
            request.accept();
            return request;
        } else if (mode == PermissionMode.DENY_ALL) {
            PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
            request.reject("Denied by global permission mode", true);
            return request;
        }

        // 创建新的权限请求
        PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
        pendingRequests.put(channelId, request);

        // 触发权限请求回调
        if (onPermissionRequestedCallback != null) {
            onPermissionRequestedCallback.accept(request);
        }

        return request;
    }

    /**
     * 创建新的权限请求（兼容旧版本）.
     *
     * @deprecated 使用包含 project 参数的方法
     */
    @Deprecated
    public PermissionRequest createRequest(String channelId, String toolName, Map<String, Object> inputs, JsonObject suggestions) {
        return createRequest(channelId, toolName, inputs, suggestions, null);
    }

    /**
     * 处理权限决策（带记忆选项）
     */
    public void handlePermissionDecision(String channelId, boolean allow, boolean rememberDecision, String rejectMessage) {
        PermissionRequest request = pendingRequests.remove(channelId);
        if (request == null || request.isResolved()) {
            return;
        }

        // 如果选择记住决策，保存到记忆中
        if (rememberDecision) {
            String memoryKey = request.getToolName() + ":" + generateInputHash(request.getInputs());
            toolPermissionMemory.put(memoryKey, allow);
        }

        if (allow) {
            request.accept();
        } else {
            request.reject(rejectMessage != null ? rejectMessage : "Denied by user", true);
        }
    }

    /**
     * 处理权限决策（总是允许 - 按工具类型）
     */
    public void handlePermissionDecisionAlways(String channelId, boolean allow) {
        PermissionRequest request = pendingRequests.remove(channelId);
        if (request == null || request.isResolved()) {
            return;
        }

        // 保存工具级别的权限记忆
        toolOnlyPermissionMemory.put(request.getToolName(), allow);

        if (allow) {
            request.accept();
        } else {
            request.reject("Denied by user", true);
        }
    }

    /**
     * 设置权限请求回调
     */
    public void setOnPermissionRequestedCallback(Consumer<PermissionRequest> callback) {
        this.onPermissionRequestedCallback = callback;
    }

    /**
     * 设置权限模式
     */
    public void setPermissionMode(PermissionMode mode) {
        this.mode = mode;
    }

    /**
     * 获取当前权限模式
     */
    public PermissionMode getPermissionMode() {
        return mode;
    }

    /**
     * 清除权限记忆
     */
    public void clearPermissionMemory() {
        toolPermissionMemory.clear();
    }

    /**
     * 清除特定工具的权限记忆
     */
    public void clearToolPermissionMemory(String toolName) {
        toolPermissionMemory.entrySet().removeIf(entry -> entry.getKey().startsWith(toolName + ":"));
    }

    /**
     * 生成输入参数的哈希值用于记忆
     */
    private String generateInputHash(Map<String, Object> inputs) {
        if (inputs == null || inputs.isEmpty()) {
            return "empty";
        }
        // 简单的哈希实现，实际可以更复杂
        return String.valueOf(inputs.toString().hashCode());
    }

    /**
     * 获取挂起的权限请求
     */
    public Collection<PermissionRequest> getPendingRequests() {
        return new ArrayList<>(pendingRequests.values());
    }

    /**
     * 取消所有挂起的权限请求
     */
    public void cancelAllPendingRequests() {
        for (PermissionRequest request : pendingRequests.values()) {
            request.reject("All requests cancelled", true);
        }
        pendingRequests.clear();
    }
}
