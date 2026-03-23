package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Service for deleting session history files and related data.
 */
class HistoryDeleteService {

    private static final Logger LOG = Logger.getInstance(HistoryDeleteService.class);

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
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[HistoryHandler] ========== 开始删除会话 ==========");
                LOG.info("[HistoryHandler] SessionId: " + sessionId + ", Provider: " + currentProvider);

                boolean mainDeleted;
                int agentFilesDeleted;

                if ("codex".equals(currentProvider)) {
                    mainDeleted = deleteCodexSession(sessionId);
                    agentFilesDeleted = 0;
                } else {
                    String projectPath = context.getProject().getBasePath();
                    if (projectPath == null) {
                        LOG.warn("[HistoryHandler] Project base path is null, cannot delete Claude session");
                        return;
                    }
                    int[] result = deleteClaudeSession(sessionId, projectPath);
                    mainDeleted = result[0] == 1;
                    agentFilesDeleted = result[1];
                }

                LOG.info("[HistoryHandler] 删除完成 - 主文件: " + (mainDeleted ? "已删除" : "未找到") + ", Agent 文件: " + agentFilesDeleted);

                if (mainDeleted) {
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
                    .filter(path -> path.getFileName().toString().startsWith(sessionId))
                    .filter(path -> path.toString().endsWith(".jsonl"))
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
        Path mainSessionFile = sessionDir.resolve(sessionId + ".jsonl");
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
}
