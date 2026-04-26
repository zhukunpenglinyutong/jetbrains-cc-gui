package com.github.claudecodegui.session;

import com.github.claudecodegui.util.EditOperationBuilder;

import java.util.HashMap;
import java.util.Map;

/** Session-owned dedupe registry for generated edit operations. */
public final class EditOperationRegistry {

    private final Map<String, RegisteredOperation> operationBySignature = new HashMap<>();

    public synchronized boolean register(EditOperationBuilder.Operation operation, String source, String scopeId, long editSequence) {
        String signature = signature(operation);
        int priority = priority(source);
        RegisteredOperation existing = operationBySignature.get(signature);
        if (existing != null && existing.priority() >= priority) {
            return false;
        }
        RegisteredOperation next = new RegisteredOperation(source, scopeId, editSequence, priority);
        operationBySignature.put(signature, next);
        return true;
    }

    private static String signature(EditOperationBuilder.Operation operation) {
        return operation.filePath() + "\u0000" + operation.oldString() + "\u0000" + operation.newString()
                + "\u0000" + operation.lineStart() + "\u0000" + operation.lineEnd();
    }

    private static int priority(String source) {
        if ("codex_session_patch".equals(source)) {
            return 300;
        }
        if ("main_tool_use".equals(source) || "main".equals(source)) {
            return 200;
        }
        if ("subagent_vfs".equals(source) || "subagent".equals(source)) {
            return 100;
        }
        return 0;
    }

    private record RegisteredOperation(String source, String scopeId, long editSequence, int priority) {
    }
}
