package com.github.claudecodegui.handler;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Permission handler.
 * Handles permission dialog display and decision processing.
 */
public class PermissionHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PermissionHandler.class);

    // Permission request timeout (5 minutes), consistent with Node-side PERMISSION_TIMEOUT_MS
    private static final long PERMISSION_TIMEOUT_SECONDS = 300;

    private static final String[] SUPPORTED_TYPES = {
        "permission_decision",
        "ask_user_question_response",
        "plan_approval_response"
    };

    // Permission request map
    private final Map<String, CompletableFuture<Integer>> pendingPermissionRequests = new ConcurrentHashMap<>();

    // AskUserQuestion request map (requestId -> CompletableFuture<JsonObject>)
    private final Map<String, CompletableFuture<JsonObject>> pendingAskUserQuestionRequests = new ConcurrentHashMap<>();

    // PlanApproval request map (requestId -> CompletableFuture<JsonObject>)
    private final Map<String, CompletableFuture<JsonObject>> pendingPlanApprovalRequests = new ConcurrentHashMap<>();

    // Permission denied callback
    public interface PermissionDeniedCallback {
        void onPermissionDenied();
    }

    private PermissionDeniedCallback deniedCallback;

    public PermissionHandler(HandlerContext context) {
        super(context);
    }

    public void setPermissionDeniedCallback(PermissionDeniedCallback callback) {
        this.deniedCallback = callback;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("permission_decision".equals(type)) {
            LOG.debug("[PERM_DEBUG][BRIDGE_RECV] Received permission_decision from JS");
            LOG.debug("[PERM_DEBUG][BRIDGE_RECV] Content: " + content);
            handlePermissionDecision(content);
            return true;
        } else if ("ask_user_question_response".equals(type)) {
            LOG.debug("[ASK_USER_QUESTION][BRIDGE_RECV] Received ask_user_question_response from JS");
            LOG.debug("[ASK_USER_QUESTION][BRIDGE_RECV] Content: " + content);
            handleAskUserQuestionResponse(content);
            return true;
        } else if ("plan_approval_response".equals(type)) {
            LOG.debug("[PLAN_APPROVAL][BRIDGE_RECV] Received plan_approval_response from JS");
            LOG.debug("[PLAN_APPROVAL][BRIDGE_RECV] Content: " + content);
            handlePlanApprovalResponse(content);
            return true;
        }
        return false;
    }

    /**
     * Show the frontend permission dialog.
     */
    public CompletableFuture<Integer> showFrontendPermissionDialog(String toolName, JsonObject inputs) {
        String channelId = UUID.randomUUID().toString();
        CompletableFuture<Integer> future = new CompletableFuture<>();

        LOG.info("[PERM_SHOW] showFrontendPermissionDialog called: channelId=" + channelId + ", toolName=" + toolName);

        pendingPermissionRequests.put(channelId, future);
        LOG.info("[PERM_SHOW] Stored pending request, total pending: " + pendingPermissionRequests.size());

        try {
            Gson gson = new Gson();
            JsonObject requestData = new JsonObject();
            requestData.addProperty("channelId", channelId);
            requestData.addProperty("toolName", toolName);
            requestData.add("inputs", inputs);

            String requestJson = gson.toJson(requestData);
            String escapedJson = escapeJs(requestJson);

            ApplicationManager.getApplication().invokeLater(() -> {
                LOG.info("[PERM_SHOW] Executing JS to show dialog for channelId=" + channelId);
                String jsCode = "(function retryShowDialog(retries) { " +
                    "  if (window.showPermissionDialog) { " +
                    "    window.showPermissionDialog('" + escapedJson + "'); " +
                    "  } else if (retries > 0) { " +
                    "    setTimeout(function() { retryShowDialog(retries - 1); }, 200); " +
                    "  } else { " +
                    "    console.error('[PERM_DEBUG][JS] FAILED: showPermissionDialog not available!'); " +
                    "  } " +
                    "})(30);";

                context.executeJavaScriptOnEDT(jsCode);
            });

            // Timeout handling (give users enough time to review the context)
            CompletableFuture.delayedExecutor(PERMISSION_TIMEOUT_SECONDS, TimeUnit.SECONDS).execute(() -> {
                if (!future.isDone()) {
                    LOG.warn("[PERM_SHOW] Timeout! Removing pending request for channelId=" + channelId);
                    pendingPermissionRequests.remove(channelId);
                    future.complete(PermissionService.PermissionResponse.DENY.getValue());
                }
            });

        } catch (Exception e) {
            LOG.error("[PERM_SHOW] ERROR: " + e.getMessage(), e);
            pendingPermissionRequests.remove(channelId);
            future.complete(PermissionService.PermissionResponse.DENY.getValue());
        }

        return future;
    }

    /**
     * Show permission request dialog (from PermissionRequest).
     */
    public void showPermissionDialog(PermissionRequest request) {
        LOG.info("[PermissionHandler] 显示权限请求对话框: " + request.getToolName());

        try {
            Gson gson = new Gson();
            JsonObject requestData = new JsonObject();
            requestData.addProperty("channelId", request.getChannelId());
            requestData.addProperty("toolName", request.getToolName());

            JsonObject inputsJson = gson.toJsonTree(request.getInputs()).getAsJsonObject();
            requestData.add("inputs", inputsJson);

            if (request.getSuggestions() != null) {
                requestData.add("suggestions", request.getSuggestions());
            }

            String requestJson = gson.toJson(requestData);
            String escapedJson = escapeJs(requestJson);

            // Get the project associated with the permission request
            Project targetProject = request.getProject();
            if (targetProject == null) {
                LOG.warn("[PermissionHandler] 警告: PermissionRequest 没有关联的 Project，使用当前 context 的窗口");
                targetProject = this.context.getProject();
            }

            // Get the window instance for the target project
            com.github.claudecodegui.ClaudeChatWindow targetWindow =
                com.github.claudecodegui.ClaudeSDKToolWindow.getChatWindow(targetProject);

            if (targetWindow == null) {
                LOG.error("[PermissionHandler] 错误: 找不到项目 " + targetProject.getName() + " 的窗口实例");
                // If target window is not found, deny the permission request
                this.context.getSession().handlePermissionDecision(
                    request.getChannelId(),
                    false,
                    false,
                    "Failed to show permission dialog: window not found"
                );
                notifyPermissionDenied();
                return;
            }

            // Execute JavaScript in the target window to show the dialog
            String jsCode = "if (window.showPermissionDialog) { " +
                "  window.showPermissionDialog('" + escapedJson + "'); " +
                "}";

            targetWindow.executeJavaScriptCode(jsCode);

        } catch (Exception e) {
            LOG.error("[PermissionHandler] 显示权限弹窗失败: " + e.getMessage(), e);
            this.context.getSession().handlePermissionDecision(
                request.getChannelId(),
                false,
                false,
                "Failed to show permission dialog: " + e.getMessage()
            );
            notifyPermissionDenied();
        }
    }

    /**
     * Handle permission decision messages from JavaScript.
     */
    private void handlePermissionDecision(String jsonContent) {
        LOG.info("[PERM_DECISION] Received permission decision from JS");
        LOG.debug("[PERM_DEBUG][HANDLE_DECISION] Content: " + jsonContent);
        try {
            Gson gson = new Gson();
            JsonObject decision = gson.fromJson(jsonContent, JsonObject.class);

            String channelId = decision.get("channelId").getAsString();
            boolean allow = decision.get("allow").getAsBoolean();
            boolean remember = decision.get("remember").getAsBoolean();
            String rejectMessage = "";
            if (decision.has("rejectMessage") && !decision.get("rejectMessage").isJsonNull()) {
                rejectMessage = decision.get("rejectMessage").getAsString();
            }

            LOG.info("[PERM_DECISION] channelId=" + channelId + ", allow=" + allow + ", remember=" + remember);
            LOG.info("[PERM_DECISION] pendingPermissionRequests size before remove: " + pendingPermissionRequests.size());

            CompletableFuture<Integer> pendingFuture = pendingPermissionRequests.remove(channelId);

            if (pendingFuture != null) {
                LOG.info("[PERM_DECISION] Found pending future, completing with allow=" + allow);
                int responseValue;
                if (allow) {
                    responseValue = remember ?
                        PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue() :
                        PermissionService.PermissionResponse.ALLOW.getValue();
                } else {
                    responseValue = PermissionService.PermissionResponse.DENY.getValue();
                }
                pendingFuture.complete(responseValue);
                LOG.info("[PERM_DECISION] Future completed with value=" + responseValue);

                if (!allow) {
                    notifyPermissionDenied();
                }
            } else {
                LOG.warn("[PERM_DECISION] No pending future found for channelId=" + channelId + ", falling back to session handler");
                LOG.warn("[PERM_DECISION] Current pendingPermissionRequests keys: " + pendingPermissionRequests.keySet());
                // Handle permission request from Session
                if (remember) {
                    context.getSession().handlePermissionDecisionAlways(channelId, allow);
                } else {
                    context.getSession().handlePermissionDecision(channelId, allow, false, rejectMessage);
                }
                if (!allow) {
                    notifyPermissionDenied();
                }
            }
        } catch (Exception e) {
            LOG.error("[PERM_DECISION] ERROR: " + e.getMessage(), e);
        }
    }

    /**
     * Notify that permission was denied.
     */
    private void notifyPermissionDenied() {
        if (deniedCallback != null) {
            deniedCallback.onPermissionDenied();
        }
    }

    /**
     * Clear all pending permission requests.
     * Called during session switching or history restoration to prevent old requests from interfering with the new session.
     */
    public void clearPendingRequests() {
        LOG.info("[PERM_CLEAR] Clearing all pending permission requests");

        int permissionCount = pendingPermissionRequests.size();
        int askUserCount = pendingAskUserQuestionRequests.size();
        int planCount = pendingPlanApprovalRequests.size();

        // Cancel all pending permission requests
        for (Map.Entry<String, CompletableFuture<Integer>> entry : pendingPermissionRequests.entrySet()) {
            entry.getValue().complete(PermissionService.PermissionResponse.DENY.getValue());
        }
        pendingPermissionRequests.clear();

        // Cancel all pending AskUserQuestion requests
        for (Map.Entry<String, CompletableFuture<JsonObject>> entry : pendingAskUserQuestionRequests.entrySet()) {
            entry.getValue().complete(null);
        }
        pendingAskUserQuestionRequests.clear();

        // Cancel all pending PlanApproval requests
        for (Map.Entry<String, CompletableFuture<JsonObject>> entry : pendingPlanApprovalRequests.entrySet()) {
            JsonObject rejected = new com.google.gson.JsonObject();
            rejected.addProperty("approved", false);
            rejected.addProperty("message", "Session changed");
            entry.getValue().complete(rejected);
        }
        pendingPlanApprovalRequests.clear();

        LOG.info("[PERM_CLEAR] Cleared: " + permissionCount + " permission, " +
                 askUserCount + " askUser, " + planCount + " plan requests");
    }

    /**
     * Show AskUserQuestion dialog (implements PermissionService.AskUserQuestionDialogShower interface).
     */
    public CompletableFuture<JsonObject> showAskUserQuestionDialog(String requestId, JsonObject questionsData) {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();

        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] Starting showAskUserQuestionDialog");
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] requestId=" + requestId);
        LOG.debug("[ASK_USER_QUESTION][SHOW_DIALOG] questionsData=" + questionsData.toString());

        pendingAskUserQuestionRequests.put(requestId, future);

        try {
            Gson gson = new Gson();
            String requestJson = gson.toJson(questionsData);
            String escapedJson = escapeJs(requestJson);

            ApplicationManager.getApplication().invokeLater(() -> {
                String jsCode = "(function retryShowAskUserQuestion(retries) { " +
                    "  if (window.showAskUserQuestionDialog) { " +
                    "    window.showAskUserQuestionDialog('" + escapedJson + "'); " +
                    "  } else if (retries > 0) { " +
                    "    setTimeout(function() { retryShowAskUserQuestion(retries - 1); }, 200); " +
                    "  } else { " +
                    "    console.error('[ASK_USER_QUESTION][JS] FAILED: showAskUserQuestionDialog not available!'); " +
                    "  } " +
                    "})(30);";

                context.executeJavaScriptOnEDT(jsCode);
            });

            // Timeout handling (consistent with regular permission requests: 5 minutes)
            CompletableFuture.delayedExecutor(PERMISSION_TIMEOUT_SECONDS, TimeUnit.SECONDS).execute(() -> {
                if (!future.isDone()) {
                    LOG.warn("[ASK_USER_QUESTION][SHOW_DIALOG] Timeout! Removing pending request for requestId=" + requestId);
                    pendingAskUserQuestionRequests.remove(requestId);
                    // Return empty answers on timeout
                    future.complete(new JsonObject());
                }
            });

        } catch (Exception e) {
            LOG.error("[ASK_USER_QUESTION][SHOW_DIALOG] ERROR: " + e.getMessage(), e);
            pendingAskUserQuestionRequests.remove(requestId);
            future.complete(new JsonObject());
        }

        return future;
    }

    /**
     * Handle AskUserQuestion response messages from JavaScript.
     */
    private void handleAskUserQuestionResponse(String jsonContent) {
        LOG.debug("[ASK_USER_QUESTION][HANDLE_RESPONSE] Received response from JS: " + jsonContent);
        try {
            Gson gson = new Gson();
            JsonObject response = gson.fromJson(jsonContent, JsonObject.class);

            String requestId = response.get("requestId").getAsString();
            JsonObject answers = response.has("answers") && !response.get("answers").isJsonNull()
                ? response.get("answers").getAsJsonObject()
                : new JsonObject();

            CompletableFuture<JsonObject> pendingFuture = pendingAskUserQuestionRequests.remove(requestId);

            if (pendingFuture != null) {
                LOG.debug("[ASK_USER_QUESTION][HANDLE_RESPONSE] Completing future with answers: " + answers.toString());
                pendingFuture.complete(answers);
            } else {
                LOG.warn("[ASK_USER_QUESTION][HANDLE_RESPONSE] No pending request found for requestId: " + requestId);
            }
        } catch (Exception e) {
            LOG.error("[ASK_USER_QUESTION][HANDLE_RESPONSE] ERROR: " + e.getMessage(), e);
        }
    }

    /**
     * Show PlanApproval dialog (implements PermissionService.PlanApprovalDialogShower interface).
     */
    public CompletableFuture<JsonObject> showPlanApprovalDialog(String requestId, JsonObject planData) {
        CompletableFuture<JsonObject> future = new CompletableFuture<>();

        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] Starting showPlanApprovalDialog");
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] requestId=" + requestId);
        LOG.debug("[PLAN_APPROVAL][SHOW_DIALOG] planData=" + planData.toString());

        pendingPlanApprovalRequests.put(requestId, future);

        try {
            Gson gson = new Gson();
            String requestJson = gson.toJson(planData);
            String escapedJson = escapeJs(requestJson);

            ApplicationManager.getApplication().invokeLater(() -> {
                String jsCode = "(function retryShowPlanApproval(retries) { " +
                    "  if (window.showPlanApprovalDialog) { " +
                    "    window.showPlanApprovalDialog('" + escapedJson + "'); " +
                    "  } else if (retries > 0) { " +
                    "    setTimeout(function() { retryShowPlanApproval(retries - 1); }, 200); " +
                    "  } else { " +
                    "    console.error('[PLAN_APPROVAL][JS] FAILED: showPlanApprovalDialog not available!'); " +
                    "  } " +
                    "})(30);";

                context.executeJavaScriptOnEDT(jsCode);
            });

            // Timeout handling (consistent with other permission requests: 5 minutes)
            CompletableFuture.delayedExecutor(PERMISSION_TIMEOUT_SECONDS, TimeUnit.SECONDS).execute(() -> {
                if (!future.isDone()) {
                    pendingPlanApprovalRequests.remove(requestId);
                    // Return rejection on timeout
                    JsonObject timeoutResponse = new JsonObject();
                    timeoutResponse.addProperty("approved", false);
                    timeoutResponse.addProperty("targetMode", "default");
                    timeoutResponse.addProperty("message", "Plan approval timed out");
                    future.complete(timeoutResponse);
                }
            });

        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][SHOW_DIALOG] ERROR: " + e.getMessage(), e);
            pendingPlanApprovalRequests.remove(requestId);
            JsonObject errorResponse = new JsonObject();
            errorResponse.addProperty("approved", false);
            errorResponse.addProperty("targetMode", "default");
            errorResponse.addProperty("message", "Error showing plan approval dialog");
            future.complete(errorResponse);
        }

        return future;
    }

    /**
     * Handle PlanApproval response messages from JavaScript.
     */
    private void handlePlanApprovalResponse(String jsonContent) {
        LOG.debug("[PLAN_APPROVAL][HANDLE_RESPONSE] Received response from JS: " + jsonContent);
        try {
            Gson gson = new Gson();
            JsonObject response = gson.fromJson(jsonContent, JsonObject.class);

            String requestId = response.get("requestId").getAsString();
            boolean approved = response.has("approved") && response.get("approved").getAsBoolean();
            String targetMode = response.has("targetMode") ? response.get("targetMode").getAsString() : "default";

            CompletableFuture<JsonObject> pendingFuture = pendingPlanApprovalRequests.remove(requestId);

            if (pendingFuture != null) {
                JsonObject result = new JsonObject();
                result.addProperty("approved", approved);
                result.addProperty("targetMode", targetMode);
                LOG.debug("[PLAN_APPROVAL][HANDLE_RESPONSE] Completing future: approved=" + approved + ", targetMode=" + targetMode);
                pendingFuture.complete(result);
            } else {
                LOG.warn("[PLAN_APPROVAL][HANDLE_RESPONSE] No pending request found for requestId: " + requestId);
            }
        } catch (Exception e) {
            LOG.error("[PLAN_APPROVAL][HANDLE_RESPONSE] ERROR: " + e.getMessage(), e);
        }
    }
}
