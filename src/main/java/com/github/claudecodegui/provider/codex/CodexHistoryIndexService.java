package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.cache.SessionIndexCache;
import com.github.claudecodegui.cache.SessionIndexManager;
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
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Handles Codex session indexing, cache coordination, and full/incremental scans.
 * Uses lite-read strategy for efficient metadata extraction.
 */
class CodexHistoryIndexService {

    private static final Logger LOG = Logger.getInstance(CodexHistoryIndexService.class);

    /**
     * Batch size for concurrent reads when walking the sorted candidate list.
     */
    private static final int READ_BATCH_SIZE = 32;

    /**
     * Dedicated thread pool for lite-read I/O to avoid starving the IDE's common ForkJoinPool.
     */
    private static final ExecutorService LITE_READ_POOL =
            Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors());

    private final Path sessionsDir;
    private final CodexHistoryParser parser;
    private final CodexSessionLiteReader liteReader;

    CodexHistoryIndexService(Path sessionsDir, CodexHistoryParser parser) {
        this.sessionsDir = sessionsDir;
        this.parser = parser;
        this.liteReader = new CodexSessionLiteReader();
    }

    List<CodexHistoryReader.SessionInfo> readAllSessions() throws IOException {
        return readAllSessionsWithPagination(0, 0);
    }

    /**
     * Read sessions with optional pagination support.
     *
     * @param limit  maximum number of sessions to return (0 = no limit)
     * @param offset number of sessions to skip
     * @return list of session info
     */
    List<CodexHistoryReader.SessionInfo> readAllSessionsWithPagination(int limit, int offset) throws IOException {
        String cacheKey = "__all__";

        if (!Files.exists(sessionsDir) || !Files.isDirectory(sessionsDir)) {
            LOG.info("[CodexHistoryIndexService] Codex sessions directory not found: " + sessionsDir);
            return new ArrayList<>();
        }

        // Check memory cache (only for non-paginated requests)
        SessionIndexCache cache = SessionIndexCache.getInstance();
        if (limit == 0 && offset == 0) {
            List<CodexHistoryReader.SessionInfo> cachedSessions = cache.getCodexSessions(cacheKey, sessionsDir);
            if (cachedSessions != null) {
                LOG.info("[CodexHistoryIndexService] Using memory cache for " + cacheKey + ", sessions: " + cachedSessions.size());
                return cachedSessions;
            }
        }

        SessionIndexManager indexManager = SessionIndexManager.getInstance();
        SessionIndexManager.SessionIndex index = indexManager.readCodexIndex();
        SessionIndexManager.ProjectIndex projectIndex = index.projects.get(cacheKey);
        SessionIndexManager.UpdateType updateType = indexManager.getUpdateTypeRecursive(projectIndex, sessionsDir);

        if (updateType == SessionIndexManager.UpdateType.NONE) {
            LOG.info("[CodexHistoryIndexService] Using file index for " + cacheKey + ", sessions: " + projectIndex.sessions.size());
            List<CodexHistoryReader.SessionInfo> restored = restoreSessionsFromIndex(projectIndex);
            List<CodexHistoryReader.SessionInfo> sessions = applySortAndLimit(restored, limit, offset);
            // Update memory cache (full list, reuse already-restored list)
            if (limit == 0 && offset == 0) {
                cache.updateCodexCache(cacheKey, sessionsDir, restored);
            }
            return sessions;
        }

        long startTime = System.currentTimeMillis();

        ScanResult scanResult;
        if (updateType == SessionIndexManager.UpdateType.INCREMENTAL && projectIndex != null) {
            LOG.info("[CodexHistoryIndexService] Incremental scan for Codex sessions");
            scanResult = incrementalScanLite(projectIndex);
        } else {
            LOG.info("[CodexHistoryIndexService] Full scan for Codex sessions");
            scanResult = scanAllSessionsLite(limit, offset);
            // Note: we no longer call preserveExistingTitles here.
            // Custom titles are handled by HistoryLoadService.enhanceHistoryWithTitles() at display time,
            // which reads from session-titles.json and overrides the auto-extracted title.
            // Preserving stale index titles would mask updates to active sessions, contradicting
            // the fix goal of making "first entry" and "refresh" show consistent content.
        }

        long scanTime = System.currentTimeMillis() - startTime;
        LOG.info("[CodexHistoryIndexService] Scan completed in " + scanTime + "ms, sessions: " + scanResult.sessions.size());

        // Update index (for non-paginated full scans)
        if (limit == 0 && offset == 0) {
            updateCodexIndex(index, cacheKey, scanResult.sessions, scanResult.sessionFiles);
            indexManager.saveCodexIndex(index);
            cache.updateCodexCache(cacheKey, sessionsDir, scanResult.sessions);
        }

        return scanResult.sessions;
    }

    /**
     * Result bundle for scan operations: sessions and the sessionId -> file metadata
     * (path + mtime) captured during lite-read / index restore. Both are needed by
     * updateCodexIndex to persist fileRelativePath and fileLastModified without a
     * second stat. Package-private for test access.
     */
    record ScanResult(List<CodexHistoryReader.SessionInfo> sessions, Map<String, FileMeta> sessionFiles) {
    }

    /**
     * Captures a session file's location and last-modified time, carried from scan
     * to index-update to avoid redundant stat calls.
     */
    record FileMeta(Path path, long mtime) {
    }

    /**
     * Incremental scan using lite-read.
     * <p>
     * Three buckets:
     * <ul>
     *   <li>new files (not present in the existing index) -- lite-read</li>
     *   <li>indexed files whose mtime drifted since the last index write -- lite-read</li>
     *   <li>indexed files with unchanged mtime -- restored from index</li>
     * </ul>
     * Relative path is used as the stable key because Codex session IDs may come from
     * session_meta.id and therefore are not directly derivable from the filename.
     * Package-private for test access.
     */
    ScanResult incrementalScanLite(SessionIndexManager.ProjectIndex existingIndex) throws IOException {
        Map<String, SessionIndexManager.SessionIndexEntry> indexedByPath = new HashMap<>();
        for (SessionIndexManager.SessionIndexEntry entry : existingIndex.sessions) {
            if (entry != null && entry.fileRelativePath != null && !entry.fileRelativePath.isEmpty()) {
                indexedByPath.put(entry.fileRelativePath, entry);
            }
        }

        List<Path> newFiles = new ArrayList<>();
        List<Path> changedFiles = new ArrayList<>();
        Map<String, SessionIndexManager.SessionIndexEntry> restoredEntriesByPath = new HashMap<>();
        Map<String, FileMeta> sessionFiles = new HashMap<>();
        AtomicInteger skipped = new AtomicInteger();

        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            paths
                    .filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".jsonl"))
                    .forEach(p -> {
                        String relative;
                        BasicFileAttributes attrs;
                        try {
                            relative = this.sessionsDir.relativize(p).toString();
                            attrs = Files.readAttributes(p, BasicFileAttributes.class);
                        } catch (Exception e) {
                            skipped.incrementAndGet();
                            return;
                        }
                        if (attrs.size() <= 0) {
                            skipped.incrementAndGet();
                            return;
                        }
                        long mtime = attrs.lastModifiedTime().toMillis();

                        SessionIndexManager.SessionIndexEntry indexed = indexedByPath.get(relative);
                        if (indexed == null) {
                            newFiles.add(p);
                        } else if (indexed.fileLastModified <= 0 || indexed.fileLastModified != mtime) {
                            changedFiles.add(p);
                        } else {
                            restoredEntriesByPath.put(relative, indexed);
                            if (indexed.sessionId != null) {
                                sessionFiles.put(indexed.sessionId, new FileMeta(p, mtime));
                            }
                        }
                    });
        }

        List<CodexHistoryReader.SessionInfo> sessions = new ArrayList<>();
        for (SessionIndexManager.SessionIndexEntry entry : restoredEntriesByPath.values()) {
            sessions.add(restoreEntry(entry));
        }

        List<ReadResult> refreshed = batchReadLite(changedFiles);
        List<ReadResult> newSessions = batchReadLite(newFiles);
        for (ReadResult rr : refreshed) {
            sessions.add(rr.info);
            sessionFiles.put(rr.info.sessionId, new FileMeta(rr.path, rr.mtime));
        }
        for (ReadResult rr : newSessions) {
            sessions.add(rr.info);
            sessionFiles.put(rr.info.sessionId, new FileMeta(rr.path, rr.mtime));
        }
        LOG.info("[CodexHistoryIndexService] Incremental scan: " + refreshed.size() + " refreshed, "
                + newSessions.size() + " new, " + restoredEntriesByPath.size() + " unchanged, "
                + skipped.get() + " skipped");

        return new ScanResult(deduplicateSessions(sessions), sessionFiles);
    }

    private CodexHistoryReader.SessionInfo restoreEntry(SessionIndexManager.SessionIndexEntry entry) {
        CodexHistoryReader.SessionInfo session = new CodexHistoryReader.SessionInfo();
        session.sessionId = entry.sessionId;
        session.title = entry.title;
        session.messageCount = entry.messageCount;
        session.lastTimestamp = entry.lastTimestamp;
        session.firstTimestamp = entry.firstTimestamp;
        session.cwd = entry.cwd;
        session.fileSize = entry.fileSize;
        return session;
    }

    /**
     * Full scan using lite-read with pagination support.
     * Always does stat to get correct mtime for sorting.
     */
    private ScanResult scanAllSessionsLite(int limit, int offset) throws IOException {
        List<SessionCandidate> candidates = gatherCandidates(true);

        Map<String, FileMeta> sessionFiles = new HashMap<>();
        if (candidates.isEmpty()) {
            return new ScanResult(new ArrayList<>(), sessionFiles);
        }

        List<CodexHistoryReader.SessionInfo> sessions = applySortAndLimitLite(candidates, limit, offset, sessionFiles);
        return new ScanResult(sessions, sessionFiles);
    }

    /**
     * Gather candidate session files. Uses a single readAttributes call per file so
     * size and mtime come from the same stat.
     */
    private List<SessionCandidate> gatherCandidates(boolean doStat) throws IOException {
        List<SessionCandidate> candidates = new ArrayList<>();

        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            paths.filter(Files::isRegularFile)
                    .filter(p -> p.toString().endsWith(".jsonl"))
                    .forEach(p -> {
                        String fileName = p.getFileName().toString();
                        String sessionId = fileName.substring(0, fileName.length() - 6);

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
     * Apply sort and limit using lite-read on sorted candidates.
     *
     * @param sessionFiles output map populated with (sessionId -> FileMeta) for every
     *                     valid session read during this call
     */
    private List<CodexHistoryReader.SessionInfo> applySortAndLimitLite(
            List<SessionCandidate> candidates,
            int limit,
            int offset,
            Map<String, FileMeta> sessionFiles
    ) {
        // Sort by mtime descending
        candidates.sort((a, b) -> {
            if (b.mtime != a.mtime) {
                return Long.compare(b.mtime, a.mtime);
            }
            return b.sessionId.compareTo(a.sessionId);
        });

        List<CodexHistoryReader.SessionInfo> sessions = new ArrayList<>();
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
                sessionFiles.put(rr.info.sessionId, new FileMeta(rr.path, rr.mtime));
                if (sessions.size() >= want) {
                    break;
                }
            }
            // Always advance past the entire batch to avoid re-processing failed candidates
            i = batchEnd;
        }

        return deduplicateSessions(sessions);
    }

    /**
     * Batch read session files using lite-read. Each result carries the file path
     * (so callers can persist fileRelativePath) and its mtime (so callers can persist
     * fileLastModified without a second stat). lite-read already stats the file, so
     * the mtime is free; fallback paths pay a single extra stat.
     */
    private List<ReadResult> batchReadLite(List<Path> filePaths) {
        List<CompletableFuture<ReadResult>> futures = new ArrayList<>();

        for (Path path : filePaths) {
            futures.add(CompletableFuture.supplyAsync(() -> {
                try {
                    CodexSessionLiteReader.CodexLiteSessionInfo liteInfo = this.liteReader.readSessionLite(path);
                    if (liteInfo != null) {
                        return new ReadResult(convertToSessionInfo(liteInfo), path, liteInfo.lastModified);
                    }
                    CodexHistoryReader.SessionInfo info = fallbackFullScan(path);
                    long mtime = info != null ? safeStatMillis(path) : 0L;
                    return new ReadResult(info, path, mtime);
                } catch (Exception e) {
                    LOG.debug("[CodexHistoryIndexService] Lite-read failed for " + path + ", trying fallback: " + e.getMessage());
                    CodexHistoryReader.SessionInfo info = fallbackFullScan(path);
                    long mtime = info != null ? safeStatMillis(path) : 0L;
                    return new ReadResult(info, path, mtime);
                }
            }, LITE_READ_POOL));
        }

        List<ReadResult> results = new ArrayList<>();
        for (CompletableFuture<ReadResult> future : futures) {
            try {
                ReadResult rr = future.get(10, TimeUnit.SECONDS);
                if (rr.info != null && this.parser.isValidSession(rr.info)) {
                    results.add(rr);
                }
            } catch (Exception e) {
                LOG.warn("[CodexHistoryIndexService] Failed to read session: " + e.getMessage());
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

    private record ReadResult(CodexHistoryReader.SessionInfo info, Path path, long mtime) {
    }

    /**
     * Fallback to full scan when lite-read fails.
     */
    private CodexHistoryReader.SessionInfo fallbackFullScan(Path path) {
        try {
            return this.parser.parseSessionFile(path);
        } catch (Exception e) {
            LOG.error("[CodexHistoryIndexService] Fallback scan failed for " + path + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Convert lite-read result to SessionInfo.
     */
    private CodexHistoryReader.SessionInfo convertToSessionInfo(CodexSessionLiteReader.CodexLiteSessionInfo liteInfo) {
        CodexHistoryReader.SessionInfo session = new CodexHistoryReader.SessionInfo();
        session.sessionId = liteInfo.sessionId;
        session.title = liteInfo.summary;
        session.messageCount = liteInfo.messageCount;
        session.lastTimestamp = liteInfo.lastModified;
        session.firstTimestamp = liteInfo.createdAt;
        session.cwd = liteInfo.cwd;
        session.fileSize = liteInfo.fileSize;
        return session;
    }

    /**
     * Apply sort and limit to existing session list.
     */
    private List<CodexHistoryReader.SessionInfo> applySortAndLimit(
            List<CodexHistoryReader.SessionInfo> sessions,
            int limit,
            int offset
    ) {
        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        if (offset > 0) {
            sessions = new ArrayList<>(sessions.subList(Math.min(offset, sessions.size()), sessions.size()));
        }

        if (limit > 0 && sessions.size() > limit) {
            sessions = new ArrayList<>(sessions.subList(0, limit));
        }

        return deduplicateSessions(sessions);
    }

    private List<CodexHistoryReader.SessionInfo> restoreSessionsFromIndex(SessionIndexManager.ProjectIndex projectIndex) {
        List<CodexHistoryReader.SessionInfo> sessions = new ArrayList<>();
        for (SessionIndexManager.SessionIndexEntry entry : projectIndex.sessions) {
            CodexHistoryReader.SessionInfo session = new CodexHistoryReader.SessionInfo();
            session.sessionId = entry.sessionId;
            session.title = entry.title;
            session.messageCount = entry.messageCount;
            session.lastTimestamp = entry.lastTimestamp;
            session.firstTimestamp = entry.firstTimestamp;
            session.cwd = entry.cwd;
            session.fileSize = entry.fileSize;
            sessions.add(session);
        }
        return deduplicateSessions(sessions);
    }

    private void updateCodexIndex(
            SessionIndexManager.SessionIndex index,
            String cacheKey,
            List<CodexHistoryReader.SessionInfo> sessions,
            Map<String, FileMeta> sessionFiles
    ) throws IOException {
        List<CodexHistoryReader.SessionInfo> deduplicatedSessions = deduplicateSessions(sessions);
        SessionIndexManager.ProjectIndex projectIndex = new SessionIndexManager.ProjectIndex();
        projectIndex.lastDirScanTime = System.currentTimeMillis();
        projectIndex.fileCount = countSessionFiles();

        for (CodexHistoryReader.SessionInfo session : deduplicatedSessions) {
            SessionIndexManager.SessionIndexEntry entry = new SessionIndexManager.SessionIndexEntry();
            entry.sessionId = session.sessionId;
            entry.title = session.title;
            entry.messageCount = session.messageCount;
            entry.lastTimestamp = session.lastTimestamp;
            entry.firstTimestamp = session.firstTimestamp;
            entry.cwd = session.cwd;
            entry.fileSize = session.fileSize;

            FileMeta meta = sessionFiles.get(session.sessionId);
            if (meta != null && meta.path != null) {
                try {
                    entry.fileRelativePath = this.sessionsDir.relativize(meta.path).toString();
                    entry.fileLastModified = meta.mtime;
                } catch (Exception e) {
                    LOG.debug("[CodexHistoryIndexService] Failed to relativize " + meta.path + ": " + e.getMessage());
                }
            }

            projectIndex.sessions.add(entry);
        }

        index.projects.put(cacheKey, projectIndex);
    }

    static List<CodexHistoryReader.SessionInfo> deduplicateSessions(List<CodexHistoryReader.SessionInfo> sessions) {
        Map<String, CodexHistoryReader.SessionInfo> deduplicated = new LinkedHashMap<>();

        for (CodexHistoryReader.SessionInfo session : sessions) {
            if (session == null || session.sessionId == null || session.sessionId.isEmpty()) {
                continue;
            }

            CodexHistoryReader.SessionInfo existing = deduplicated.get(session.sessionId);
            deduplicated.put(session.sessionId, mergeSessionInfo(existing, session));
        }

        List<CodexHistoryReader.SessionInfo> result = new ArrayList<>(deduplicated.values());
        result.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));
        return result;
    }

    private static CodexHistoryReader.SessionInfo mergeSessionInfo(
            CodexHistoryReader.SessionInfo existing,
            CodexHistoryReader.SessionInfo incoming
    ) {
        if (existing == null) {
            return copySession(incoming);
        }

        CodexHistoryReader.SessionInfo preferred = incoming.lastTimestamp >= existing.lastTimestamp ? incoming : existing;
        CodexHistoryReader.SessionInfo fallback = preferred == incoming ? existing : incoming;
        CodexHistoryReader.SessionInfo merged = copySession(preferred);

        merged.lastTimestamp = Math.max(existing.lastTimestamp, incoming.lastTimestamp);
        if (merged.firstTimestamp == 0 || (fallback.firstTimestamp > 0 && fallback.firstTimestamp < merged.firstTimestamp)) {
            merged.firstTimestamp = fallback.firstTimestamp;
        }
        merged.messageCount = Math.max(existing.messageCount, incoming.messageCount);
        if ((merged.title == null || merged.title.isEmpty()) && fallback.title != null && !fallback.title.isEmpty()) {
            merged.title = fallback.title;
        }
        if ((merged.cwd == null || merged.cwd.isEmpty()) && fallback.cwd != null && !fallback.cwd.isEmpty()) {
            merged.cwd = fallback.cwd;
        }
        merged.fileSize = Math.max(existing.fileSize, incoming.fileSize);

        return merged;
    }

    private static CodexHistoryReader.SessionInfo copySession(CodexHistoryReader.SessionInfo session) {
        CodexHistoryReader.SessionInfo copy = new CodexHistoryReader.SessionInfo();
        copy.sessionId = session.sessionId;
        copy.title = session.title;
        copy.messageCount = session.messageCount;
        copy.lastTimestamp = session.lastTimestamp;
        copy.firstTimestamp = session.firstTimestamp;
        copy.cwd = session.cwd;
        copy.fileSize = session.fileSize;
        return copy;
    }

    private int countSessionFiles() throws IOException {
        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            return (int) paths
                    .filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(".jsonl"))
                    .count();
        }
    }

    /**
     * Candidate session file for stat-first sorting.
     */
    private record SessionCandidate(String sessionId, Path filePath, long mtime) {
    }
}