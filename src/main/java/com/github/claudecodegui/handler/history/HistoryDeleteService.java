package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Service for deleting session history files and related data.
 */
class HistoryDeleteService {

    private static final Logger LOG = Logger.getInstance(HistoryDeleteService.class);
    private static final Gson GSON = new Gson();

    // Reject anything outside [A-Za-z0-9._-] to defeat path-traversal payloads such as "../foo"
    // before they reach Path.resolve. Session IDs in both providers are alphanumeric/UUID style.
    private static final Pattern SESSION_ID_PATTERN = Pattern.compile("^[A-Za-z0-9._-]+$");

    static boolean isValidSessionId(String sessionId) {
        return sessionId != null && SESSION_ID_PATTERN.matcher(sessionId).matches();
    }

    private final HandlerContext context;
    private final NodeJsServiceCaller nodeJsServiceCaller;
    private final HistoryLoadService historyLoadService;

    HistoryDeleteService(HandlerContext context, NodeJsServiceCaller nodeJsServiceCaller, HistoryLoadService historyLoadService) {
        this.context = context;
        this.nodeJsServiceCaller = nodeJsServiceCaller;
        this.historyLoadService = historyLoadService;
    }

    /**
     * Delete session history files.
     * Deletes the .jsonl file for the specified sessionId and related agent-xxx.jsonl files.
     */
    void handleDeleteSession(String sessionId, String currentProvider) {
        if (!isValidSessionId(sessionId)) {
            LOG.warn("[HistoryHandler] 删除会话失败: 非法 sessionId 已拒绝");
            return;
        }
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 开始删除会话 ==========");
                LOG.info("[HistoryHandler] SessionId: " + sessionId + ", Provider: " + currentProvider);

                DeleteResult result = deleteSessionFiles(sessionId, currentProvider);

                LOG.info("[HistoryHandler] 删除完成 - 主文件: " + (result.mainDeleted ? "已删除" : "未找到") + ", Agent 文件: " + result.agentFilesDeleted);

                if (result.mainDeleted) {
                    cleanupSessionMetadata(sessionId);
                }
                cleanupCache(currentProvider);

                LOG.info("[HistoryHandler] 重新加载历史数据...");
                historyLoadService.handleLoadHistoryData(currentProvider);

            } catch (Exception e) {
                LOG.error("[HistoryHandler] 删除会话失败: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Batch delete session history files in one backend request.
     */
    void handleDeleteSessions(String content, String currentProvider) {
        List<String> sessionIds = parseSessionIds(content);
        if (sessionIds.isEmpty()) {
            LOG.warn("[HistoryHandler] 批量删除会话失败: sessionIds 为空");
            return;
        }

        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 开始批量删除会话 ==========");
                LOG.info("[HistoryHandler] SessionIds: " + GSON.toJson(sessionIds) + ", Provider: " + currentProvider);

                int mainDeletedCount = 0;
                int agentFilesDeletedCount = 0;

                for (String sessionId : sessionIds) {
                    try {
                        DeleteResult result = deleteSessionFiles(sessionId, currentProvider);
                        if (result.mainDeleted) {
                            mainDeletedCount++;
                            cleanupSessionMetadata(sessionId);
                        }
                        agentFilesDeletedCount += result.agentFilesDeleted;
                    } catch (Exception e) {
                        LOG.error("[HistoryHandler] 批量删除单个会话失败: " + sessionId + " - " + e.getMessage(), e);
                    }
                }

                cleanupCache(currentProvider);

                LOG.info("[HistoryHandler] 批量删除完成 - 主文件: " + mainDeletedCount + "/" + sessionIds.size()
                        + ", Agent 文件: " + agentFilesDeletedCount);
                LOG.info("[HistoryHandler] 重新加载历史数据...");
                historyLoadService.handleLoadHistoryData(currentProvider);
            } catch (Exception e) {
                LOG.error("[HistoryHandler] 批量删除会话失败: " + e.getMessage(), e);
            }
        });
    }

    static List<String> parseSessionIds(String content) {
        LinkedHashSet<String> sessionIds = new LinkedHashSet<>();
        if (content == null || content.trim().isEmpty()) {
            return new ArrayList<>();
        }

        try {
            JsonElement parsed = JsonParser.parseString(content);
            if (parsed.isJsonArray()) {
                collectSessionIds(parsed.getAsJsonArray(), sessionIds);
            } else if (parsed.isJsonObject()) {
                JsonObject object = parsed.getAsJsonObject();
                JsonElement sessionIdsElement = object.get("sessionIds");
                if (sessionIdsElement != null && sessionIdsElement.isJsonArray()) {
                    collectSessionIds(sessionIdsElement.getAsJsonArray(), sessionIds);
                }
            }
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 批量删除会话参数解析失败: " + e.getMessage());
        }

        return new ArrayList<>(sessionIds);
    }

    private static void collectSessionIds(JsonArray array, LinkedHashSet<String> sessionIds) {
        for (JsonElement element : array) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                continue;
            }

            String sessionId = element.getAsString().trim();
            if (sessionId.isEmpty()) {
                continue;
            }
            if (!isValidSessionId(sessionId)) {
                LOG.warn("[HistoryHandler] 批量删除会话忽略非法 sessionId");
                continue;
            }
            sessionIds.add(sessionId);
        }
    }

    private DeleteResult deleteSessionFiles(String sessionId, String currentProvider) throws java.io.IOException {
        if (!isValidSessionId(sessionId)) {
            LOG.warn("[HistoryHandler] 删除会话失败: 非法 sessionId 已拒绝");
            return new DeleteResult(false, 0);
        }
        if ("codex".equals(currentProvider)) {
            return new DeleteResult(deleteCodexSession(sessionId), 0);
        }

        String projectPath = context.getProject().getBasePath();
        if (projectPath == null) {
            LOG.warn("[HistoryHandler] Project base path is null, cannot delete Claude session");
            return new DeleteResult(false, 0);
        }

        int[] result = deleteClaudeSession(sessionId, projectPath);
        return new DeleteResult(result[0] == 1, result[1]);
    }

    private boolean deleteCodexSession(String sessionId) throws java.io.IOException {
        String homeDir = PlatformUtils.getHomeDirectory();
        Path sessionDir = Paths.get(homeDir, ".codex", "sessions");

        if (!Files.exists(sessionDir)) {
            LOG.error("[HistoryHandler] Codex 会话目录不存在: " + sessionDir);
            return false;
        }

        boolean deleted = false;
        try (Stream<Path> paths = Files.walk(sessionDir)) {
            List<Path> sessionFiles = paths
                    .filter(Files::isRegularFile)
                    .filter(path -> isCodexSessionFileMatch(path, sessionId))
                    .collect(Collectors.toList());

            for (Path sessionFile : sessionFiles) {
                try {
                    Files.delete(sessionFile);
                    LOG.info("[HistoryHandler] 已删除 Codex 会话文件: " + sessionFile);
                    deleted = true;
                } catch (Exception e) {
                    LOG.error("[HistoryHandler] 删除 Codex 会话文件失败: " + sessionFile + " - " + e.getMessage(), e);
                }
            }
        }
        return deleted;
    }

    static boolean isCodexSessionFileMatch(Path path, String sessionId) {
        if (path == null || sessionId == null || sessionId.isEmpty()) {
            return false;
        }
        String fileName = path.getFileName().toString();
        return fileName.endsWith(".jsonl") && fileName.contains(sessionId);
    }

    /**
     * @return int[2]: [mainDeleted(0/1), agentFilesDeleted]
     */
    private int[] deleteClaudeSession(String sessionId, String projectPath) throws java.io.IOException {
        String homeDir = PlatformUtils.getHomeDirectory();
        Path claudeDir = Paths.get(homeDir, ".claude");
        Path projectsDir = claudeDir.resolve("projects");
        String sanitizedPath = PathUtils.sanitizePath(projectPath);
        Path sessionDir = projectsDir.resolve(sanitizedPath);

        if (!Files.exists(sessionDir)) {
            LOG.error("[HistoryHandler] Claude 项目目录不存在: " + sessionDir);
            return new int[]{0, 0};
        }

        boolean mainDeleted = false;
        int agentFilesDeleted = 0;

        // Delete main session file
        Path mainSessionFile = sessionDir.resolve(sessionId + ".jsonl").normalize();
        if (!mainSessionFile.startsWith(sessionDir.normalize())) {
            LOG.warn("[HistoryHandler] 拒绝越界路径: " + mainSessionFile);
            return new int[]{0, 0};
        }
        if (Files.exists(mainSessionFile)) {
            Files.delete(mainSessionFile);
            LOG.info("[HistoryHandler] 已删除主会话文件: " + mainSessionFile.getFileName());
            mainDeleted = true;
        } else {
            LOG.warn("[HistoryHandler] 主会话文件不存在: " + mainSessionFile.getFileName());
        }

        // Delete related agent files
        try (Stream<Path> stream = Files.list(sessionDir)) {
            List<Path> agentFiles = stream
                    .filter(path -> {
                        String filename = path.getFileName().toString();
                        return filename.startsWith("agent-") && filename.endsWith(".jsonl")
                                && isAgentFileRelatedToSession(path, sessionId);
                    })
                    .collect(Collectors.toList());

            for (Path agentFile : agentFiles) {
                try {
                    Files.delete(agentFile);
                    LOG.info("[HistoryHandler] 已删除关联 agent 文件: " + agentFile.getFileName());
                    agentFilesDeleted++;
                } catch (Exception e) {
                    LOG.error("[HistoryHandler] 删除 agent 文件失败: " + agentFile.getFileName() + " - " + e.getMessage(), e);
                }
            }
        }

        return new int[]{mainDeleted ? 1 : 0, agentFilesDeleted};
    }

    private void cleanupSessionMetadata(String sessionId) {
        try {
            nodeJsServiceCaller.callNodeJsFavoritesService("removeFavorite", sessionId);
            nodeJsServiceCaller.callNodeJsDeleteTitle(sessionId);
            LOG.info("[HistoryHandler] 已清理会话关联数据");
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 清理关联数据失败（不影响会话删除）: " + e.getMessage());
        }
    }

    private void cleanupCache(String currentProvider) {
        try {
            String projectPath = context.getProject().getBasePath();
            if ("codex".equals(currentProvider)) {
                SessionIndexCache.getInstance().clearAllCodexCache();
                SessionIndexManager.getInstance().clearAllCodexIndex();
            } else if (projectPath != null) {
                SessionIndexCache.getInstance().clearProject(projectPath);
                SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
            }
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 清理缓存失败（不影响会话删除）: " + e.getMessage());
        }
    }

    /**
     * Check if an agent file belongs to the specified session.
     */
    private boolean isAgentFileRelatedToSession(Path agentFilePath, String sessionId) {
        try (BufferedReader reader = Files.newBufferedReader(agentFilePath, StandardCharsets.UTF_8)) {
            String line;
            int lineCount = 0;
            // Only read the first 20 lines for performance
            while ((line = reader.readLine()) != null && lineCount < 20) {
                if (line.contains("\"sessionId\":\"" + sessionId + "\"") ||
                            line.contains("\"parentSessionId\":\"" + sessionId + "\"")) {
                    LOG.debug("[HistoryHandler] Agent文件 " + agentFilePath.getFileName() + " 属于会话 " + sessionId);
                    return true;
                }
                lineCount++;
            }
            LOG.debug("[HistoryHandler] Agent文件 " + agentFilePath.getFileName() + " 不属于会话 " + sessionId);
            return false;
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] 无法读取agent文件 " + agentFilePath.getFileName() + ": " + e.getMessage());
            return false;
        }
    }

    private static class DeleteResult {
        private final boolean mainDeleted;
        private final int agentFilesDeleted;

        private DeleteResult(boolean mainDeleted, int agentFilesDeleted) {
            this.mainDeleted = mainDeleted;
            this.agentFilesDeleted = agentFilesDeleted;
        }
    }
}
