package com.github.claudecodegui.permission;

import com.google.gson.JsonObject;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Stores remembered permission decisions at tool and tool+input granularity.
 */
class PermissionDecisionStore {

    private final Map<String, Integer> parameterDecisionMemory = new ConcurrentHashMap<>();
    private final Map<String, Boolean> toolDecisionMemory = new ConcurrentHashMap<>();

    PermissionService.PermissionResponse getToolDecision(String toolName) {
        Boolean allow = toolDecisionMemory.get(toolName);
        if (allow == null) {
            return null;
        }
        return allow
                ? PermissionService.PermissionResponse.ALLOW_ALWAYS
                : PermissionService.PermissionResponse.DENY;
    }

    PermissionService.PermissionResponse getParameterDecision(String toolName, JsonObject inputs) {
        Integer remembered = parameterDecisionMemory.get(buildMemoryKey(toolName, inputs));
        if (remembered == null) {
            return null;
        }
        return PermissionService.PermissionResponse.fromValue(remembered);
    }

    String buildMemoryKey(String toolName, JsonObject inputs) {
        return toolName + ":" + (inputs != null ? inputs.toString() : "null");
    }

    void rememberToolDecision(String toolName, PermissionService.PermissionResponse decision) {
        if (toolName == null || decision == null) {
            return;
        }
        if (decision == PermissionService.PermissionResponse.ALLOW_ALWAYS) {
            toolDecisionMemory.put(toolName, true);
        } else if (decision == PermissionService.PermissionResponse.DENY) {
            toolDecisionMemory.put(toolName, false);
        }
    }

    void rememberParameterDecision(String toolName, JsonObject inputs, PermissionService.PermissionResponse decision) {
        if (toolName == null || decision == null) {
            return;
        }
        parameterDecisionMemory.put(buildMemoryKey(toolName, inputs), decision.getValue());
    }

    void clear() {
        parameterDecisionMemory.clear();
        toolDecisionMemory.clear();
    }

    int getParameterMemorySize() {
        return parameterDecisionMemory.size();
    }

    int getToolMemorySize() {
        return toolDecisionMemory.size();
    }
}
