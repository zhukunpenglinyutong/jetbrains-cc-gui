package com.github.claudecodegui.permission;

import com.github.claudecodegui.util.WslPathUtil;
import com.google.gson.JsonObject;
import com.intellij.openapi.project.Project;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;

/**
 * Permission manager that handles all permission requests and decisions.
 */
public class PermissionManager {

    // Permission mode enum
    public enum PermissionMode {
        DEFAULT,    // Default mode, ask every time
        ACCEPT_EDITS, // Agent mode: auto-approve file editing operations
        ALLOW_ALL,  // Allow all tool calls
        DENY_ALL    // Deny all tool calls
    }

    private PermissionMode mode = PermissionMode.DEFAULT;
    private final Map<String, PermissionRequest> pendingRequests = new ConcurrentHashMap<>();
    private final Map<String, Boolean> toolPermissionMemory = new ConcurrentHashMap<>(); // Remember tool permission decisions (tool + parameters)
    private final Map<String, Boolean> toolOnlyPermissionMemory = new ConcurrentHashMap<>(); // Tool-level permission memory (tool name only)
    private Consumer<PermissionRequest> onPermissionRequestedCallback;

    /**
     * Create a new permission request.
     *
     * @param channelId the channel ID
     * @param toolName the tool name
     * @param inputs the input parameters
     * @param suggestions the suggestions
     * @param project the owning project
     * @return the permission request object
     */
    public PermissionRequest createRequest(String channelId, String toolName, Map<String, Object> inputs, JsonObject suggestions, Project project) {
        // First check tool-level permission memory (always allow)
        if (toolOnlyPermissionMemory.containsKey(toolName)) {
            PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
            if (toolOnlyPermissionMemory.get(toolName)) {
                request.accept();
            } else {
                request.reject("Previously denied by user", true);
            }
            return request;
        }

        // Check if there is a remembered permission decision (tool + parameters)
        String memoryKey = toolName + ":" + generateInputHash(inputs);
        if (toolPermissionMemory.containsKey(memoryKey)) {
            // Automatically process based on remembered decision
            PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
            if (toolPermissionMemory.get(memoryKey)) {
                request.accept();
            } else {
                request.reject("Previously denied by user", true);
            }
            return request;
        }

        // Check global permission mode
        if (mode == PermissionMode.ACCEPT_EDITS) {
            if (isAutoApprovedInAcceptEditsMode(toolName, inputs, project)) {
                PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
                request.accept();
                return request;
            }
        }
        if (mode == PermissionMode.ALLOW_ALL) {
            PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
            request.accept();
            return request;
        } else if (mode == PermissionMode.DENY_ALL) {
            PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
            request.reject("Denied by global permission mode", true);
            return request;
        }

        // Create a new permission request
        PermissionRequest request = new PermissionRequest(channelId, toolName, inputs, suggestions, project);
        pendingRequests.put(channelId, request);

        // Trigger the permission request callback
        if (onPermissionRequestedCallback != null) {
            onPermissionRequestedCallback.accept(request);
        }

        return request;
    }

    /**
     * Create a new permission request (backward compatible).
     *
     * @deprecated Use the method that includes a project parameter.
     */
    @Deprecated
    public PermissionRequest createRequest(String channelId, String toolName, Map<String, Object> inputs, JsonObject suggestions) {
        return createRequest(channelId, toolName, inputs, suggestions, null);
    }

    /**
     * Handle a permission decision (with remember option).
     */
    public void handlePermissionDecision(String channelId, boolean allow, boolean rememberDecision, String rejectMessage) {
        PermissionRequest request = pendingRequests.get(channelId);
        if (request == null) {
            return;
        }

        synchronized (request) {
            if (!pendingRequests.remove(channelId, request) || request.isResolved()) {
                return;
            }
            if (rememberDecision) {
                String memoryKey = request.getToolName() + ":" + generateInputHash(request.getInputs());
                toolPermissionMemory.put(memoryKey, allow);
            }
            applyDecision(request, allow, rejectMessage);
        }
    }

    /**
     * Handle a permission decision (always allow/deny - by tool type).
     */
    public void handlePermissionDecisionAlways(String channelId, boolean allow) {
        PermissionRequest request = pendingRequests.get(channelId);
        if (request == null) {
            return;
        }

        synchronized (request) {
            if (!pendingRequests.remove(channelId, request) || request.isResolved()) {
                return;
            }
            toolOnlyPermissionMemory.put(request.getToolName(), allow);
            applyDecision(request, allow, "Denied by user");
        }
    }

