package com.github.claudecodegui.handler;

import com.github.claudecodegui.permission.PermissionRequest;
import com.github.claudecodegui.permission.PermissionService;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
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

    private static final String[] SUPPORTED_TYPES = {
        "permission_decision"
    };

    // 权限请求映射
    private final Map<String, CompletableFuture<Integer>> pendingPermissionRequests = new ConcurrentHashMap<>();

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
            System.out.println("[PERM_DEBUG][BRIDGE_RECV] Received permission_decision from JS");
            System.out.println("[PERM_DEBUG][BRIDGE_RECV] Content: " + content);
            handlePermissionDecision(content);
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

        System.out.println("[PERM_DEBUG][FRONTEND_DIALOG] Starting showFrontendPermissionDialog");
        System.out.println("[PERM_DEBUG][FRONTEND_DIALOG] channelId=" + channelId + ", toolName=" + toolName);

        pendingPermissionRequests.put(channelId, future);

        try {
            Gson gson = new Gson();
            JsonObject requestData = new JsonObject();
            requestData.addProperty("channelId", channelId);
            requestData.addProperty("toolName", toolName);
            requestData.add("inputs", inputs);

            String requestJson = gson.toJson(requestData);
            String escapedJson = escapeJs(requestJson);

            SwingUtilities.invokeLater(() -> {
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

            // 超时处理
            CompletableFuture.delayedExecutor(35, TimeUnit.SECONDS).execute(() -> {
                if (!future.isDone()) {
                    pendingPermissionRequests.remove(channelId);
                    future.complete(PermissionService.PermissionResponse.DENY.getValue());
                }
            });

        } catch (Exception e) {
            System.err.println("[PERM_DEBUG][FRONTEND_DIALOG] ERROR: " + e.getMessage());
            pendingPermissionRequests.remove(channelId);
            future.complete(PermissionService.PermissionResponse.DENY.getValue());
        }

        return future;
    }

    /**
     * 显示权限请求对话框（来自 PermissionRequest）
     */
    public void showPermissionDialog(PermissionRequest request) {
        System.out.println("[PermissionHandler] 显示权限请求对话框: " + request.getToolName());

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
                System.err.println("[PermissionHandler] 警告: PermissionRequest 没有关联的 Project，使用当前 context 的窗口");
                targetProject = this.context.getProject();
            }

            // 获取目标项目的窗口实例
            com.github.claudecodegui.ClaudeSDKToolWindow.ClaudeChatWindow targetWindow =
                com.github.claudecodegui.ClaudeSDKToolWindow.getChatWindow(targetProject);

            if (targetWindow == null) {
                System.err.println("[PermissionHandler] 错误: 找不到项目 " + targetProject.getName() + " 的窗口实例");
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
            System.err.println("[PermissionHandler] 显示权限弹窗失败: " + e.getMessage());
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
        System.out.println("[PERM_DEBUG][HANDLE_DECISION] Received decision from JS: " + jsonContent);
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

            CompletableFuture<Integer> pendingFuture = pendingPermissionRequests.remove(channelId);

            if (pendingFuture != null) {
                int responseValue;
                if (allow) {
                    responseValue = remember ?
                        PermissionService.PermissionResponse.ALLOW_ALWAYS.getValue() :
                        PermissionService.PermissionResponse.ALLOW.getValue();
                } else {
                    responseValue = PermissionService.PermissionResponse.DENY.getValue();
                }
                pendingFuture.complete(responseValue);

                if (!allow) {
                    notifyPermissionDenied();
                }
            } else {
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
            System.err.println("[PERM_DEBUG][HANDLE_DECISION] ERROR: " + e.getMessage());
            e.printStackTrace();
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
}
