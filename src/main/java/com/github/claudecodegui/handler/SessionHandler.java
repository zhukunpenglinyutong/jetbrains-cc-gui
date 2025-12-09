package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import javax.swing.*;
import java.io.File;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * 会话管理消息处理器
 * 处理消息发送、中断、重启、新建会话等
 */
public class SessionHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
        "send_message",
        "send_message_with_attachments",
        "interrupt_session",
        "restart_session",
        "create_new_session"
    };

    private static final Map<String, Integer> MODEL_CONTEXT_LIMITS = new java.util.HashMap<>();
    static {
        MODEL_CONTEXT_LIMITS.put("claude-sonnet-4-5", 200_000);
        MODEL_CONTEXT_LIMITS.put("claude-opus-4-5-20251101", 200_000);
    }

    public SessionHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "send_message":
                System.out.println("[SessionHandler] 处理: send_message");
                handleSendMessage(content);
                return true;
            case "send_message_with_attachments":
                System.out.println("[SessionHandler] 处理: send_message_with_attachments");
                handleSendMessageWithAttachments(content);
                return true;
            case "interrupt_session":
                System.out.println("[SessionHandler] 处理: interrupt_session");
                handleInterruptSession();
                return true;
            case "restart_session":
                System.out.println("[SessionHandler] 处理: restart_session");
                handleRestartSession();
                return true;
            case "create_new_session":
                System.out.println("[SessionHandler] 处理: create_new_session");
                handleCreateNewSession();
                return true;
            default:
                return false;
        }
    }

    /**
     * 发送消息到 Claude
     */
    private void handleSendMessage(String prompt) {
        CompletableFuture.runAsync(() -> {
            String currentWorkingDir = determineWorkingDirectory();
            String previousCwd = context.getSession().getCwd();

            if (!currentWorkingDir.equals(previousCwd)) {
                context.getSession().setCwd(currentWorkingDir);
                System.out.println("[SessionHandler] Updated working directory: " + currentWorkingDir);
            }

            context.getSession().setPermissionMode("default");

            context.getSession().send(prompt).exceptionally(ex -> {
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("addErrorMessage", escapeJs("发送失败: " + ex.getMessage()));
                });
                return null;
            });
        });
    }

    /**
     * 发送带附件的消息
     */
    private void handleSendMessageWithAttachments(String content) {
        try {
            Gson gson = new Gson();
            JsonObject payload = gson.fromJson(content, JsonObject.class);
            String text = payload != null && payload.has("text") && !payload.get("text").isJsonNull()
                ? payload.get("text").getAsString()
                : "";

            java.util.List<ClaudeSession.Attachment> atts = new java.util.ArrayList<>();
            if (payload != null && payload.has("attachments") && payload.get("attachments").isJsonArray()) {
                JsonArray arr = payload.getAsJsonArray("attachments");
                for (int i = 0; i < arr.size(); i++) {
                    JsonObject a = arr.get(i).getAsJsonObject();
                    String fileName = a.has("fileName") && !a.get("fileName").isJsonNull()
                        ? a.get("fileName").getAsString()
                        : ("attachment-" + System.currentTimeMillis());
                    String mediaType = a.has("mediaType") && !a.get("mediaType").isJsonNull()
                        ? a.get("mediaType").getAsString()
                        : "application/octet-stream";
                    String data = a.has("data") && !a.get("data").isJsonNull()
                        ? a.get("data").getAsString()
                        : "";
                    atts.add(new ClaudeSession.Attachment(fileName, mediaType, data));
                }
            }
            sendMessageWithAttachments(text, atts);
        } catch (Exception e) {
            System.err.println("[SessionHandler] 解析附件负载失败: " + e.getMessage());
            handleSendMessage(content);
        }
    }

    /**
     * 发送带附件的消息到 Claude
     */
    private void sendMessageWithAttachments(String prompt, List<ClaudeSession.Attachment> attachments) {
        CompletableFuture.runAsync(() -> {
            String currentWorkingDir = determineWorkingDirectory();
            String previousCwd = context.getSession().getCwd();
            if (!currentWorkingDir.equals(previousCwd)) {
                context.getSession().setCwd(currentWorkingDir);
                System.out.println("[SessionHandler] Updated working directory: " + currentWorkingDir);
            }

            context.getSession().setPermissionMode("default");

            context.getSession().send(prompt, attachments).exceptionally(ex -> {
                SwingUtilities.invokeLater(() -> {
                    callJavaScript("addErrorMessage", escapeJs("发送失败: " + ex.getMessage()));
                });
                return null;
            });
        });
    }

    /**
     * 中断会话
     */
    private void handleInterruptSession() {
        context.getSession().interrupt().thenRun(() -> {
            SwingUtilities.invokeLater(() -> {});
        });
    }

    /**
     * 重启会话
     */
    private void handleRestartSession() {
        context.getSession().restart().thenRun(() -> {
            SwingUtilities.invokeLater(() -> {});
        });
    }

    /**
     * 创建新会话
     */
    private void handleCreateNewSession() {
        System.out.println("Creating new session...");

        // 创建新会话需要通过回调通知主类
        // 这里发送一个事件让主类处理
        SwingUtilities.invokeLater(() -> {
            callJavaScript("updateStatus", escapeJs("新会话已创建，可以开始提问"));

            int maxTokens = MODEL_CONTEXT_LIMITS.getOrDefault(context.getCurrentModel(), 200_000);
            Gson gson = new Gson();
            JsonObject usageUpdate = new JsonObject();
            usageUpdate.addProperty("percentage", 0);
            usageUpdate.addProperty("totalTokens", 0);
            usageUpdate.addProperty("limit", maxTokens);
            usageUpdate.addProperty("usedTokens", 0);
            usageUpdate.addProperty("maxTokens", maxTokens);
            String usageJson = gson.toJson(usageUpdate);

            String js = "if (window.onUsageUpdate) { window.onUsageUpdate('" + escapeJs(usageJson) + "'); }";
            context.executeJavaScriptOnEDT(js);
        });
    }

    /**
     * 确定合适的工作目录
     */
    private String determineWorkingDirectory() {
        String projectPath = context.getProject().getBasePath();
        if (projectPath != null && new File(projectPath).exists()) {
            return projectPath;
        }
        return System.getProperty("user.home");
    }

    /**
     * 获取模型上下文限制
     */
    public static int getModelContextLimit(String model) {
        return MODEL_CONTEXT_LIMITS.getOrDefault(model, 200_000);
    }
}
