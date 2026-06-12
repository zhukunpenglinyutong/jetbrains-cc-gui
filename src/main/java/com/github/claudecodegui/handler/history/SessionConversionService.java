package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

/**
 * Service to convert SDK-created sessions to CLI-recognizable sessions.
 * Changes entrypoint from "sdk-cli" to "cli" so sessions appear in CLI's /resume list.
 *
 * @author Gadfly
 */
class SessionConversionService {

    private static final Logger LOG = Logger.getInstance(SessionConversionService.class);

    private final HandlerContext context;
    private final Gson gson = new Gson();

    private static final String ENTRYPOINT_CLI = SessionEntrypoint.CLI.getValue();

    SessionConversionService(HandlerContext context) {
        this.context = context;
    }

    /**
     * Resolve {@code ~/.claude/projects} at call time. A static field would snapshot the
     * Windows home at class-load, but a WSL node stores sessions under the WSL filesystem;
     * {@link NodeDetector#resolveHomeForFileOps()} returns the correct home for the active
     * node. Every other history service in this package was migrated the same way.
     */
    private static Path projectsDir() {
        return Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude", "projects");
    }

    /**
     * Convert the IDE project base path to the form Claude CLI used when it created the
     * session directory. A WSL node keys projects by their Linux path, so the host
     * {@code D:\proj} must become {@code /mnt/d/proj} before sanitizing; a native node
     * keeps the path as-is. Mirrors {@code HistoryDeleteService}.
     */
    private static String resolveProjectPathForFileOps(String rawProjectPath) {
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        return NodeDetector.isWslPath(nodePath)
                ? NodeDetector.convertToWslPath(rawProjectPath)
                : rawProjectPath;
    }

