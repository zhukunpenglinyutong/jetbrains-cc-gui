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
 * 权限处理器
 * 处理权限对话框显示和决策
 */
public class PermissionHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(PermissionHandler.class);

    // 权限请求超时时间（5 分钟），与 Node 端 PERMISSION_TIMEOUT_MS 保持一致
    private static final long PERMISSION_TIMEOUT_SECONDS = 300;

    private static final String[] SUPPORTED_TYPES = {
        "permission_decision",
        "ask_user_question_response",
        "plan_approval_response"
    };

    // 权限请求映射
    private final Map<String, CompletableFuture<Integer>> pendingPermissionRequests = new ConcurrentHashMap<>();

    // AskUserQuestion 请求映射 (requestId -> CompletableFuture<JsonObject>)
    private final Map<String, CompletableFuture<JsonObject>> pendingAskUserQuestionRequests = new ConcurrentHashMap<>();

    // PlanApproval 请求映射 (requestId -> CompletableFuture<JsonObject>)
    private final Map<String, CompletableFuture<JsonObject>> pendingPlanApprovalRequests = new ConcurrentHashMap<>();

    // 权限拒绝回调
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
     * 显示前端权限对话框
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

            // 超时处理（让用户有足够时间查看上下文）
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
     * 显示权限请求对话框（来自 PermissionRequest）
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

            // 获取权限请求所属的项目
            Project targetProject = request.getProject();
            if (targetProject == null) {
                LOG.warn("[PermissionHandler] 警告: PermissionRequest 没有关联的 Project，使用当前 context 的窗口");
                targetProject = this.context.getProject();
            }

            // 获取目标项目的窗口实例
            com.github.claudecodegui.ClaudeSDKToolWindow.ClaudeChatWindow targetWindow =
                com.github.claudecodegui.ClaudeSDKToolWindow.getChatWindow(targetProject);

            if (targetWindow == null) {
                LOG.error("[PermissionHandler] 错误: 找不到项目 " + targetProject.getName() + " 的窗口实例");
                // 如果找不到目标窗口，拒绝权限请求
                this.context.getSession().handlePermissionDecision(
                    request.getChannelId(),
                    false,
                    false,
                    "Failed to show permission dialog: window not found"
                );
                notifyPermissionDenied();
                return;
            }

            // 在目标窗口中执行 JavaScript 显示弹窗
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
     * 处理来自 JavaScript 的权限决策消息
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
                // 处理来自 Session 的权限请求
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
     * 通知权限被拒绝
     */
    private void notifyPermissionDenied() {
        if (deniedCallback != null) {
            deniedCallback.onPermissionDenied();
        }
    }

    /**
     * 清理所有待处理的权限请求
     * 在会话切换或历史恢复时调用，避免旧的请求干扰新会话
     */
    public void clearPendingRequests() {
        LOG.info("[PERM_CLEAR] Clearing all pending permission requests");

        int permissionCount = pendingPermissionRequests.size();
        int askUserCount = pendingAskUserQuestionRequests.size();
        int planCount = pendingPlanApprovalRequests.size();

        // 取消所有待处理的权限请求
        for (Map.Entry<String, CompletableFuture<Integer>> entry : pendingPermissionRequests.entrySet()) {
            entry.getValue().complete(PermissionService.PermissionResponse.DENY.getValue());
        }
        pendingPermissionRequests.clear();

        // 取消所有待处理的 AskUserQuestion 请求
        for (Map.Entry<String, CompletableFuture<JsonObject>> entry : pendingAskUserQuestionRequests.entrySet()) {
            entry.getValue().complete(null);
        }
        pendingAskUserQuestionRequests.clear();

        // 取消所有待处理的 PlanApproval 请求
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
     * 显示 AskUserQuestion 对话框（实现 PermissionService.AskUserQuestionDialogShower 接口）
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

            // 超时处理（60秒）
            CompletableFuture.delayedExecutor(60, TimeUnit.SECONDS).execute(() -> {
                if (!future.isDone()) {
                    pendingAskUserQuestionRequests.remove(requestId);
                    // 超时返回空答案
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
     * 处理来自 JavaScript 的 AskUserQuestion 响应消息
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
     * 显示 PlanApproval 对话框（实现 PermissionService.PlanApprovalDialogShower 接口）
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

            // 超时处理（300秒，因为计划审核可能需要更长时间）
            CompletableFuture.delayedExecutor(300, TimeUnit.SECONDS).execute(() -> {
                if (!future.isDone()) {
                    pendingPlanApprovalRequests.remove(requestId);
                    // 超时返回拒绝
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
     * 处理来自 JavaScript 的 PlanApproval 响应消息
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