    /**
     * Resolves the exact dialog request without consuming a new request that reuses its channel ID.
     *
     * @param request the original request bound to the dialog
     * @param allow whether to allow the request
     * @param remember whether to remember the tool-level decision
     * @param rejectMessage the reason for rejection
     */
    public void handlePermissionDecision(PermissionRequest request, boolean allow, boolean remember, String rejectMessage) {
        synchronized (request) {
            boolean current = pendingRequests.remove(request.getChannelId(), request);
            if (request.getResultFuture().isDone()) {
                return;
            }
            if (current && remember) {
                toolOnlyPermissionMemory.put(request.getToolName(), allow);
            }
            if (!current && pendingRequests.containsKey(request.getChannelId())) {
                request.reject(rejectMessage != null ? rejectMessage : "Permission request was superseded", true);
                return;
            }
            if (!current) {
                return;
            }
            applyDecision(request, allow, rejectMessage);
        }
    }

    /**
     * Handle a remote decision only while the exact request is still pending.
     *
     * @param request the request bound to the remote approval token
     * @param allow whether to allow the request
     * @param rejectMessage the reason for rejection
     * @return whether this call resolved the pending request
     */
    public boolean tryHandleRemotePermissionDecision(
            PermissionRequest request, boolean allow, String rejectMessage) {
        if (request == null) {
            return false;
        }
        synchronized (request) {
            if (!pendingRequests.remove(request.getChannelId(), request) || request.isResolved()) {
                return false;
            }
            applyDecision(request, allow, rejectMessage);
            return request.isResolved();
        }
    }

    private void applyDecision(PermissionRequest request, boolean allow, String rejectMessage) {
        if (allow) {
            request.accept();
        } else {
            request.reject(rejectMessage != null ? rejectMessage : "Denied by user", true);
        }
    }

    /**
     * Set the permission request callback.
     */
    public void setOnPermissionRequestedCallback(Consumer<PermissionRequest> callback) {
        this.onPermissionRequestedCallback = callback;
    }

    /**
     * Set the permission mode.
     */
    public void setPermissionMode(PermissionMode mode) {
        this.mode = mode;
    }

    /**
     * Get the current permission mode.
     */
    public PermissionMode getPermissionMode() {
        return mode;
    }

    /**
     * Clear all permission memory.
     */
    public void clearPermissionMemory() {
        toolPermissionMemory.clear();
    }

    /**
     * Clear permission memory for a specific tool.
     */
    public void clearToolPermissionMemory(String toolName) {
        toolPermissionMemory.entrySet().removeIf(entry -> entry.getKey().startsWith(toolName + ":"));
    }

    /**
     * Generate a hash of the input parameters for memory lookup.
     */
    private String generateInputHash(Map<String, Object> inputs) {
        if (inputs == null || inputs.isEmpty()) {
            return "empty";
        }
        // Simple hash implementation; could be more sophisticated
        return String.valueOf(inputs.toString().hashCode());
    }

    private boolean isAutoApprovedInAcceptEditsMode(String toolName, Map<String, Object> inputs, Project project) {
        if (toolName == null || toolName.isEmpty()) {
            return false;
        }

        boolean isEditTool = "Write".equals(toolName)
            || "Edit".equals(toolName)
            || "MultiEdit".equals(toolName)
            || "CreateDirectory".equals(toolName)
            || "MoveFile".equals(toolName)
            || "CopyFile".equals(toolName)
            || "Rename".equals(toolName);

        if (!isEditTool) {
            return false;
        }

        // Validate that the target file path is within the project directory.
        // When project or inputs are unavailable, do NOT auto-approve to prevent
        // unvalidated edits from bypassing the project-boundary check.
        if (project == null || inputs == null) {
            return false;
        }

        String filePath = null;
        if (inputs.containsKey("file_path")) {
            filePath = String.valueOf(inputs.get("file_path"));
        } else if (inputs.containsKey("path")) {
            filePath = String.valueOf(inputs.get("path"));
        }

        // If no file path is provided, do not auto-approve
        if (filePath == null) {
            return false;
        }

        String basePath = project.getBasePath();
        if (basePath == null) {
            return false;
        }

        return WslPathUtil.isPathWithinDirectory(filePath, basePath);
    }

    /**
     * Get all pending permission requests.
     */
    public Collection<PermissionRequest> getPendingRequests() {
        return new ArrayList<>(pendingRequests.values());
    }

    /**
     * Cancel all pending permission requests.
     */
    public void cancelAllPendingRequests() {
        for (PermissionRequest request : pendingRequests.values()) {
            request.reject("All requests cancelled", true);
        }
        pendingRequests.clear();
    }
}
