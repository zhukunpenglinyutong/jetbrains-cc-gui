package com.github.claudecodegui.handler;

import com.github.claudecodegui.ClaudeHistoryReader;
import com.github.claudecodegui.util.JsUtils;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import javax.swing.*;
import java.util.concurrent.CompletableFuture;

/**
 * 历史数据处理器
 * 处理历史数据加载和会话加载
 */
public class HistoryHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(HistoryHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "load_history_data",
        "load_session",
        "delete_session",  // 新增:删除会话
        "export_session",  // 新增:导出会话
        "toggle_favorite", // 新增:切换收藏状态
        "update_title"     // 新增:更新会话标题
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
                LOG.debug("[HistoryHandler] 处理: load_history_data");
                handleLoadHistoryData();
                return true;
            case "load_session":
                LOG.debug("[HistoryHandler] 处理: load_session");
                handleLoadSession(content);
                return true;
            case "delete_session":
                LOG.info("[HistoryHandler] 处理: delete_session, sessionId=" + content);
                handleDeleteSession(content);
                return true;
            case "export_session":
                LOG.info("[HistoryHandler] 处理: export_session, sessionId=" + content);
                handleExportSession(content);
                return true;
            case "toggle_favorite":
                LOG.info("[HistoryHandler] 处理: toggle_favorite, sessionId=" + content);
                handleToggleFavorite(content);
                return true;
            case "update_title":
                LOG.info("[HistoryHandler] 处理: update_title");
                handleUpdateTitle(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * 加载并注入历史数据到前端（包含收藏信息）
     */
    private void handleLoadHistoryData() {
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始加载历史数据 ==========");

            try {
                String projectPath = context.getProject().getBasePath();
                ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                String historyJson = historyReader.getProjectDataAsJson(projectPath);

                // 加载收藏数据并合并到历史数据中
                String enhancedJson = enhanceHistoryWithFavorites(historyJson);

                // 加载自定义标题并合并到历史数据中
                String finalJson = enhanceHistoryWithTitles(enhancedJson);

                String escapedJson = escapeJs(finalJson);

                ApplicationManager.getApplication().invokeLater(() -> {
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
                LOG.error("[HistoryHandler] ❌ 加载历史数据失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> {
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
        LOG.info("[HistoryHandler] Loading history session: " + sessionId + " from project: " + projectPath);

        if (sessionLoadCallback != null) {
            sessionLoadCallback.onLoadSession(sessionId, projectPath);
        } else {
            LOG.warn("[HistoryHandler] WARNING: No session load callback set");
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
                LOG.info("[HistoryHandler] ========== 开始删除会话 ==========");
                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] ProjectPath: " + projectPath);

                // 使用 ClaudeHistoryReader 的逻辑获取项目会话目录
                String homeDir = System.getProperty("user.home");
                java.nio.file.Path claudeDir = java.nio.file.Paths.get(homeDir, ".claude");
                java.nio.file.Path projectsDir = claudeDir.resolve("projects");

                // 规范化项目路径(与 ClaudeHistoryReader 保持一致)
                String sanitizedPath = com.github.claudecodegui.util.PathUtils.sanitizePath(projectPath);
                java.nio.file.Path projectDir = projectsDir.resolve(sanitizedPath);

                LOG.info("[HistoryHandler] 会话目录: " + projectDir);

                if (!java.nio.file.Files.exists(projectDir)) {
                    LOG.error("[HistoryHandler] ❌ 项目目录不存在: " + projectDir);
                    return;
                }

                // 删除主会话文件
                java.nio.file.Path mainSessionFile = projectDir.resolve(sessionId + ".jsonl");
                boolean mainDeleted = false;

                if (java.nio.file.Files.exists(mainSessionFile)) {
                    java.nio.file.Files.delete(mainSessionFile);
                    LOG.info("[HistoryHandler] ✅ 已删除主会话文件: " + mainSessionFile.getFileName());
                    mainDeleted = true;
                } else {
                    LOG.warn("[HistoryHandler] ⚠️ 主会话文件不存在: " + mainSessionFile.getFileName());
                }

                // 删除相关的 agent 文件
                // 遍历项目目录,查找所有可能相关的 agent 文件
                // agent 文件通常命名为 agent-<uuid>.jsonl
                int agentFilesDeleted = 0;

                try (java.util.stream.Stream<java.nio.file.Path> stream = java.nio.file.Files.list(projectDir)) {
                    java.util.List<java.nio.file.Path> agentFiles = stream
                        .filter(path -> {
                            String filename = path.getFileName().toString();
                            // 匹配 agent-*.jsonl 文件，并且需要属于当前会话
                            if (!filename.startsWith("agent-") || !filename.endsWith(".jsonl")) {
                                return false;
                            }

                            // 检查agent文件是否属于当前会话
                            // 通过读取文件内容查找sessionId引用
                            return isAgentFileRelatedToSession(path, sessionId);
                        })
                        .collect(java.util.stream.Collectors.toList());

                    for (java.nio.file.Path agentFile : agentFiles) {
                        try {
                            java.nio.file.Files.delete(agentFile);
                            LOG.info("[HistoryHandler] ✅ 已删除关联 agent 文件: " + agentFile.getFileName());
                            agentFilesDeleted++;
                        } catch (Exception e) {
                            LOG.error("[HistoryHandler] ❌ 删除 agent 文件失败: " + agentFile.getFileName() + " - " + e.getMessage(), e);
                        }
                    }
                }

                LOG.info("[HistoryHandler] ========== 删除会话完成 ==========");
                LOG.info("[HistoryHandler] 主会话文件: " + (mainDeleted ? "已删除" : "未找到"));
                LOG.info("[HistoryHandler] Agent 文件: 删除了 " + agentFilesDeleted + " 个");

                // 删除完成后，重新加载历史数据并推送给前端
                LOG.info("[HistoryHandler] 重新加载历史数据...");
                handleLoadHistoryData();

            } catch (Exception e) {
                LOG.error("[HistoryHandler] ❌ 删除会话失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 导出会话数据
     * 读取会话的所有消息并返回给前端
     */
    private void handleExportSession(String content) {
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始导出会话 ==========");

            try {
                // 解析前端传来的JSON，获取 sessionId 和 title
                com.google.gson.JsonObject exportRequest = new com.google.gson.Gson().fromJson(content, com.google.gson.JsonObject.class);
                String sessionId = exportRequest.get("sessionId").getAsString();
                String title = exportRequest.get("title").getAsString();

                String projectPath = context.getProject().getBasePath();
                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] Title: " + title);
                LOG.info("[HistoryHandler] ProjectPath: " + projectPath);

                ClaudeHistoryReader historyReader = new ClaudeHistoryReader();
                String messagesJson = historyReader.getSessionMessagesAsJson(projectPath, sessionId);

                // 将消息包装到包含 sessionId 和 title 的对象中
                com.google.gson.JsonObject exportData = new com.google.gson.JsonObject();
                exportData.addProperty("sessionId", sessionId);
                exportData.addProperty("title", title);
                exportData.add("messages", com.google.gson.JsonParser.parseString(messagesJson));

                String wrappedJson = new com.google.gson.Gson().toJson(exportData);

                LOG.info("[HistoryHandler] 读取到会话消息，准备注入到前端");

                String escapedJson = escapeJs(wrappedJson);

                ApplicationManager.getApplication().invokeLater(() -> {
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

                LOG.info("[HistoryHandler] ========== 导出会话完成 ==========");

            } catch (Exception e) {
                LOG.error("[HistoryHandler] ❌ 导出会话失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "if (window.addToast) { " +
                        "  window.addToast('导出失败: " + escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误") + "', 'error'); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }

    /**
     * 切换收藏状态
     */
    private void handleToggleFavorite(String sessionId) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 切换收藏状态 ==========");
                LOG.info("[HistoryHandler] SessionId: " + sessionId);

                // 调用 Node.js favorites-service 切换收藏状态
                String result = callNodeJsFavoritesService("toggleFavorite", sessionId);
                LOG.info("[HistoryHandler] 收藏状态切换结果: " + result);

            } catch (Exception e) {
                LOG.error("[HistoryHandler] ❌ 切换收藏状态失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * 更新会话标题
     */
    private void handleUpdateTitle(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 更新会话标题 ==========");

                // 解析前端传来的JSON，获取 sessionId 和 customTitle
                com.google.gson.JsonObject request = new com.google.gson.Gson().fromJson(content, com.google.gson.JsonObject.class);
                String sessionId = request.get("sessionId").getAsString();
                String customTitle = request.get("customTitle").getAsString();

                LOG.info("[HistoryHandler] SessionId: " + sessionId);
                LOG.info("[HistoryHandler] CustomTitle: " + customTitle);

                // 调用 Node.js session-titles-service 更新标题
                String result = callNodeJsTitlesServiceWithParams("updateTitle", sessionId, customTitle);
                LOG.info("[HistoryHandler] 标题更新结果: " + result);

                // 解析结果
                com.google.gson.JsonObject resultObj = new com.google.gson.Gson().fromJson(result, com.google.gson.JsonObject.class);
                boolean success = resultObj.get("success").getAsBoolean();

                if (!success && resultObj.has("error")) {
                    String error = resultObj.get("error").getAsString();
                    ApplicationManager.getApplication().invokeLater(() -> {
                        String jsCode = "if (window.addToast) { " +
                            "  window.addToast('更新标题失败: " + escapeJs(error) + "', 'error'); " +
                            "}";
                        context.executeJavaScriptOnEDT(jsCode);
                    });
                }

            } catch (Exception e) {
                LOG.error("[HistoryHandler] ❌ 更新标题失败: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    String jsCode = "if (window.addToast) { " +
                        "  window.addToast('更新标题失败: " + escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误") + "', 'error'); " +
                        "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
            }
        });
    }

    /**
     * 增强历史数据：添加收藏信息到每个会话
     */
    private String enhanceHistoryWithFavorites(String historyJson) {
        try {
            // 加载收藏数据
            String favoritesJson = callNodeJsFavoritesService("loadFavorites", "");

            // 解析历史数据和收藏数据
            com.google.gson.JsonObject history = new com.google.gson.Gson().fromJson(historyJson, com.google.gson.JsonObject.class);
            com.google.gson.JsonObject favorites = new com.google.gson.Gson().fromJson(favoritesJson, com.google.gson.JsonObject.class);

            // 为每个会话添加收藏信息
            if (history.has("sessions") && history.get("sessions").isJsonArray()) {
                com.google.gson.JsonArray sessions = history.getAsJsonArray("sessions");
                for (int i = 0; i < sessions.size(); i++) {
                    com.google.gson.JsonObject session = sessions.get(i).getAsJsonObject();
                    String sessionId = session.get("sessionId").getAsString();

                    if (favorites.has(sessionId)) {
                        com.google.gson.JsonObject favoriteInfo = favorites.getAsJsonObject(sessionId);
                        session.addProperty("isFavorited", true);
                        session.addProperty("favoritedAt", favoriteInfo.get("favoritedAt").getAsLong());
                    } else {
                        session.addProperty("isFavorited", false);
                    }
                }
            }

            // 将收藏数据也添加到历史数据中
            history.add("favorites", favorites);

            return new com.google.gson.Gson().toJson(history);

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] ⚠️ 增强历史数据失败，返回原始数据: " + e.getMessage());
            return historyJson;
        }
    }

    /**
     * 增强历史数据：添加自定义标题到每个会话
     */
    private String enhanceHistoryWithTitles(String historyJson) {
        try {
            // 加载标题数据
            String titlesJson = callNodeJsTitlesService("loadTitles", "", "");

            // 解析历史数据和标题数据
            com.google.gson.JsonObject history = new com.google.gson.Gson().fromJson(historyJson, com.google.gson.JsonObject.class);
            com.google.gson.JsonObject titles = new com.google.gson.Gson().fromJson(titlesJson, com.google.gson.JsonObject.class);

            // 为每个会话添加自定义标题
            if (history.has("sessions") && history.get("sessions").isJsonArray()) {
                com.google.gson.JsonArray sessions = history.getAsJsonArray("sessions");
                for (int i = 0; i < sessions.size(); i++) {
                    com.google.gson.JsonObject session = sessions.get(i).getAsJsonObject();
                    String sessionId = session.get("sessionId").getAsString();

                    if (titles.has(sessionId)) {
                        com.google.gson.JsonObject titleInfo = titles.getAsJsonObject(sessionId);
                        // 如果有自定义标题，则覆盖原始标题
                        if (titleInfo.has("customTitle")) {
                            String customTitle = titleInfo.get("customTitle").getAsString();
                            session.addProperty("title", customTitle);
                            session.addProperty("hasCustomTitle", true);
                        }
                    }
                }
            }

            return new com.google.gson.Gson().toJson(history);

        } catch (Exception e) {
            LOG.warn("[HistoryHandler] ⚠️ 增强标题数据失败，返回原始数据: " + e.getMessage());
            return historyJson;
        }
    }

    /**
     * 调用 Node.js favorites-service
     */
    private String callNodeJsFavoritesService(String functionName, String sessionId) throws Exception {
        // 获取 ai-bridge 路径
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // 构建 Node.js 命令
        String nodeScript = String.format(
            "const { %s } = require('%s/services/favorites-service.cjs'); " +
            "const result = %s('%s'); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName,
            sessionId
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // 读取输出
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // 返回最后一行（JSON 输出）
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * 调用 Node.js session-titles-service（无参数版本，用于 loadTitles）
     */
    private String callNodeJsTitlesService(String functionName, String dummy1, String dummy2) throws Exception {
        // 获取 ai-bridge 路径
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // 构建 Node.js 命令（loadTitles 不需要参数）
        String nodeScript = String.format(
            "const { %s } = require('%s/services/session-titles-service.cjs'); " +
            "const result = %s(); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // 读取输出
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // 返回最后一行（JSON 输出）
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * 调用 Node.js session-titles-service（带参数版本，用于 updateTitle）
     */
    private String callNodeJsTitlesServiceWithParams(String functionName, String sessionId, String customTitle) throws Exception {
        // 获取 ai-bridge 路径
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        // 转义特殊字符
        String escapedTitle = customTitle.replace("\\", "\\\\").replace("'", "\\'");

        // 构建 Node.js 命令
        String nodeScript = String.format(
            "const { %s } = require('%s/services/session-titles-service.cjs'); " +
            "const result = %s('%s', '%s'); " +
            "console.log(JSON.stringify(result));",
            functionName,
            bridgePath.replace("\\", "\\\\"),
            functionName,
            sessionId,
            escapedTitle
        );

        ProcessBuilder pb = new ProcessBuilder(nodePath, "-e", nodeScript);
        pb.redirectErrorStream(true);

        Process process = pb.start();

        // 读取输出
        StringBuilder output = new StringBuilder();
        try (java.io.BufferedReader reader = new java.io.BufferedReader(
                new java.io.InputStreamReader(process.getInputStream()))) {
            String line;
            while ((line = reader.readLine()) != null) {
                output.append(line).append("\n");
            }
        }

        int exitCode = process.waitFor();
        if (exitCode != 0) {
            throw new Exception("Node.js process exited with code " + exitCode + ": " + output.toString());
        }

        // 返回最后一行（JSON 输出）
        String[] lines = output.toString().split("\n");
        return lines.length > 0 ? lines[lines.length - 1] : "{}";
    }

    /**
     * 检查agent文件是否属于指定的会话
     * 通过读取文件内容查找sessionId引用
     */
    private boolean isAgentFileRelatedToSession(java.nio.file.Path agentFilePath, String sessionId) {
        try (java.io.BufferedReader reader = java.nio.file.Files.newBufferedReader(agentFilePath)) {
            String line;
            int lineCount = 0;
            // 只读取前20行以提高性能（通常sessionId会在文件开头）
            while ((line = reader.readLine()) != null && lineCount < 20) {
                // 检查这一行是否包含sessionId
                if (line.contains("\"sessionId\":\"" + sessionId + "\"") ||
                    line.contains("\"parentSessionId\":\"" + sessionId + "\"")) {
                    LOG.debug("[HistoryHandler] Agent文件 " + agentFilePath.getFileName() + " 属于会话 " + sessionId);
                    return true;
                }
                lineCount++;
            }
            // 如果前20行都没找到，说明这个agent文件不属于当前会话
            LOG.debug("[HistoryHandler] Agent文件 " + agentFilePath.getFileName() + " 不属于会话 " + sessionId);
            return false;
        } catch (Exception e) {
            // 如果读取失败，为了安全起见，不删除这个文件
            LOG.warn("[HistoryHandler] ⚠️ 无法读取agent文件 " + agentFilePath.getFileName() + ": " + e.getMessage());
            return false;
        }
    }
}
