package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
import com.github.claudecodegui.util.PathUtils;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Manages session index: cache, incremental scanning, and full scanning.
 * Uses lite-read strategy for efficient metadata extraction.
 */
class ClaudeHistoryIndexService {

    private static final Logger LOG = Logger.getInstance(ClaudeHistoryIndexService.class);

    /**
     * Batch size for concurrent reads when walking the sorted candidate list.
     */
    private static final int READ_BATCH_SIZE = 32;

    /**
     * Dedicated thread pool for lite-read I/O to avoid starving the IDE's common ForkJoinPool.
     */
    private static final ExecutorService LITE_READ_POOL =
            Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors());

    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE
    );

    private final Path projectsDir;
    private final ClaudeHistoryParser parser;
    private final ClaudeSessionLiteReader liteReader;

    ClaudeHistoryIndexService(Path projectsDir, ClaudeHistoryParser parser) {
        this.projectsDir = projectsDir;
        this.parser = parser;
        this.liteReader = new ClaudeSessionLiteReader();
    }

    /**
     * Read sessions from a project directory with optional pagination.
     * Uses memory cache and file index for performance optimization.
     *
     * @param projectPath the project path
     * @param limit       maximum number of sessions to return (0 = no limit)
     * @param offset      number of sessions to skip
     * @return list of session info
     */
    List<ClaudeHistoryReader.SessionInfo> readProjectSessions(String projectPath, int limit, int offset) throws IOException {
        if (projectPath == null || projectPath.isEmpty()) {
            return new ArrayList<>();
        }

        String sanitizedPath = PathUtils.sanitizePath(projectPath);
        Path projectDir = this.projectsDir.resolve(sanitizedPath);

        if (!Files.exists(projectDir) || !Files.isDirectory(projectDir)) {
            return new ArrayList<>();
        }

        // 1. Check memory cache (only for non-paginated requests)
        SessionIndexCache cache = SessionIndexCache.getInstance();
        if (limit == 0 && offset == 0) {
            List<ClaudeHistoryReader.SessionInfo> cachedSessions = cache.getClaudeSessions(projectPath, projectDir);
            if (cachedSessions != null) {
                LOG.info("[ClaudeHistoryIndexService] Using memory cache for " + projectPath + ", sessions: " + cachedSessions.size());
                return cachedSessions;
            }
        }

        // 2. Check index file and determine update type
        SessionIndexManager indexManager = SessionIndexManager.getInstance();
        SessionIndexManager.SessionIndex index = indexManager.readClaudeIndex();
        SessionIndexManager.ProjectIndex projectIndex = index.projects.get(projectPath);
        SessionIndexManager.UpdateType updateType = indexManager.getUpdateType(projectIndex, projectDir);

        if (updateType == SessionIndexManager.UpdateType.NONE) {
            // Index is valid, restore from index
            LOG.info("[ClaudeHistoryIndexService] Using file index for " + projectPath + ", sessions: " + projectIndex.sessions.size());
            List<ClaudeHistoryReader.SessionInfo> restored = restoreSessionsFromIndex(projectIndex);
            // Apply pagination if needed
            List<ClaudeHistoryReader.SessionInfo> paged = applySortAndLimit(restored, limit, offset);
            // Update memory cache (full list, reuse already-restored list)
            if (limit == 0 && offset == 0) {
                cache.updateClaudeCache(projectPath, projectDir, restored);
            }
            return paged;
        }

        long startTime = System.currentTimeMillis();

        ScanResult scanResult;
        if (updateType == SessionIndexManager.UpdateType.INCREMENTAL && projectIndex != null) {
            // 3a. Incremental update: only scan new files using lite-read
            LOG.info("[ClaudeHistoryIndexService] Incremental scan for " + projectPath);
            scanResult = incrementalScanLite(projectDir, projectIndex);
        } else {
            // 3b. Full scan using lite-read with pagination support
            LOG.info("[ClaudeHistoryIndexService] Full scan for " + projectPath);
            scanResult = scanProjectSessionsLite(projectDir, limit, offset);
        }

        long scanTime = System.currentTimeMillis() - startTime;
        LOG.info("[ClaudeHistoryIndexService] Scan completed in " + scanTime + "ms, sessions: " + scanResult.sessions.size());

        // 4. Update index (for non-paginated full scans)
        if (limit == 0 && offset == 0) {
            updateProjectIndex(index, projectPath, projectDir, scanResult.sessions, scanResult.sessionMtimes);
            indexManager.saveClaudeIndex(index);
            // 5. Update memory cache
            cache.updateClaudeCache(projectPath, projectDir, scanResult.sessions);
        }

        return scanResult.sessions;
    }

    /**
     * Legacy method without pagination for backward compatibility.
     */
    List<ClaudeHistoryReader.SessionInfo> readProjectSessions(String projectPath) throws IOException {
        return readProjectSessions(projectPath, 0, 0);
    }

    /**
     * Incremental scan using lite-read.
     * <p>
     * Classifies each .jsonl file under the project directory into one of three buckets:
     * <ul>
     *   <li>not in index -- lite-read as new</li>
     *   <li>in index but mtime drifted (active session appended) -- lite-read to refresh</li>
     *   <li>in index with matching mtime -- restored directly from the index</li>
     * </ul>
     * Also returns the sessionId -> mtime map so the index-update step can persist
     * fileLastModified without a second stat. Package-private for test access.
     */
    ScanResult incrementalScanLite(
            Path projectDir,
            SessionIndexManager.ProjectIndex existingIndex
    ) throws IOException {
        Map<String, SessionIndexManager.SessionIndexEntry> indexedById = new HashMap<>();
        for (SessionIndexManager.SessionIndexEntry entry : existingIndex.sessions) {
            if (entry != null && entry.sessionId != null) {
                indexedById.put(entry.sessionId, entry);
            }
        }

        List<Path> newFiles = new ArrayList<>();
        List<Path> changedFiles = new ArrayList<>();
        Set<String> restoredIds = new HashSet<>();
        Map<String, Long> sessionMtimes = new HashMap<>();
        AtomicInteger skipped = new AtomicInteger();

        try (Stream<Path> paths = Files.list(projectDir)) {
            paths.filter(p -> p.toString().endsWith(".jsonl"))
                    .forEach(p -> {
                        String fileName = p.getFileName() != null ? p.getFileName().toString() : "";
                        String sessionId = extractSessionId(fileName);
                        if (sessionId == null) {
                            skipped.incrementAndGet();
                            return;
                        }

                        BasicFileAttributes attrs;
                        try {
                            attrs = Files.readAttributes(p, BasicFileAttributes.class);
                        } catch (IOException e) {
                            skipped.incrementAndGet();
                            return;
                        }
                        if (attrs.size() <= 0) {
                            skipped.incrementAndGet();
                            return;
                        }
                        long mtime = attrs.lastModifiedTime().toMillis();

                        SessionIndexManager.SessionIndexEntry indexed = indexedById.get(sessionId);
                        if (indexed == null) {
                            newFiles.add(p);
                        } else if (indexed.fileLastModified <= 0 || indexed.fileLastModified != mtime) {
                            // mtime drifted (active session appended, or legacy entry without mtime) -- re-read
                            changedFiles.add(p);
                        } else {
                            restoredIds.add(sessionId);
                            // Carry the current mtime forward so the index keeps an authoritative value.
                            sessionMtimes.put(sessionId, mtime);
                        }
                    });
        }

        List<ClaudeHistoryReader.SessionInfo> sessions = new ArrayList<>();
        for (SessionIndexManager.SessionIndexEntry entry : existingIndex.sessions) {
            if (entry != null && entry.sessionId != null && restoredIds.contains(entry.sessionId)) {
                sessions.add(restoreEntry(entry));
            }
        }

        List<ReadResult> refreshed = batchReadLite(changedFiles);
        List<ReadResult> newSessions = batchReadLite(newFiles);
        for (ReadResult rr : refreshed) {
            sessions.add(rr.info);
            sessionMtimes.put(rr.info.sessionId, rr.mtime);
        }
        for (ReadResult rr : newSessions) {
            sessions.add(rr.info);
            sessionMtimes.put(rr.info.sessionId, rr.mtime);
        }
        LOG.info("[ClaudeHistoryIndexService] Incremental scan: " + refreshed.size() + " refreshed, "
                + newSessions.size() + " new, " + restoredIds.size() + " unchanged, "
                + skipped.get() + " skipped");

        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));
        return new ScanResult(sessions, sessionMtimes);
    }

    /**
     * Full scan using lite-read with pagination support.
     * Always does stat to get correct mtime for sorting.
     */
    private ScanResult scanProjectSessionsLite(
            Path projectDir,
            int limit,
            int offset
    ) throws IOException {
        // Always gather candidates with stat for correct sorting
        List<SessionCandidate> candidates = gatherCandidates(projectDir, true);

        Map<String, Long> sessionMtimes = new HashMap<>();
        if (candidates.isEmpty()) {
            return new ScanResult(new ArrayList<>(), sessionMtimes);
        }

        List<ClaudeHistoryReader.SessionInfo> sessions = applySortAndLimitLite(candidates, limit, offset, sessionMtimes);
        return new ScanResult(sessions, sessionMtimes);
    }

    /**
     * Gather candidate session files. Uses a single readAttributes call per file so
     * size and mtime come from the same stat.
     */
    private List<SessionCandidate> gatherCandidates(Path projectDir, boolean doStat) throws IOException {
        List<SessionCandidate> candidates = new ArrayList<>();

        try (Stream<Path> paths = Files.list(projectDir)) {
            paths.filter(p -> p.toString().endsWith(".jsonl"))
                    .forEach(p -> {
                        String fileName = p.getFileName().toString();
                        String sessionId = extractSessionId(fileName);
                        if (sessionId == null) {
                            return;
                        }

                        long mtime = 0;
                        if (doStat) {
                            try {
                                BasicFileAttributes attrs = Files.readAttributes(p, BasicFileAttributes.class);
                                if (attrs.size() <= 0) {
                                    return;
                                }
                                mtime = attrs.lastModifiedTime().toMillis();
                            } catch (IOException e) {
                                return;
                            }
                        }

                        candidates.add(new SessionCandidate(sessionId, p, mtime));
                    });
        }

        return candidates;
    }

    /**
     * Extract session ID from file name (UUID validation).
     * Accepts both lowercase and uppercase UUID formats.
     */
    private String extractSessionId(String fileName) {
        if (!fileName.endsWith(".jsonl")) {
            return null;
        }
        String sessionId = fileName.substring(0, fileName.length() - 6);
        // UUID pattern validation (case-insensitive, pre-compiled)
        if (!UUID_PATTERN.matcher(sessionId).matches()) {
            return null;
        }
        return sessionId.toLowerCase(); // Normalize to lowercase for consistency
    }

    /**
     * Apply sort and limit using lite-read on sorted candidates.
     *
     * @param sessionMtimes output map populated with (sessionId -> file mtime) for every
     *                      session successfully read, so the caller can persist them in the index
     *                      without a second stat
     */
    private List<ClaudeHistoryReader.SessionInfo> applySortAndLimitLite(
            List<SessionCandidate> candidates,
            int limit,
            int offset,
            Map<String, Long> sessionMtimes
    ) {
        // Sort by mtime descending
        candidates.sort((a, b) -> {
            if (b.mtime != a.mtime) {
                return Long.compare(b.mtime, a.mtime);
            }
            return b.sessionId.compareTo(a.sessionId);
        });

        List<ClaudeHistoryReader.SessionInfo> sessions = new ArrayList<>();
        int want = limit > 0 ? limit : Integer.MAX_VALUE;
        int skipped = 0;
        Set<String> seen = new HashSet<>();

        // Batch read in sorted order
        for (int i = 0; i < candidates.size() && sessions.size() < want; ) {
            int batchEnd = Math.min(i + READ_BATCH_SIZE, candidates.size());
            List<SessionCandidate> batch = candidates.subList(i, batchEnd);
            List<ReadResult> batchResults = batchReadLite(
                    batch.stream().map(c -> c.filePath).collect(Collectors.toList())
            );

            for (ReadResult rr : batchResults) {
                if (rr.info == null) {
                    continue;
                }
                if (seen.contains(rr.info.sessionId)) {
                    continue;
                }
                seen.add(rr.info.sessionId);
                if (skipped < offset) {
                    skipped++;
                    continue;
                }
                sessions.add(rr.info);
                sessionMtimes.put(rr.info.sessionId, rr.mtime);
                if (sessions.size() >= want) {
                    break;
                }
            }
            // Always advance past the entire batch to avoid re-processing failed candidates
            i = batchEnd;
        }

        // Final sort by lastTimestamp to ensure correct order
        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        return sessions;
    }

    /**
     * Batch read session files using lite-read. Carries the file mtime alongside each
     * session so that the index-update step can persist fileLastModified without a
     * second stat. lite-read already stats the file when producing ClaudeLiteSessionInfo,
     * so the mtime is free; fallback paths pay a single extra stat.
     */
    private List<ReadResult> batchReadLite(List<Path> filePaths) {
        List<CompletableFuture<ReadResult>> futures = new ArrayList<>();

        for (Path path : filePaths) {
            futures.add(CompletableFuture.supplyAsync(() -> {
                try {
                    ClaudeSessionLiteReader.ClaudeLiteSessionInfo liteInfo = this.liteReader.readSessionLite(path);
                    if (liteInfo != null) {
                        return new ReadResult(convertToSessionInfo(liteInfo), liteInfo.lastModified);
                    }
                    // Fallback to full scan if lite-read fails.
                    ClaudeHistoryReader.SessionInfo info = fallbackFullScan(path);
                    long mtime = info != null ? safeStatMillis(path) : 0L;
                    return new ReadResult(info, mtime);
                } catch (Exception e) {
                    LOG.debug("[ClaudeHistoryIndexService] Lite-read failed for " + path + ", trying fallback: " + e.getMessage());
                    ClaudeHistoryReader.SessionInfo info = fallbackFullScan(path);
                    long mtime = info != null ? safeStatMillis(path) : 0L;
                    return new ReadResult(info, mtime);
                }
            }, LITE_READ_POOL));
        }

        List<ReadResult> results = new ArrayList<>();
        for (CompletableFuture<ReadResult> future : futures) {
            try {
                ReadResult rr = future.get(10, TimeUnit.SECONDS);
                if (rr.info != null) {
                    results.add(rr);
                }
            } catch (Exception e) {
                LOG.warn("[ClaudeHistoryIndexService] Failed to read session: " + e.getMessage());
            }
        }

        return results;
    }

    private static long safeStatMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    /**
     * Pair of SessionInfo and the file mtime captured during the read.
     */
    private record ReadResult(ClaudeHistoryReader.SessionInfo info, long mtime) {
    }

    /**
     * Fallback to full scan when lite-read fails to extract essential metadata.
     */
    private ClaudeHistoryReader.SessionInfo fallbackFullScan(Path path) {
        try {
            return this.parser.scanSingleSession(path);
        } catch (Exception e) {
            LOG.error("[ClaudeHistoryIndexService] Fallback scan failed for " + path + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Convert lite-read result to SessionInfo.
     */
    private ClaudeHistoryReader.SessionInfo convertToSessionInfo(ClaudeSessionLiteReader.ClaudeLiteSessionInfo liteInfo) {
        ClaudeHistoryReader.SessionInfo session = new ClaudeHistoryReader.SessionInfo();
        session.sessionId = liteInfo.sessionId;
        session.title = liteInfo.summary;
        session.messageCount = liteInfo.messageCount;
        session.lastTimestamp = liteInfo.lastModified;
        session.firstTimestamp = liteInfo.createdAt;
        session.fileSize = liteInfo.fileSize;
        return session;
    }

    /**
     * Apply sort and limit to existing session list.
     */
    private List<ClaudeHistoryReader.SessionInfo> applySortAndLimit(
            List<ClaudeHistoryReader.SessionInfo> sessions,
            int limit,
            int offset
    ) {
        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        if (offset > 0) {
            sessions = sessions.subList(Math.min(offset, sessions.size()), sessions.size());
        }

        if (limit > 0 && sessions.size() > limit) {
            sessions = sessions.subList(0, limit);
        }

        return new ArrayList<>(sessions);
    }

    /**
     * Restore session list from index.
     */
    private List<ClaudeHistoryReader.SessionInfo> restoreSessionsFromIndex(SessionIndexManager.ProjectIndex projectIndex) {
        List<ClaudeHistoryReader.SessionInfo> sessions = new ArrayList<>();
        for (SessionIndexManager.SessionIndexEntry entry : projectIndex.sessions) {
            sessions.add(restoreEntry(entry));
        }
        return sessions;
    }

    /**
     * Convert a single index entry to a SessionInfo.
     */
    private ClaudeHistoryReader.SessionInfo restoreEntry(SessionIndexManager.SessionIndexEntry entry) {
        ClaudeHistoryReader.SessionInfo session = new ClaudeHistoryReader.SessionInfo();
        session.sessionId = entry.sessionId;
        session.title = entry.title;
        session.messageCount = entry.messageCount;
        session.lastTimestamp = entry.lastTimestamp;
        session.firstTimestamp = entry.firstTimestamp;
        session.fileSize = entry.fileSize;
        return session;
    }

    /**
     * Update project index. Uses mtimes captured during the scan phase so no second
     * stat call is required.
     */
    private void updateProjectIndex(
            SessionIndexManager.SessionIndex index,
            String projectPath,
            Path projectDir,
            List<ClaudeHistoryReader.SessionInfo> sessions,
            Map<String, Long> sessionMtimes
    ) {
        SessionIndexManager.ProjectIndex projectIndex = new SessionIndexManager.ProjectIndex();
        projectIndex.lastDirScanTime = System.currentTimeMillis();

        try (Stream<Path> paths = Files.list(projectDir)) {
            projectIndex.fileCount = (int) paths.filter(p -> p.toString().endsWith(".jsonl")).count();
        } catch (IOException e) {
            projectIndex.fileCount = sessions.size();
        }

        for (ClaudeHistoryReader.SessionInfo session : sessions) {
            SessionIndexManager.SessionIndexEntry entry = new SessionIndexManager.SessionIndexEntry();
            entry.sessionId = session.sessionId;
            entry.title = session.title;
            entry.messageCount = session.messageCount;
            entry.lastTimestamp = session.lastTimestamp;
            entry.firstTimestamp = session.firstTimestamp;
            entry.fileSize = session.fileSize;
            // Claude: session files live flat under projectDir with the sessionId as basename.
            entry.fileRelativePath = session.sessionId != null ? session.sessionId + ".jsonl" : null;
            Long mtime = session.sessionId != null ? sessionMtimes.get(session.sessionId) : null;
            entry.fileLastModified = mtime != null ? mtime : 0L;
            projectIndex.sessions.add(entry);
        }

        index.projects.put(projectPath, projectIndex);
    }

    /**
     * Scan result bundle: session list and the sessionId -> mtime map captured during
     * the scan so callers can persist fileLastModified without another stat.
     * Package-private for test access.
     */
    record ScanResult(List<ClaudeHistoryReader.SessionInfo> sessions, Map<String, Long> sessionMtimes) {
    }

    /**
     * Candidate session file for stat-first sorting.
     */
    private record SessionCandidate(String sessionId, Path filePath, long mtime) {
    }
}