    /**
     * Convert a non-CLI session to CLI-recognizable session.
     * Changes entrypoint from "sdk-cli" or "claude-vscode" to "cli" in the session file.
     * Uses atomic write with temporary file to ensure file integrity.
     *
     * @param sessionId Session ID to convert.
     * @param projectPath Project path (optional, will scan all projects if null).
     */
    void convertSdkSession(String sessionId, String projectPath) {
        if (!HistoryDeleteService.isValidSessionId(sessionId)) {
            LOG.warn("[SessionConversionService] Conversion rejected: invalid sessionId");
            this.sendConversionResult(false, ConversionResultCode.INVALID_SESSION_ID);
            return;
        }

        // Refuse to convert the session this window is still chatting in: the SDK
        // process keeps appending to the jsonl, and replacing the file underneath
        // it would silently drop those messages onto the old inode.
        if (this.isSessionActive(sessionId)) {
            LOG.warn("[SessionConversionService] Conversion rejected: session is active");
            this.sendConversionResult(false, ConversionResultCode.SESSION_ACTIVE);
            return;
        }

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            Path sessionFile = null;
            Path tempFile = null;
            Path backupFile = null;
            FileLock fileLock = null;
            FileChannel fileChannel = null;

            try {
                sessionFile = this.findSessionFile(sessionId, projectPath);
                if (sessionFile == null) {
                    LOG.warn("[SessionConversionService] Session file not found: " + sessionId);
                    this.sendConversionResult(false, ConversionResultCode.SESSION_NOT_FOUND);
                    return;
                }

                // The finder only returns existing files; this catches a narrow TOCTOU
                // window where another process deletes the file after discovery.
                if (!Files.exists(sessionFile)) {
                    LOG.warn("[SessionConversionService] Session file does not exist: " + sessionFile);
                    this.sendConversionResult(false, ConversionResultCode.FILE_NOT_EXIST);
                    return;
                }

                // Acquire file lock to prevent concurrent modification
                try {
                    fileChannel = FileChannel.open(sessionFile, StandardOpenOption.WRITE);
                    fileLock = fileChannel.tryLock();
                    if (fileLock == null) {
                        LOG.warn("[SessionConversionService] Session file is locked by another process: " + sessionId);
                        this.sendConversionResult(false, ConversionResultCode.FILE_LOCKED);
                        return;
                    }
                } catch (OverlappingFileLockException e) {
                    LOG.warn("[SessionConversionService] Session file is already locked: " + sessionId);
                    this.sendConversionResult(false, ConversionResultCode.FILE_LOCKED);
                    return;
                }

                // Create unique files in the same directory so the final move can stay atomic.
                Path sessionDir = sessionFile.getParent();
                backupFile = Files.createTempFile(sessionDir, sessionId + ".jsonl.backup.", ".tmp");
                Files.copy(sessionFile, backupFile, StandardCopyOption.REPLACE_EXISTING);
                LOG.debug("[SessionConversionService] Created backup: " + backupFile);

                tempFile = Files.createTempFile(sessionDir, sessionId + ".jsonl.convert.", ".tmp");

                // Stream processing to handle large files efficiently
                AtomicInteger modifiedCount = new AtomicInteger(0);
                AtomicBoolean hasCliEntrypoint = new AtomicBoolean(false);

                try (Stream<String> lines = Files.lines(sessionFile, StandardCharsets.UTF_8);
                     BufferedWriter writer = Files.newBufferedWriter(tempFile, StandardCharsets.UTF_8)) {

                    lines.forEach(line -> {
                        try {
                            String newLine = this.convertEntrypointInLine(
                                    line,
                                    hasCliEntrypoint,
                                    modifiedCount
                            );
                            writer.write(newLine);
                            writer.newLine();
                        } catch (IOException e) {
                            throw new UncheckedIOException(e);
                        }
                    });
                } catch (UncheckedIOException e) {
                    // UncheckedIOException wraps the IOException thrown inside the lambda.
                    // Unwrap and rethrow so the outer catch(Exception) handles it uniformly.
                    throw e.getCause();
                } catch (IOException e) {
                    LOG.error("[SessionConversionService] IO error writing temp file: " + tempFile, e);
                    throw e;
                }

                // Check if any modifications were made
                if (modifiedCount.get() == 0) {
                    if (hasCliEntrypoint.get()) {
                        LOG.debug("[SessionConversionService] Session is already a CLI session: " + sessionId);
                        this.sendConversionResult(true, ConversionResultCode.ALREADY_CLI_SESSION);
                    } else {
                        LOG.debug("[SessionConversionService] Session is not an SDK-created session: " + sessionId);
                        this.sendConversionResult(false, ConversionResultCode.NOT_SDK_SESSION);
                    }
                    return;
                }

                // Our work through the locked handle is done; release it before the
                // swap so the atomic move (and any backup restore) cannot trip over
                // our own open handle on Windows.
                releaseFileLock(fileLock, fileChannel);

                // Atomic move: replace original file with modified temp file
                Files.move(tempFile, sessionFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                tempFile = null; // Mark as successfully moved

                LOG.debug("[SessionConversionService] Successfully converted session: " + sessionId
                        + " (" + modifiedCount.get() + " lines modified)");

                // No explicit index invalidation needed: the rewrite bumped the file
                // mtime so the incremental scan re-reads this session, and the
                // frontend follows success with a deep_search_history reload anyway.
                this.sendConversionResult(true, null);

            } catch (Exception e) {
                LOG.error("[SessionConversionService] Failed to convert session: " + e.getMessage(), e);

                // Release our own lock first so the restore move cannot fail on it (Windows).
                releaseFileLock(fileLock, fileChannel);

                // Restore from backup if conversion failed
                if (backupFile != null && Files.exists(backupFile)) {
                    try {
                        Files.move(backupFile, sessionFile, StandardCopyOption.REPLACE_EXISTING);
                        LOG.info("[SessionConversionService] Restored session from backup after failure");
                    } catch (Exception restoreError) {
                        LOG.error("[SessionConversionService] Failed to restore backup: "
                                + restoreError.getMessage(), restoreError);
                    }
                }

                this.sendConversionResult(false, ConversionResultCode.CONVERSION_FAILED);
            } finally {
                // Idempotent: no-op if the success/failure paths already released it.
                releaseFileLock(fileLock, fileChannel);

                // Clean up temporary and backup files
                try {
                    if (tempFile != null && Files.exists(tempFile)) {
                        Files.deleteIfExists(tempFile);
                        LOG.debug("[SessionConversionService] Cleaned up temp file: " + tempFile);
                    }
                    if (backupFile != null && Files.exists(backupFile)) {
                        Files.deleteIfExists(backupFile);
                        LOG.debug("[SessionConversionService] Cleaned up backup file: " + backupFile);
                    }
                } catch (IOException cleanupError) {
                    LOG.warn("[SessionConversionService] Failed to clean up temporary files: "
                            + cleanupError.getMessage());
                }
            }
        });
    }

    /**
     * Convert the top-level entrypoint field in one JSONL row.
     *
     * @param line JSONL row to parse.
     * @param hasCliEntrypoint whether any row already identified itself as CLI.
     * @param modifiedCount number of rows modified so far.
     * @return original or converted JSON row.
     */
    // Package-private so SessionConversionServiceTest can exercise the per-row rewrite directly.
    String convertEntrypointInLine(
            String line,
            AtomicBoolean hasCliEntrypoint,
            AtomicInteger modifiedCount
    ) {
        JsonObject row;
        try {
            row = this.gson.fromJson(line, JsonObject.class);
        } catch (JsonSyntaxException e) {
            LOG.warn("[SessionConversionService] Keeping non-JSON session row unchanged");
            return line;
        }

        if (row == null || !row.has("entrypoint") || row.get("entrypoint").isJsonNull()
                || !row.get("entrypoint").isJsonPrimitive()) {
            return line;
        }

        String entrypoint = row.get("entrypoint").getAsString();
        SessionEntrypoint parsedEntrypoint = SessionEntrypoint.fromValue(entrypoint);
        if (parsedEntrypoint == SessionEntrypoint.CLI) {
            hasCliEntrypoint.set(true);
            return line;
        }

        if (!parsedEntrypoint.isConvertibleToCli()) {
            return line;
        }

        row.addProperty("entrypoint", ENTRYPOINT_CLI);
        modifiedCount.incrementAndGet();
        return this.gson.toJson(row);
    }

    /**
     * Check whether the given session is the one currently active in this window.
     *
     * @param sessionId Session ID to check.
     * @return true if the session is active and must not be converted.
     */
    private boolean isSessionActive(String sessionId) {
        try {
            var session = this.context.getSession();
            return session != null && sessionId.equals(session.getSessionId());
        } catch (Exception e) {
            LOG.warn("[SessionConversionService] Failed to check active session: " + e.getMessage());
            return false;
        }
    }

    /**
     * Release the file lock and close the channel, tolerating repeat calls.
     *
     * @param fileLock Lock to release, may be null or already released.
     * @param fileChannel Channel to close, may be null or already closed.
     */
    private static void releaseFileLock(FileLock fileLock, FileChannel fileChannel) {
        try {
            if (fileLock != null && fileLock.isValid()) {
                fileLock.release();
            }
            if (fileChannel != null && fileChannel.isOpen()) {
                fileChannel.close();
            }
        } catch (IOException lockError) {
            LOG.warn("[SessionConversionService] Failed to release file lock: " + lockError.getMessage());
        }
    }

    /**
     * Find session file by sessionId.
     *
     * @param sessionId Session ID.
     * @param projectPath Project path (optional).
     * @return Session file path, or null if not found.
     */
    private Path findSessionFile(String sessionId, String projectPath) {
        try {
            Path projectsDir = projectsDir();
            if (projectPath != null && !projectPath.isEmpty()) {
                Path projectDir = this.getProjectDir(projectsDir, resolveProjectPathForFileOps(projectPath));
                Path sessionFile = projectDir.resolve(sessionId + ".jsonl");
                if (Files.exists(sessionFile)) {
                    return sessionFile;
                }
            }

            // Scan all project directories
            if (!Files.exists(projectsDir)) {
                return null;
            }

            LOG.debug("[SessionConversionService] Scanning project directories for session: " + sessionId);
            try (var stream = Files.newDirectoryStream(projectsDir)) {
                for (Path projectDir : stream) {
                    if (!Files.isDirectory(projectDir)) {
                        continue;
                    }
                    Path sessionFile = projectDir.resolve(sessionId + ".jsonl");
                    if (Files.exists(sessionFile)) {
                        return sessionFile;
                    }
                }
                return null;
            }
        } catch (Exception e) {
            LOG.error("[SessionConversionService] Error finding session file: " + e.getMessage(), e);
            return null;
        }
    }

    /**
     * Get project directory path.
     *
     * @param projectsDir Resolved {@code ~/.claude/projects} base.
     * @param projectPath Project path.
     * @return Project directory path.
     */
    private Path getProjectDir(Path projectsDir, String projectPath) {
        String sanitized = PathUtils.sanitizePath(projectPath);
        return projectsDir.resolve(sanitized);
    }

    /**
     * Send conversion result to frontend via the safe HandlerContext helper.
     * On failure the code is sent as errorCode; on success it is sent as
     * infoCode (extra context such as ALREADY_CLI_SESSION), keeping the two
     * semantics apart for the frontend.
     *
     * @param success Whether conversion was successful.
     * @param code Result code, or null for a plain success.
     */
    private void sendConversionResult(boolean success, ConversionResultCode code) {
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        if (code != null) {
            result.addProperty(success ? "infoCode" : "errorCode", code.getCode());
        }

        Project project = this.context.getProject();
        if (project != null && !project.isDisposed()) {
            String escapedJson = this.context.escapeJs(this.gson.toJson(result));
            String jsCode = "if (window.onConversionResult) { window.onConversionResult('" + escapedJson + "'); }";
            this.context.executeJavaScriptOnEDT(jsCode);
        }
    }
}
