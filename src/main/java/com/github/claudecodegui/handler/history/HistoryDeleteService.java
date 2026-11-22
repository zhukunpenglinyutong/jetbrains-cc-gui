package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.dsh.DshHistoryReader;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.util.PathUtils;
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
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
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
     * Delete one session's history files, including related agent and subagent files.
     *
     * @param content {@code {sessionId, provider, requestId}}, or a bare session id
     * @param currentProvider provider used when the payload does not name one
     */
    void handleDeleteSession(String content, String currentProvider) {
        handleDeleteRequest(HistoryDeleteRequest.parse(content, currentProvider), "deletion");
    }

    /**
     * Batch delete session history files in one backend request.
     *
     * @param content {@code {sessionIds, provider, requestId}}, or a JSON array of ids
     * @param currentProvider provider used when the payload does not name one
     */
    void handleDeleteSessions(String content, String currentProvider) {
        handleDeleteRequest(HistoryDeleteRequest.parse(content, currentProvider), "batch deletion");
    }

    /** File deletion that runs only after its sessions were quiesced. */
    @FunctionalInterface
    interface DeletionTask {
        /**
         * @param releaseWriters releases the Codex writer leases once the rollout files are gone
         * @return ids whose files could not all be removed
         */
        Collection<String> run(Runnable releaseWriters) throws Exception;
    }

    private void handleDeleteRequest(HistoryDeleteRequest request, String action) {
        if (request.sessionIds().isEmpty()) {
            LOG.warn("[HistoryHandler] History " + action + " rejected: no valid sessionIds");
            restoreHistory(action, request.provider());
            notifyDeleteResult(request, List.of(), HistoryDeletionGuard.DELETE_FAILED);
            return;
        }
        runGuardedDeletion(request, action, releaseWriters -> deleteSessions(request, releaseWriters));
    }

    /**
     * Quiesce the targets, hold Codex writer leases while deleting, then report the outcome.
     * Every path reports once, so the webview never treats a refused session as deleted.
     */
    void runGuardedDeletion(HistoryDeleteRequest request, String action, DeletionTask task) {
        List<String> sessionIds = request.sessionIds();
        String provider = request.provider();
        CodexSDKBridge bridge = context == null ? null : context.getCodexSDKBridge();
        ClaudeSession session = context == null ? null : context.getSession();
        CompletableFuture<Void> quiesced;
        try {
            quiesced = quiesceActiveSessionForDeletion(session, sessionIds, provider, bridge);
        } catch (Exception e) {
            quiesced = CompletableFuture.failedFuture(e);
        }
        quiesced.thenApplyAsync(ignored -> {
            Runnable releaseWriters = HistoryDeletionGuard.reserve(sessionIds, provider, bridge);
            try {
                // A send that began after the idle release would otherwise lose its lease to that release.
                HistoryDeletionGuard.assertStillIdle(session, sessionIds, provider);
                return task.run(releaseWriters);
            } catch (CompletionException e) {
                throw e;
            } catch (Exception e) {
                throw new CompletionException(e);
            } finally {
                releaseWriters.run();
            }
        }).whenComplete((failedIds, error) -> {
            if (error != null) {
                handleDeletionFailure(action, request, error);
                return;
            }
            Collection<String> failed = failedIds == null ? Collections.emptySet() : failedIds;
            List<String> deletedIds = sessionIds.stream().filter(id -> !failed.contains(id)).toList();
            notifyDeleteResult(request, deletedIds, failed.isEmpty() ? null : HistoryDeletionGuard.DELETE_FAILED);
        });
    }

    private Collection<String> deleteSessions(HistoryDeleteRequest request, Runnable releaseWriters) throws Exception {
        List<String> sessionIds = request.sessionIds();
        String currentProvider = request.provider();
        LOG.info("[HistoryHandler] ========== Delete sessions start ==========");
        LOG.info("[HistoryHandler] SessionIds: " + GSON.toJson(sessionIds) + ", Provider: " + currentProvider);

        int agentFilesDeletedCount = 0;
        List<String> deletedSessionIds = new ArrayList<>();
        Collection<String> failedSessionIds = new LinkedHashSet<>();
        if ("codex".equals(currentProvider)) {
            CodexBatchDeleteResult result = deleteCodexSessions(sessionIds);
            // The leases guard only the rollout files; the reload below must not report them as foreign writers.
            releaseWriters.run();
            deletedSessionIds.addAll(result.deletedSessionIds);
            failedSessionIds.addAll(result.failedSessionIds);
            LOG.info("[HistoryHandler] Deleted Codex rollout files: " + result.deletedFileCount);
        } else {
            for (String sessionId : sessionIds) {
                try {
                    DeleteResult result = deleteSessionFiles(sessionId, currentProvider);
                    if (result.mainDeleted) {
                        deletedSessionIds.add(sessionId);
                    }
                    agentFilesDeletedCount += result.agentFilesDeleted;
                } catch (Exception e) {
                    failedSessionIds.add(sessionId);
                    LOG.warn("[HistoryHandler] Delete single session failed: " + sessionId + " - " + e.getMessage(), e);
                }
            }
        }
        cleanupSessionMetadata(deletedSessionIds);

        cleanupCache(currentProvider);

        LOG.info("[HistoryHandler] Delete completed - Main files: " + deletedSessionIds.size() + "/" + sessionIds.size()
                + ", Agent files: " + agentFilesDeletedCount);
        LOG.info("[HistoryHandler] Reloading history data...");
        historyLoadService.handleLoadHistoryData(currentProvider);
        return failedSessionIds;
    }

    private void handleDeletionFailure(String action, HistoryDeleteRequest request, Throwable error) {
        String errorCode = HistoryDeletionGuard.errorCode(error);
        try {
            if (HistoryDeletionGuard.DELETE_FAILED.equals(errorCode)) {
                LOG.warn("[HistoryHandler] History " + action + " failed: " + error.getMessage(), error);
            } else {
                LOG.info("[HistoryHandler] History " + action + " refused: " + errorCode);
            }
            restoreHistory(action, request.provider());
        } finally {
            // The webview must learn of every refusal, or it keeps treating the session as deleted.
            notifyDeleteResult(request, List.of(), errorCode);
        }
    }

    /** Reload the list so rows the webview removed optimistically come back. */
    private void restoreHistory(String action, String currentProvider) {
        try {
            historyLoadService.handleLoadHistoryData(currentProvider);
        } catch (Exception reloadError) {
            LOG.warn("[HistoryHandler] Failed to restore history after aborted " + action
                    + ": " + reloadError.getMessage(), reloadError);
        }
    }

    /** Report the outcome; Codex waits for it before leaving a deleted active session. */
    void notifyDeleteResult(HistoryDeleteRequest request, Collection<String> deletedSessionIds, String errorCode) {
        if (context != null) {
            context.executeJavaScriptQueued(HistoryDeletionGuard.resultScript(request, deletedSessionIds, errorCode));
        }
    }

    static CompletableFuture<Void> quiesceActiveSessionForDeletion(
            ClaudeSession session,
            Collection<String> sessionIds,
            String currentProvider
    ) {
        return quiesceActiveSessionForDeletion(session, sessionIds, currentProvider, null);
    }

    static CompletableFuture<Void> quiesceActiveSessionForDeletion(
            ClaudeSession session,
            Collection<String> sessionIds,
            String currentProvider,
            CodexSDKBridge bridge
    ) {
        return HistoryDeletionGuard.quiesce(session, sessionIds, currentProvider, bridge);
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
            LOG.warn("[HistoryHandler] Batch delete sessionIds parse failed: " + e.getMessage());
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
                LOG.warn("[HistoryHandler] Batch delete ignored invalid sessionId");
                continue;
            }
            sessionIds.add(sessionId);
        }
    }

    private DeleteResult deleteSessionFiles(String sessionId, String currentProvider) throws java.io.IOException {
        if (!isValidSessionId(sessionId)) {
            LOG.warn("[HistoryHandler] Delete session rejected: invalid sessionId");
            return new DeleteResult(false, 0);
        }
        if ("grok".equals(currentProvider)) {
            return new DeleteResult(deleteGrokSession(sessionId), 0);
        }
        if ("pi".equals(currentProvider)) {
            return new DeleteResult(deletePiSession(sessionId), 0);
        }
        if ("omp".equals(currentProvider)) {
            return new DeleteResult(deleteOmpSession(sessionId), 0);
        }
        if ("opencode".equals(currentProvider)) {
            return new DeleteResult(deleteOpenCodeSession(sessionId), 0);
        }
        if ("kimi".equals(currentProvider)) {
            return new DeleteResult(deleteKimiSession(sessionId), 0);
        }
        if ("minimax".equals(currentProvider)) {
            return new DeleteResult(deleteMiniMaxSession(sessionId), 0);
        }
        if ("zcode".equals(currentProvider)) {
            return new DeleteResult(deleteZcodeSession(sessionId), 0);
        }
        if ("dsh".equals(currentProvider)) {
            return new DeleteResult(deleteDshSession(sessionId), 0);
        }

        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        if (projectPath == null) {
            LOG.warn("[HistoryHandler] Project base path is null, cannot delete Claude session");
            return new DeleteResult(false, 0);
        }

        int[] result = deleteClaudeSession(sessionId, projectPath);
        return new DeleteResult(result[0] == 1, result[1]);
    }

    private boolean deleteGrokSession(String sessionId) throws java.io.IOException {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        com.github.claudecodegui.provider.grok.GrokHistoryReader reader =
                new com.github.claudecodegui.provider.grok.GrokHistoryReader();
        boolean deleted = reader.deleteSession(sessionId, projectPath);
        LOG.info("[HistoryHandler] Delete Grok session " + sessionId + ": " + (deleted ? "ok" : "not found"));
        return deleted;
    }

    private boolean deletePiSession(String sessionId) throws java.io.IOException {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        com.github.claudecodegui.provider.pi.PiHistoryReader reader =
                new com.github.claudecodegui.provider.pi.PiHistoryReader();
        boolean deleted = reader.deleteSession(sessionId, projectPath);
        LOG.info("[HistoryHandler] Delete PI session " + sessionId + ": " + (deleted ? "ok" : "not found"));
        return deleted;
    }

    private boolean deleteOmpSession(String sessionId) throws java.io.IOException {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        com.github.claudecodegui.provider.omp.OmpHistoryReader reader =
                new com.github.claudecodegui.provider.omp.OmpHistoryReader();
        boolean deleted = reader.deleteSession(sessionId, projectPath);
        LOG.info("[HistoryHandler] Delete OMP session " + sessionId + ": " + (deleted ? "ok" : "not found"));
        return deleted;
    }

    private boolean deleteOpenCodeSession(String sessionId) throws java.io.IOException {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        com.github.claudecodegui.provider.opencode.OpenCodeHistoryReader reader =
                new com.github.claudecodegui.provider.opencode.OpenCodeHistoryReader();
        boolean deleted = reader.deleteSession(sessionId, projectPath);
        LOG.info("[HistoryHandler] Delete OpenCode session " + sessionId + ": " + (deleted ? "ok" : "not found"));
        return deleted;
    }

    private boolean deleteKimiSession(String sessionId) throws java.io.IOException {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        com.github.claudecodegui.provider.kimi.KimiHistoryReader reader =
                new com.github.claudecodegui.provider.kimi.KimiHistoryReader();
        boolean deleted = reader.deleteSession(sessionId, projectPath);
        LOG.info("[HistoryHandler] Delete Kimi session " + sessionId + ": " + (deleted ? "ok" : "not found"));
        return deleted;
    }

    private boolean deleteMiniMaxSession(String sessionId) throws java.io.IOException {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        com.github.claudecodegui.provider.minimax.MiniMaxHistoryReader reader =
                new com.github.claudecodegui.provider.minimax.MiniMaxHistoryReader();
        boolean deleted = reader.deleteSession(sessionId, projectPath);
        LOG.info("[HistoryHandler] Delete MiniMax session " + sessionId + ": " + (deleted ? "ok" : "not found"));
        return deleted;
    }

    private boolean deleteZcodeSession(String sessionId) throws java.io.IOException {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        com.github.claudecodegui.provider.zcode.ZcodeHistoryReader reader =
                new com.github.claudecodegui.provider.zcode.ZcodeHistoryReader();
        boolean deleted = reader.deleteSession(sessionId, projectPath);
        LOG.info("[HistoryHandler] Delete ZCode session " + sessionId + ": " + (deleted ? "ok" : "not found"));
        return deleted;
    }

    private boolean deleteDshSession(String sessionId) throws java.io.IOException {
        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        DshHistoryReader reader = new DshHistoryReader();
        // DSH "delete" is a host-side archive — the event log stays in $DSH_HOME.
        boolean archived = reader.deleteSession(sessionId, projectPath);
        LOG.info("[HistoryHandler] Archive DSH session " + sessionId + ": " + (archived ? "ok" : "failed"));
        return archived;
    }

    private CodexBatchDeleteResult deleteCodexSessions(Collection<String> sessionIds) throws java.io.IOException {
        String homeDir = NodeDetector.resolveHomeForFileOps();
        Path sessionDir = Paths.get(homeDir, ".codex", "sessions");

        if (!Files.exists(sessionDir)) {
            LOG.error("[HistoryHandler] Codex session directory not found: " + sessionDir);
            return new CodexBatchDeleteResult(Collections.emptySet(), Collections.emptySet(), 0);
        }

        Map<String, List<Path>> matchesBySession = findCodexSessionFiles(sessionDir, sessionIds);
        Map<Path, LinkedHashSet<String>> ownersByPath = new LinkedHashMap<>();
        for (Map.Entry<String, List<Path>> entry : matchesBySession.entrySet()) {
            for (Path path : entry.getValue()) {
                ownersByPath.computeIfAbsent(path, ignored -> new LinkedHashSet<>()).add(entry.getKey());
            }
        }

        LinkedHashSet<String> deletedSessionIds = new LinkedHashSet<>();
        LinkedHashSet<Path> failedPaths = new LinkedHashSet<>();
        int deletedFileCount = 0;
        for (Map.Entry<Path, LinkedHashSet<String>> entry : ownersByPath.entrySet()) {
            Path sessionFile = entry.getKey();
            try {
                if (Files.deleteIfExists(sessionFile)) {
                    LOG.info("[HistoryHandler] Deleted Codex session file: " + sessionFile);
                    deletedFileCount++;
                }
            } catch (Exception e) {
                failedPaths.add(sessionFile);
                LOG.error("[HistoryHandler] Failed to delete Codex session file: " + sessionFile + " - " + e.getMessage(), e);
            }
        }
        LinkedHashSet<String> failedSessionIds = new LinkedHashSet<>();
        for (Map.Entry<String, List<Path>> entry : matchesBySession.entrySet()) {
            if (isCodexSessionDeletionComplete(entry.getValue(), failedPaths)) {
                deletedSessionIds.add(entry.getKey());
            } else if (!Collections.disjoint(entry.getValue(), failedPaths)) {
                failedSessionIds.add(entry.getKey());
            }
        }
        return new CodexBatchDeleteResult(deletedSessionIds, failedSessionIds, deletedFileCount);
    }

    static boolean isCodexSessionDeletionComplete(
            Collection<Path> matchedPaths,
            Collection<Path> failedPaths
    ) {
        return matchedPaths != null
                && !matchedPaths.isEmpty()
                && Collections.disjoint(matchedPaths, failedPaths);
    }

    /**
     * Find the requested Codex rollout and every descendant subagent rollout.
     * Subagents use their own UUID in the filename and link back to the displayed
     * parent conversation through session_meta.source.subagent.thread_spawn.parent_thread_id.
     */
    static List<Path> findCodexSessionFiles(Path sessionDir, String sessionId) throws java.io.IOException {
        Map<String, List<Path>> matches = findCodexSessionFiles(
                sessionDir, Collections.singleton(sessionId));
        return matches.getOrDefault(sessionId, Collections.emptyList());
    }

    static Map<String, List<Path>> findCodexSessionFiles(
            Path sessionDir,
            Collection<String> sessionIds
    ) throws java.io.IOException {
        List<CodexSessionFile> candidates;
        try (Stream<Path> paths = Files.walk(sessionDir)) {
            candidates = paths
                    .filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .map(path -> new CodexSessionFile(path, readCodexSessionLink(path)))
                    .collect(Collectors.toList());
        }

        Map<String, List<Path>> matches = new LinkedHashMap<>();
        for (String sessionId : sessionIds) {
            if (sessionId != null && !matches.containsKey(sessionId)) {
                matches.put(sessionId, findCodexSessionFiles(candidates, sessionId));
            }
        }
        return matches;
    }

    private static List<Path> findCodexSessionFiles(List<CodexSessionFile> candidates, String sessionId) {
        LinkedHashSet<String> matchedSessionIds = new LinkedHashSet<>();
        matchedSessionIds.add(sessionId);
        LinkedHashSet<Path> matchedFiles = new LinkedHashSet<>();

        boolean changed;
        do {
            changed = false;
            for (CodexSessionFile candidate : candidates) {
                if (matchedFiles.contains(candidate.path)) {
                    continue;
                }

                CodexSessionLink link = candidate.link;
                boolean directFileMatch = isCodexSessionFileMatch(candidate.path, sessionId);
                boolean sessionMatch = link.sessionId != null && matchedSessionIds.contains(link.sessionId);
                boolean parentMatch = link.parentThreadId != null
                        && matchedSessionIds.contains(link.parentThreadId);
                if (!directFileMatch && !sessionMatch && !parentMatch) {
                    continue;
                }

                matchedFiles.add(candidate.path);
                changed = true;
                if ((sessionMatch || parentMatch) && link.sessionId != null) {
                    matchedSessionIds.add(link.sessionId);
                }
            }
        } while (changed);

        return new ArrayList<>(matchedFiles);
    }

    private static CodexSessionLink readCodexSessionLink(Path path) {
        try (BufferedReader reader = Files.newBufferedReader(path, StandardCharsets.UTF_8)) {
            String firstLine = reader.readLine();
            if (firstLine == null || firstLine.isEmpty()) {
                return CodexSessionLink.EMPTY;
            }

            JsonElement parsed = JsonParser.parseString(firstLine);
            if (!parsed.isJsonObject()) {
                return CodexSessionLink.EMPTY;
            }
            JsonObject root = parsed.getAsJsonObject();
            if (!"session_meta".equals(getJsonString(root, "type"))) {
                return CodexSessionLink.EMPTY;
            }

            JsonObject payload = getJsonObject(root, "payload");
            String rolloutSessionId = getJsonString(payload, "id");
            JsonObject source = getJsonObject(payload, "source");
            JsonObject subagent = getJsonObject(source, "subagent");
            JsonObject threadSpawn = getJsonObject(subagent, "thread_spawn");
            String parentThreadId = getJsonString(threadSpawn, "parent_thread_id");
            return new CodexSessionLink(rolloutSessionId, parentThreadId);
        } catch (Exception e) {
            LOG.debug("[HistoryHandler] Failed to parse Codex session metadata: " + path.getFileName(), e);
            return CodexSessionLink.EMPTY;
        }
    }

    private static JsonObject getJsonObject(JsonObject parent, String field) {
        if (parent == null) {
            return null;
        }
        JsonElement element = parent.get(field);
        return element != null && element.isJsonObject() ? element.getAsJsonObject() : null;
    }

    private static String getJsonString(JsonObject parent, String field) {
        if (parent == null) {
            return null;
        }
        JsonElement element = parent.get(field);
        return element != null && element.isJsonPrimitive() && element.getAsJsonPrimitive().isString()
                ? element.getAsString()
                : null;
    }

    /**
     * Match Codex rollout filenames whose UUID suffix equals the session ID.
     * Real format: rollout-{ISO timestamp}-{sessionId}.jsonl, so we anchor to "-{sessionId}.jsonl"
     * to avoid removing neighbouring sessions whose UUIDs share a substring.
     */
    static boolean isCodexSessionFileMatch(Path path, String sessionId) {
        if (path == null || sessionId == null || sessionId.isEmpty()) {
            return false;
        }
        String fileName = path.getFileName().toString();
        return fileName.endsWith("-" + sessionId + ".jsonl");
    }

    /**
     * @return int[2]: [mainDeleted(0/1), agentFilesDeleted]
     */
    private int[] deleteClaudeSession(String sessionId, String projectPath) throws java.io.IOException {
        String homeDir = NodeDetector.resolveHomeForFileOps();
        Path claudeDir = Paths.get(homeDir, ".claude");
        Path projectsDir = claudeDir.resolve("projects");
        List<Path> sessionDirs = PathUtils.getSanitizedPathCandidates(projectPath).stream()
                .map(projectsDir::resolve)
                .filter(Files::isDirectory)
                .collect(Collectors.toList());
        if (sessionDirs.isEmpty()) {
            LOG.error("[HistoryHandler] Claude project directory not found for: " + projectPath);
            return new int[]{0, 0};
        }

        boolean mainDeleted = false;
        int agentFilesDeleted = 0;

        for (Path sessionDir : sessionDirs) {
            // Delete main session file
            Path mainSessionFile = sessionDir.resolve(sessionId + ".jsonl").normalize();
            if (!mainSessionFile.startsWith(sessionDir.normalize())) {
                LOG.warn("[HistoryHandler] Refused out-of-bounds path: " + mainSessionFile);
                continue;
            }
            if (Files.exists(mainSessionFile)) {
                Files.delete(mainSessionFile);
                LOG.info("[HistoryHandler] Deleted main session file: " + mainSessionFile.getFileName());
                mainDeleted = true;
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
                        LOG.info("[HistoryHandler] Deleted related agent file: " + agentFile.getFileName());
                        agentFilesDeleted++;
                    } catch (Exception e) {
                        LOG.error("[HistoryHandler] Failed to delete agent file: " + agentFile.getFileName() + " - " + e.getMessage(), e);
                    }
                }
            }
        }

        return new int[]{mainDeleted ? 1 : 0, agentFilesDeleted};
    }

    /**
     * Removes the deleted sessions' favorites and custom titles, with one Node process per store
     * however many sessions were deleted.
     *
     * @param sessionIds the sessions whose files were deleted
     * @return true if both were cleaned up (or there was nothing to clean up)
     */
    boolean cleanupSessionMetadata(List<String> sessionIds) {
        if (sessionIds.isEmpty()) {
            return true;
        }
        // Independent steps: a failed favorite removal must not leave the custom titles behind.
        // Both services report a failed save as a false result while still exiting 0.
        boolean favoritesRemoved = runMetadataCleanupStep("remove favorites",
                () -> "true".equals(nodeJsServiceCaller.callNodeJsRemoveFavorites(sessionIds)));
        boolean titlesDeleted = runMetadataCleanupStep("delete custom titles",
                () -> isSuccessResult(nodeJsServiceCaller.callNodeJsDeleteTitles(sessionIds)));
        if (favoritesRemoved && titlesDeleted) {
            LOG.info("[HistoryHandler] Cleaned up metadata of " + sessionIds.size() + " session(s)");
        }
        return favoritesRemoved && titlesDeleted;
    }

    private static boolean runMetadataCleanupStep(String step, Callable<Boolean> action) {
        try {
            if (action.call()) {
                return true;
            }
            LOG.warn("[HistoryHandler] Failed to " + step + " (does not affect deletion): service reported failure");
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] Failed to " + step + " (does not affect deletion): " + e.getMessage());
        }
        return false;
    }

    private static boolean isSuccessResult(String json) {
        try {
            JsonElement result = JsonParser.parseString(json);
            return result.isJsonObject()
                    && result.getAsJsonObject().has("success")
                    && result.getAsJsonObject().get("success").getAsBoolean();
        } catch (RuntimeException e) {
            return false;
        }
    }

    private void cleanupCache(String currentProvider) {
        try {
            String rawPath2 = context.resolveEffectiveWorkingDirectory();
            String nodePath2 = NodeDetector.getInstance().getCachedNodePath();
            String projectPath = NodeDetector.isWslPath(nodePath2) ? NodeDetector.convertToWslPath(rawPath2) : rawPath2;
            if ("codex".equals(currentProvider)) {
                SessionIndexCache.getInstance().clearAllCodexCache();
                SessionIndexManager.getInstance().clearAllCodexIndex();
            } else if (projectPath != null) {
                SessionIndexCache.getInstance().clearProject(projectPath);
                SessionIndexManager.getInstance().clearProjectIndex("claude", projectPath);
            }
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] Failed to clean up cache (does not affect deletion): " + e.getMessage());
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
                    LOG.debug("[HistoryHandler] Agent file " + agentFilePath.getFileName() + " belongs to session " + sessionId);
                    return true;
                }
                lineCount++;
            }
            LOG.debug("[HistoryHandler] Agent file " + agentFilePath.getFileName() + " does not belong to session " + sessionId);
            return false;
        } catch (Exception e) {
            LOG.warn("[HistoryHandler] Failed to read agent file " + agentFilePath.getFileName() + ": " + e.getMessage());
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

    private static class CodexSessionFile {
        private final Path path;
        private final CodexSessionLink link;

        private CodexSessionFile(Path path, CodexSessionLink link) {
            this.path = path;
            this.link = link;
        }
    }

    private static class CodexSessionLink {
        private static final CodexSessionLink EMPTY = new CodexSessionLink(null, null);

        private final String sessionId;
        private final String parentThreadId;

        private CodexSessionLink(String sessionId, String parentThreadId) {
            this.sessionId = sessionId;
            this.parentThreadId = parentThreadId;
        }
    }

    private static class CodexBatchDeleteResult {
        private final Collection<String> deletedSessionIds;
        /** Ids that matched rollout files of which at least one could not be deleted. */
        private final Collection<String> failedSessionIds;
        private final int deletedFileCount;

        private CodexBatchDeleteResult(
                Collection<String> deletedSessionIds,
                Collection<String> failedSessionIds,
                int deletedFileCount
        ) {
            this.deletedSessionIds = deletedSessionIds;
            this.failedSessionIds = failedSessionIds;
            this.deletedFileCount = deletedFileCount;
        }
    }
}
