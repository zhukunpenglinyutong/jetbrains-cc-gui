package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeHistoryReader;
import com.github.claudecodegui.util.JsUtils;

import javax.swing.*;
import java.util.concurrent.CompletableFuture;

/**
 * 历史数据处理器
 * 处理历史数据加载和会话加载
 */
public class HistoryHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
        "load_history_data",
        "load_session",
        "delete_session",  // 新增:删除会话
        "export_session"   // 新增:导出会话
    };

    // 会话加载回调接口
    public interface SessionLoadCallback {
        void onLoadSession(String sessionId, String projectPath);
    }

    private SessionLoadCallback sessionLoadCallback;

    public HistoryHandler(HandlerContext context) {
        super(context);
    }

    public void setSessionLoadCallback(SessionLoadCallback callback) {
        this.sessionLoadCallback = callback;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "load_history_data":
                System.out.println("[HistoryHandler] 处理: load_history_data");
                handleLoadHistoryData();
                return true;
            case "load_session":
                System.out.println("[HistoryHandler] 处理: load_session");
                handleLoadSession(content);
                return true;
            case "delete_session":
                System.out.println("[HistoryHandler] 处理: delete_session, sessionId=" + content);
                handleDeleteSession(content);
                return true;
            case "export_session":
                System.out.println("[HistoryHandler] 处理: export_session, sessionId=" + content);
                handleExportSession(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * 加载并注入历史数据到前端
     */
    private void handleLoadHistoryData() {
        CompletableFuture.runAsync(() -> {
            System.out.println("[HistoryHandler] ========== 开始加载历史数据 ==========");

            try {
                String projectPath = context.getProject().getBasePath();
                ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                String historyJson = historyReader.getProjectDataAsJson(projectPath);

                String escapedJson = escapeJs(historyJson);

                SwingUtilities.invokeLater(() -> {
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject history data');" +
                        "if (window.setHistoryData) { " +
                        "  try { " +
                        "    var jsonStr = '" + escapedJson + "'; " +
                        "    var data = JSON.parse(jsonStr); " +
                        "    window.setHistoryData(data); " +
                        "  } catch(e) { " +
                        "    console.error('[Backend->Frontend] Failed to parse/set history data:', e); " +
                        "    window.setHistoryData({ success: false, error: '解析历史数据失败: ' + e.message }); " +
                        "  } " +
                        "} else { " +
                        "  console.error('[Backend->Frontend] setHistoryData not available!'); " +
                        "}";

                    context.executeJavaScriptOnEDT(jsCode);
                });

            } catch (Exception e) {
                System.err.println("[HistoryHandler] ❌ 加载历史数据失败: " + e.getMessage());
                e.printStackTrace();

                SwingUtilities.invokeLater(() -> {
                    String errorMsg = escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "if (window.setHistoryData) { " +
                        "  window.setHistoryData({ success: false, error: '" + errorMsg + "' }); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }

    /**
     * 加载历史会话
     */
    private void handleLoadSession(String sessionId) {
        String projectPath = context.getProject().getBasePath();
        System.out.println("[HistoryHandler] Loading history session: " + sessionId + " from project: " + projectPath);

        if (sessionLoadCallback != null) {
            sessionLoadCallback.onLoadSession(sessionId, projectPath);
        } else {
            System.err.println("[HistoryHandler] WARNING: No session load callback set");
        }
    }

    /**
     * 删除会话历史文件
     * 删除指定 sessionId 的 .jsonl 文件以及相关的 agent-xxx.jsonl 文件
     */
    private void handleDeleteSession(String sessionId) {
        CompletableFuture.runAsync(() -> {
            try {
                String projectPath = context.getProject().getBasePath();
                System.out.println("[HistoryHandler] ========== 开始删除会话 ==========");
                System.out.println("[HistoryHandler] SessionId: " + sessionId);
                System.out.println("[HistoryHandler] ProjectPath: " + projectPath);

                // 使用 ClaudeHistoryReader 的逻辑获取项目会话目录
                String homeDir = System.getProperty("user.home");
                java.nio.file.Path claudeDir = java.nio.file.Paths.get(homeDir, ".claude");
                java.nio.file.Path projectsDir = claudeDir.resolve("projects");

                // 规范化项目路径(与 ClaudeHistoryReader 保持一致)
                String sanitizedPath = com.github.claudecodegui.util.PathUtils.sanitizePath(projectPath);
                java.nio.file.Path projectDir = projectsDir.resolve(sanitizedPath);

                System.out.println("[HistoryHandler] 会话目录: " + projectDir);

                if (!java.nio.file.Files.exists(projectDir)) {
                    System.err.println("[HistoryHandler] ❌ 项目目录不存在: " + projectDir);
                    return;
                }

                // 删除主会话文件
                java.nio.file.Path mainSessionFile = projectDir.resolve(sessionId + ".jsonl");
                boolean mainDeleted = false;

                if (java.nio.file.Files.exists(mainSessionFile)) {
                    java.nio.file.Files.delete(mainSessionFile);
                    System.out.println("[HistoryHandler] ✅ 已删除主会话文件: " + mainSessionFile.getFileName());
                    mainDeleted = true;
                } else {
                    System.out.println("[HistoryHandler] ⚠️ 主会话文件不存在: " + mainSessionFile.getFileName());
                }

                // 删除相关的 agent 文件
                // 遍历项目目录,查找所有可能相关的 agent 文件
                // agent 文件通常命名为 agent-<uuid>.jsonl
                int agentFilesDeleted = 0;

                try (java.util.stream.Stream<java.nio.file.Path> stream = java.nio.file.Files.list(projectDir)) {
                    java.util.List<java.nio.file.Path> agentFiles = stream
                        .filter(path -> {
                            String filename = path.getFileName().toString();
                            // 匹配 agent-*.jsonl 文件
                            // 注意:这里删除所有 agent 文件,如果需要更精确的匹配,可以根据实际情况调整
                            return filename.startsWith("agent-") && filename.endsWith(".jsonl");
                        })
                        .collect(java.util.stream.Collectors.toList());

                    for (java.nio.file.Path agentFile : agentFiles) {
                        try {
                            java.nio.file.Files.delete(agentFile);
                            System.out.println("[HistoryHandler] ✅ 已删除关联 agent 文件: " + agentFile.getFileName());
                            agentFilesDeleted++;
                        } catch (Exception e) {
                            System.err.println("[HistoryHandler] ❌ 删除 agent 文件失败: " + agentFile.getFileName() + " - " + e.getMessage());
                        }
                    }
                }

                System.out.println("[HistoryHandler] ========== 删除会话完成 ==========");
                System.out.println("[HistoryHandler] 主会话文件: " + (mainDeleted ? "已删除" : "未找到"));
                System.out.println("[HistoryHandler] Agent 文件: 删除了 " + agentFilesDeleted + " 个");

            } catch (Exception e) {
                System.err.println("[HistoryHandler] ❌ 删除会话失败: " + e.getMessage());
                e.printStackTrace();
            }
        });
    }

    /**
     * 导出会话数据
     * 读取会话的所有消息并返回给前端
     */
    private void handleExportSession(String sessionId) {
        CompletableFuture.runAsync(() -> {
            System.out.println("[HistoryHandler] ========== 开始导出会话 ==========");

            try {
                String projectPath = context.getProject().getBasePath();
                System.out.println("[HistoryHandler] SessionId: " + sessionId);
                System.out.println("[HistoryHandler] ProjectPath: " + projectPath);

                ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                String messagesJson = historyReader.getSessionMessagesAsJson(projectPath, sessionId);

                System.out.println("[HistoryHandler] 读取到会话消息，准备注入到前端");

                String escapedJson = escapeJs(messagesJson);

                SwingUtilities.invokeLater(() -> {
                    String jsCode = "console.log('[Backend->Frontend] Starting to inject export data');" +
                        "if (window.onExportSessionData) { " +
                        "  try { " +
                        "    var jsonStr = '" + escapedJson + "'; " +
                        "    window.onExportSessionData(jsonStr); " +
                        "    console.log('[Backend->Frontend] Export data injected successfully'); " +
                        "  } catch(e) { " +
                        "    console.error('[Backend->Frontend] Failed to inject export data:', e); " +
                        "  } " +
                        "} else { " +
                        "  console.error('[Backend->Frontend] onExportSessionData not available!'); " +
                        "}";

                    context.executeJavaScriptOnEDT(jsCode);
                });

                System.out.println("[HistoryHandler] ========== 导出会话完成 ==========");

            } catch (Exception e) {
                System.err.println("[HistoryHandler] ❌ 导出会话失败: " + e.getMessage());
                e.printStackTrace();

                SwingUtilities.invokeLater(() -> {
                    String jsCode = "if (window.addToast) { " +
                        "  window.addToast('导出失败: " + escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误") + "', 'error'); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }
}
