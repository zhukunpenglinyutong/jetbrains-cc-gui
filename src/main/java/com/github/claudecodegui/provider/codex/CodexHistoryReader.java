package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;
import java.util.stream.Collectors;

/**
 * Codex local history reader.
 * Reads Codex CLI session history from ~/.codex/sessions directory.
 */
public class CodexHistoryReader {

    private static final Logger LOG = Logger.getInstance(CodexHistoryReader.class);

    private final Gson gson;
    private final CodexHistoryParser parser;
    private final CodexHistoryIndexService indexService;
    private final CodexHistorySessionService sessionService;

    private static Path defaultSessionsDir() {
        return Paths.get(NodeDetector.resolveHomeForFileOps(), ".codex", "sessions");
    }

    public CodexHistoryReader() {
        this(defaultSessionsDir(), new Gson());
    }

    CodexHistoryReader(Path sessionsDir, Gson gson) {
        this.gson = gson;
        this.parser = new CodexHistoryParser(gson);
        this.indexService = new CodexHistoryIndexService(sessionsDir, parser);
        this.sessionService = new CodexHistorySessionService(sessionsDir, gson);
    }

    CodexHistoryReader(Path sessionsDir, Gson gson, SessionIndexManager indexManager) {
        this.gson = gson;
        this.parser = new CodexHistoryParser(gson);
        this.indexService = new CodexHistoryIndexService(sessionsDir, parser, indexManager);
        this.sessionService = new CodexHistorySessionService(sessionsDir, gson);
    }

    /**
     * Session info.
     */
    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
    }

    /**
     * Codex message format.
     */
    public static class CodexMessage {
        public String timestamp;
        public String type;
        public JsonObject payload;
    }

    /**
     * Read all Codex sessions.
     * Returns all sessions regardless of project.
     * Uses memory cache and file index for performance optimization.
     */
    public List<SessionInfo> readAllSessions() throws IOException {
        logSessionAccessWithoutLocalConfigAuthorization();
        return indexService.readAllSessions();
    }

    /**
     * Get all sessions as JSON string.
     */
    public String getAllSessionsAsJson() {
        try {
            List<SessionInfo> sessions = readAllSessions();

            int totalMessages = sessions.stream()
                                        .mapToInt(s -> s.messageCount)
                                        .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("total", totalMessages);
            result.put("sessionCount", sessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Codex sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    /**
     * Get sessions filtered by project path as JSON string.
     * Only returns sessions whose cwd matches or is under the specified project path.
     *
     * @param projectPath The project path to filter by
     */
    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> allSessions = readAllSessions();

            // Normalize the project path for comparison
            String normalizedProjectPath = normalizePath(projectPath);

            // The CLI records the physical (symlink-resolved) cwd in rollout files, so
            // sessions opened via a symlinked project path only match the resolved form.
            // Accept both candidates to cover either layout (issue #1789).
            Set<String> projectPathCandidates = new LinkedHashSet<>();
            projectPathCandidates.add(normalizedProjectPath);
            projectPathCandidates.add(normalizePath(PathUtils.realPath(projectPath)));

            LOG.info("[CodexHistoryReader] Filtering sessions for project: " + normalizedProjectPath);
            LOG.info("[CodexHistoryReader] Total sessions before filtering: " + allSessions.size());

            // Filter sessions by cwd
            List<SessionInfo> filteredSessions = allSessions.stream()
                                                         .filter(session -> {
                                                             if (session.cwd == null || session.cwd.isEmpty()) {
                                                                 return false;
                                                             }
                                                             String normalizedCwd = normalizePath(session.cwd);
                                                             // Match if cwd equals a project path candidate or is a subdirectory of it
                                                             boolean matches = projectPathCandidates.stream()
                                                                                        .anyMatch(candidate -> normalizedCwd.equals(candidate) ||
                                                                                                                normalizedCwd.startsWith(candidate + "/"));
                                                             if (matches) {
                                                                 LOG.debug("[CodexHistoryReader] Session " + session.sessionId + " matches (cwd: " + session.cwd + ")");
                                                             }
                                                             return matches;
                                                         })
                                                         .collect(Collectors.toList());

            LOG.info("[CodexHistoryReader] Sessions after filtering: " + filteredSessions.size());

            int totalMessages = filteredSessions.stream()
                                        .mapToInt(s -> s.messageCount)
                                        .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", filteredSessions);
            result.put("total", totalMessages);
            result.put("sessionCount", filteredSessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read sessions for project: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Codex sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    /**
     * Normalize path for comparison.
     * Converts backslashes to forward slashes and removes trailing slashes.
     */
    private String normalizePath(String path) {
        if (path == null) {
            return "";
        }
        // Convert backslashes to forward slashes
        String normalized = path.replace("\\", "/");
        // Remove trailing slash
        while (normalized.endsWith("/") && normalized.length() > 1) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    public String getSessionMessagesAsJson(String sessionId) {
        logSessionAccessWithoutLocalConfigAuthorization();
        return sessionService.getSessionMessagesAsJson(sessionId);
    }

    /**
     * Stream one session without materializing the complete JSONL file in memory.
     *
     * @return number of parsed top-level Codex records
     */
    public int forEachSessionMessage(String sessionId, Consumer<JsonObject> consumer) throws IOException {
        logSessionAccessWithoutLocalConfigAuthorization();
        return sessionService.forEachSessionMessage(sessionId, message -> {
            JsonObject raw = gson.toJsonTree(message).getAsJsonObject();
            consumer.accept(raw);
        });
    }

    /**
     * Codex session history lives under ~/.codex/sessions and does not require
     * permission to read ~/.codex/config.toml or auth.json.
     */
    private void logSessionAccessWithoutLocalConfigAuthorization() {
        if (!isCodexLocalConfigAuthorized()) {
            LOG.debug("[CodexHistoryReader] Reading ~/.codex/sessions without local config authorization");
        }
    }

    boolean isCodexLocalConfigAuthorized() {
        try {
            return new CodemossSettingsService().isCodexLocalConfigAuthorized();
        } catch (Exception e) {
            LOG.warn("[CodexHistoryReader] Failed to read Codex local authorization state: " + e.getMessage());
            return false;
        }
    }
}
