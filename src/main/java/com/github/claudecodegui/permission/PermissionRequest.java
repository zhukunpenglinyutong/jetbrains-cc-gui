package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * 权限请求类，用于管理工具调用的权限询问
 */
public class PermissionRequest {
    private final String channelId;
    private final String toolName;
    private final Map<String, Object> inputs;
    private final JsonObject suggestions;
    private final CompletableFuture<PermissionResult> resultFuture;
    private boolean resolved = false;

    public PermissionRequest(String channelId, String toolName, Map<String, Object> inputs, JsonObject suggestions) {
        this.channelId = channelId;
        this.toolName = toolName;
        this.inputs = inputs;
        this.suggestions = suggestions;
        this.resultFuture = new CompletableFuture<>();
    }

    /**
     * 批准权限请求
     */
    public void accept(Map<String, Object> updatedInput, JsonObject updatedPermissions) {
        if (!resolved) {
            resolved = true;
            PermissionResult result = new PermissionResult(
                PermissionResult.Behavior.ALLOW,
                updatedInput != null ? updatedInput : inputs,
                updatedPermissions != null ? updatedPermissions : suggestions,
                null,
                false
            );
            resultFuture.complete(result);
        }
    }

    /**
     * 批准权限请求（使用原始输入）
     */
    public void accept() {
        accept(null, null);
    }

    /**
     * 拒绝权限请求
     */
    public void reject(String message, boolean interrupt) {
        if (!resolved) {
            resolved = true;
            PermissionResult result = new PermissionResult(
                PermissionResult.Behavior.DENY,
                null,
                null,
                message != null ? message : "Denied by user",
                interrupt
            );
            resultFuture.complete(result);
        }
    }

    /**
     * 拒绝权限请求（使用默认参数）
     */
    public void reject() {
        reject(null, true);
    }

    public CompletableFuture<PermissionResult> getResultFuture() {
        return resultFuture;
    }

    public String getChannelId() {
        return channelId;
    }

    public String getToolName() {
        return toolName;
    }

    public Map<String, Object> getInputs() {
        return inputs;
    }

    public JsonObject getSuggestions() {
        return suggestions;
    }

    public boolean isResolved() {
        return resolved;
    }

    /**
     * 权限结果类
     */
    public static class PermissionResult {
        public enum Behavior {
            ALLOW, DENY
        }

        private final Behavior behavior;
        private final Map<String, Object> updatedInput;
        private final JsonObject updatedPermissions;
        private final String message;
        private final boolean interrupt;

        public PermissionResult(Behavior behavior, Map<String, Object> updatedInput,
                                 JsonObject updatedPermissions, String message, boolean interrupt) {
            this.behavior = behavior;
            this.updatedInput = updatedInput;
            this.updatedPermissions = updatedPermissions;
            this.message = message;
            this.interrupt = interrupt;
        }

        public Behavior getBehavior() {
            return behavior;
        }

        public Map<String, Object> getUpdatedInput() {
            return updatedInput;
        }

        public JsonObject getUpdatedPermissions() {
            return updatedPermissions;
        }

        public String getMessage() {
            return message;
        }

        public boolean isInterrupt() {
            return interrupt;
        }
    }
}