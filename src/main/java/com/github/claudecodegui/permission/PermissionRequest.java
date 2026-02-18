package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Permission request class for managing tool invocation permission prompts.
 */
public class PermissionRequest {
    private final String channelId;
    private final String toolName;
    private final Map<String, Object> inputs;
    private final JsonObject suggestions;
    private final CompletableFuture<PermissionResult> resultFuture;
    private final Project project;
    private boolean resolved = false;

    public PermissionRequest(String channelId, String toolName, Map<String, Object> inputs, JsonObject suggestions, Project project) {
        this.channelId = channelId;
        this.toolName = toolName;
        this.inputs = inputs;
        this.suggestions = suggestions;
        this.project = project;
        this.resultFuture = new CompletableFuture<>();
    }

    /**
     * Backward-compatible constructor (without project).
     *
     * @deprecated Use the constructor that includes a project parameter.
     */
    @Deprecated
    public PermissionRequest(String channelId, String toolName, Map<String, Object> inputs, JsonObject suggestions) {
        this(channelId, toolName, inputs, suggestions, null);
    }

    /**
     * Approve the permission request.
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
     * Approve the permission request (using original inputs).
     */
    public void accept() {
        accept(null, null);
    }

    /**
     * Deny the permission request.
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
     * Deny the permission request (using default parameters).
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

    public Project getProject() {
        return this.project;
    }

    public boolean isResolved() {
        return resolved;
    }

    /**
     * Permission result class.
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
