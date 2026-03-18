package com.github.claudecodegui.permission;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.function.BiConsumer;

/**
 * Owns request/response file naming, session-scoped cleanup, polling helpers,
 * and response serialization for the permission bridge protocol.
 */
class PermissionFileProtocol {

    private static final Logger LOG = Logger.getInstance(PermissionFileProtocol.class);

    private static final String REQUEST_FILE_PREFIX = "request-%s-%s.json";
    private static final String RESPONSE_FILE_PREFIX = "response-%s-%s.json";
    private static final String ASK_USER_QUESTION_FILE_PREFIX = "ask-user-question-%s-%s.json";
    private static final String ASK_USER_QUESTION_RESPONSE_FILE_PREFIX = "ask-user-question-response-%s-%s.json";
    private static final String PLAN_APPROVAL_FILE_PREFIX = "plan-approval-%s-%s.json";
    private static final String PLAN_APPROVAL_RESPONSE_FILE_PREFIX = "plan-approval-response-%s-%s.json";

    private static final int FILE_WAIT_INITIAL_DELAY_MS = 50;
    private static final int FILE_WAIT_MAX_RETRIES = 3;

    private final Path permissionDir;
    private final String sessionId;
    private final Gson gson;
    private final BiConsumer<String, String> debugLog;

    PermissionFileProtocol(Path permissionDir, String sessionId, Gson gson, BiConsumer<String, String> debugLog) {
        this.permissionDir = permissionDir;
        this.sessionId = sessionId;
        this.gson = gson;
        this.debugLog = debugLog;
    }

    boolean waitForFileReady(Path file) {
        int delay = FILE_WAIT_INITIAL_DELAY_MS;
        for (int i = 0; i < FILE_WAIT_MAX_RETRIES; i++) {
            try {
                Thread.sleep(delay);
                if (Files.exists(file) && Files.size(file) > 0) {
                    return true;
                }
                delay *= 2;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            } catch (IOException e) {
                debugLog.accept("FILE_WAIT", "Error checking file: " + e.getMessage());
            }
        }
        return Files.exists(file);
    }

    File[] listPermissionRequestFiles() {
        return listFiles((dir, name) -> name.startsWith("request-" + sessionId + "-") && name.endsWith(".json"));
    }

    File[] listAskUserQuestionRequestFiles() {
        return listFiles((dir, name) ->
                name.startsWith("ask-user-question-" + sessionId + "-")
                        && !name.startsWith("ask-user-question-response-")
                        && name.endsWith(".json"));
    }

    File[] listPlanApprovalRequestFiles() {
        return listFiles((dir, name) ->
                name.startsWith("plan-approval-" + sessionId + "-")
                        && !name.startsWith("plan-approval-response-")
                        && name.endsWith(".json"));
    }

    void cleanupSessionFiles() {
        try {
            if (!permissionDir.toFile().exists()) {
                return;
            }

            deleteFiles("response-" + sessionId + "-");
            deleteFiles("request-" + sessionId + "-");
            deleteFiles("ask-user-question-" + sessionId + "-");
            deleteFiles("plan-approval-" + sessionId + "-");

            debugLog.accept("CLEANUP", "Session-specific permission files cleanup complete");
        } catch (Exception e) {
            debugLog.accept("CLEANUP_ERROR", "Error during cleanup: " + e.getMessage());
        }
    }

    void writePermissionResponse(String requestId, boolean allow) {
        LOG.info("[PERM_WRITE] Writing response for requestId=" + requestId + ", allow=" + allow);
        JsonObject response = new JsonObject();
        response.addProperty("allow", allow);
        writeJson(resolveResponsePath(RESPONSE_FILE_PREFIX, requestId), response, "RESPONSE");
    }

    void writeAskUserQuestionResponse(String requestId, JsonObject answers) {
        JsonObject response = new JsonObject();
        response.add("answers", answers);
        writeJson(resolveResponsePath(ASK_USER_QUESTION_RESPONSE_FILE_PREFIX, requestId), response, "ASK_RESPONSE");
    }

    void writePlanApprovalResponse(String requestId, boolean approved, String targetMode) {
        JsonObject response = new JsonObject();
        response.addProperty("approved", approved);
        response.addProperty("targetMode", targetMode);
        writeJson(resolveResponsePath(PLAN_APPROVAL_RESPONSE_FILE_PREFIX, requestId), response, "PLAN_RESPONSE");
    }

    private void deleteFiles(String prefix) {
        File[] files = listFiles((dir, name) -> name.startsWith(prefix) && name.endsWith(".json"));
        if (files == null) {
            return;
        }
        for (File file : files) {
            try {
                Files.deleteIfExists(file.toPath());
                debugLog.accept("CLEANUP", "Deleted old file: " + file.getName());
            } catch (Exception e) {
                debugLog.accept("CLEANUP_ERROR", "Failed to delete file: " + file.getName());
            }
        }
    }

    private Path resolveResponsePath(String pattern, String requestId) {
        return permissionDir.resolve(String.format(pattern, sessionId, requestId));
    }

    private void writeJson(Path targetFile, JsonObject payload, String tag) {
        try {
            String content = gson.toJson(payload);
            debugLog.accept(tag + "_CONTENT", "Response JSON: " + content);
            debugLog.accept(tag + "_FILE", "Target file: " + targetFile);
            Files.writeString(targetFile, content);

            if (Files.exists(targetFile)) {
                debugLog.accept(tag + "_SUCCESS",
                        "Response file written successfully, size=" + Files.size(targetFile) + " bytes");
            } else {
                debugLog.accept(tag + "_VERIFY_FAIL", "Response file does NOT exist after write!");
            }
        } catch (IOException e) {
            debugLog.accept(tag + "_ERROR", "Failed to write response file: " + e.getMessage());
            LOG.error("Error occurred", e);
        }
    }

    private File[] listFiles(java.io.FilenameFilter filter) {
        File dir = permissionDir.toFile();
        if (!dir.exists()) {
            return new File[0];
        }
        File[] files = dir.listFiles(filter);
        return files != null ? files : new File[0];
    }
}
