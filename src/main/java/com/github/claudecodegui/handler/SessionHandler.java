package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeSession;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import javax.swing.*;
import java.io.File;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * 会话管理消息处理器
 * 处理消息发送、中断、重启、新建会话等
 */
public class SessionHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(SessionHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "send_message",
        "send_message_with_attachments",
        "interrupt_session",
        "restart_session"
        // 注意：create_new_session 不应该在这里处理，应该由 ClaudeSDKToolWindow.createNewSession() 处理
    };

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
                LOG.debug("[SessionHandler] 处理: send_message");
                handleSendMessage(content);
                return true;
            case "send_message_with_attachments":
                LOG.debug("[SessionHandler] 处理: send_message_with_attachments");
                handleSendMessageWithAttachments(content);
                return true;
            case "interrupt_session":
                LOG.debug("[SessionHandler] 处理: interrupt_session");
                handleInterruptSession();
                return true;
            case "restart_session":
                LOG.debug("[SessionHandler] 处理: restart_session");
                handleRestartSession();
                return true;
            default:
                return false;
        }
    }

    /**
     * Send message to Claude
     */
    private void handleSendMessage(String prompt) {
        String nodeVersion = context.getClaudeSDKBridge().getCachedNodeVersion();
        if (nodeVersion == null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("addErrorMessage", escapeJs("未检测到有效的 Node.js 版本，请在设置中配置或重新打开工具窗口。"));
            });
            return;
        }
        if (!NodeDetector.isVersionSupported(nodeVersion)) {
            int minVersion = NodeDetector.MIN_NODE_MAJOR_VERSION;
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("addErrorMessage", escapeJs(
                    "Node.js 版本过低 (" + nodeVersion + ")，插件需要 v" + minVersion + " 或更高版本才能正常运行。请在设置中配置正确的 Node.js 路径。"));
            });
            return;
        }

        CompletableFuture.runAsync(() -> {
            String currentWorkingDir = determineWorkingDirectory();
            String previousCwd = context.getSession().getCwd();

            if (!currentWorkingDir.equals(previousCwd)) {
                context.getSession().setCwd(currentWorkingDir);
                LOG.info("[SessionHandler] Updated working directory: " + currentWorkingDir);
            }

            // Capture project for use in async callbacks
            var project = context.getProject();
            if (project != null) {
                ClaudeNotifier.setWaiting(project);
            }

            context.getSession().send(prompt)
                .thenRun(() -> {
                    if (project != null) {
                        ClaudeNotifier.showSuccess(project, "Task completed");
                    }
                })
                .exceptionally(ex -> {
                    LOG.error("Failed to send message", ex);
                    if (project != null) {
                        ClaudeNotifier.showError(project, "Task failed: " + ex.getMessage());
                    }
                    ApplicationManager.getApplication().invokeLater(() -> {
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
            LOG.error("[SessionHandler] 解析附件负载失败: " + e.getMessage(), e);
            handleSendMessage(content);
        }
    }

    /**
     * Send message with attachments to Claude
     */
    private void sendMessageWithAttachments(String prompt, List<ClaudeSession.Attachment> attachments) {
        // Version check (consistent with handleSendMessage)
        String nodeVersion = context.getClaudeSDKBridge().getCachedNodeVersion();
        if (nodeVersion == null) {
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("addErrorMessage", escapeJs("未检测到有效的 Node.js 版本，请在设置中配置或重新打开工具窗口。"));
            });
            return;
        }
        if (!NodeDetector.isVersionSupported(nodeVersion)) {
            int minVersion = NodeDetector.MIN_NODE_MAJOR_VERSION;
            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("addErrorMessage", escapeJs(
                    "Node.js 版本过低 (" + nodeVersion + ")，插件需要 v" + minVersion + " 或更高版本才能正常运行。请在设置中配置正确的 Node.js 路径。"));
            });
            return;
        }

        CompletableFuture.runAsync(() -> {
            String currentWorkingDir = determineWorkingDirectory();
            String previousCwd = context.getSession().getCwd();
            if (!currentWorkingDir.equals(previousCwd)) {
                context.getSession().setCwd(currentWorkingDir);
                LOG.info("[SessionHandler] Updated working directory: " + currentWorkingDir);
            }

            // Capture project for use in async callbacks
            var project = context.getProject();
            if (project != null) {
                ClaudeNotifier.setWaiting(project);
            }

            context.getSession().send(prompt, attachments)
                .thenRun(() -> {
                    if (project != null) {
                        ClaudeNotifier.showSuccess(project, "Task completed");
                    }
                })
                .exceptionally(ex -> {
                    LOG.error("Failed to send message with attachments", ex);
                    if (project != null) {
                        ClaudeNotifier.showError(project, "Task failed: " + ex.getMessage());
                    }
                    ApplicationManager.getApplication().invokeLater(() -> {
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
            ApplicationManager.getApplication().invokeLater(() -> {});
        });
    }

    /**
     * 重启会话
     */
    private void handleRestartSession() {
        context.getSession().restart().thenRun(() -> {
            ApplicationManager.getApplication().invokeLater(() -> {});
        });
    }

    /**
     * 确定合适的工作目录
     */
    private String determineWorkingDirectory() {
        String projectPath = context.getProject().getBasePath();

        // 如果项目路径无效，回退到用户主目录
        if (projectPath == null || !new File(projectPath).exists()) {
            String userHome = System.getProperty("user.home");
            LOG.warn("[SessionHandler] Using user home directory as fallback: " + userHome);
            return userHome;
        }

        // 尝试从配置中读取自定义工作目录
        try {
            com.github.claudecodegui.CodemossSettingsService settingsService =
                new com.github.claudecodegui.CodemossSettingsService();
            String customWorkingDir = settingsService.getCustomWorkingDirectory(projectPath);

            if (customWorkingDir != null && !customWorkingDir.isEmpty()) {
                // 如果是相对路径，拼接到项目根路径
                File workingDirFile = new File(customWorkingDir);
                if (!workingDirFile.isAbsolute()) {
                    workingDirFile = new File(projectPath, customWorkingDir);
                }

                // 验证目录是否存在
                if (workingDirFile.exists() && workingDirFile.isDirectory()) {
                    String resolvedPath = workingDirFile.getAbsolutePath();
                    LOG.info("[SessionHandler] Using custom working directory: " + resolvedPath);
                    return resolvedPath;
                } else {
                    LOG.warn("[SessionHandler] Custom working directory does not exist: " + workingDirFile.getAbsolutePath() + ", falling back to project root");
                }
            }
        } catch (Exception e) {
            LOG.warn("[SessionHandler] Failed to read custom working directory: " + e.getMessage());
        }

        // 默认使用项目根路径
        return projectPath;
    }
}
