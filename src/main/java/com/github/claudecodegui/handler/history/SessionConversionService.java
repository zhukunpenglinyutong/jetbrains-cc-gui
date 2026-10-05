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
import java.util.function.Supplier;
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

    /**
     * Resolves the {@code ~/.claude/projects} base per call. Injected rather than hardcoded
     * so the batch converter tests can point the file rewrite at a temporary directory
     * instead of the developer's real session history.
     */
    private final Supplier<Path> projectsDirSupplier;

    private static final String ENTRYPOINT_CLI = SessionEntrypoint.CLI.getValue();

    SessionConversionService(HandlerContext context) {
        this(context, () -> Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude", "projects"));
    }

    /**
     * @param context handler context, may be null in tests that only exercise pure logic.
     * @param projectsDirSupplier resolves the projects root per call.
     */
    SessionConversionService(HandlerContext context, Supplier<Path> projectsDirSupplier) {
        this.context = context;
        this.projectsDirSupplier = projectsDirSupplier;
    }

    /**
     * Resolve {@code ~/.claude/projects} at call time. A static field would snapshot the
     * Windows home at class-load, but a WSL node stores sessions under the WSL filesystem;
     * {@link NodeDetector#resolveHomeForFileOps()} returns the correct home for the active
     * node. Every other history service in this package was migrated the same way.
     */
    private Path projectsDir() {
        return this.projectsDirSupplier.get();
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
            ConversionResultCode resultCode = this.convertSession(sessionId, projectPath);
            this.sendConversionResult(resultCode == null, resultCode);
        });
    }

    /**
     * Convert one session's jsonl on the calling thread and report the outcome as a code.
     *
     * <p>This is the shared core behind both the single-session bridge command and the
     * batch command: it owns the lock/backup/atomic-move dance and returns instead of
     * pushing to the webview, so a caller can aggregate many outcomes into one reply.
     *
     * @param sessionId Session ID to convert (assumed already validated and non-active).
     * @param projectPath Project path hint, or null to scan every project directory.
     * @return null when the session was rewritten, otherwise the failure/notice code.
     */
    ConversionResultCode convertSession(String sessionId, String projectPath) {
        Path sessionFile = null;
        Path tempFile = null;
        Path backupFile = null;
        FileLock fileLock = null;
        FileChannel fileChannel = null;
        // Flipped to true only once the backup provably holds every byte of the
        // source. A temp file is created empty, so a copy that died half way leaves a
        // fragment on disk; restoring that fragment would replace a complete session
        // with its own first half, silently and with no error shown to the user.
        boolean backupComplete = false;
        long backupSourceSize = 0L;

        try {
            sessionFile = this.findSessionFile(sessionId, projectPath);
            if (sessionFile == null) {
                LOG.warn("[SessionConversionService] Session file not found: " + sessionId);
                return ConversionResultCode.SESSION_NOT_FOUND;
            }

            // The finder only returns existing files; this catches a narrow TOCTOU
            // window where another process deletes the file after discovery.
            if (!Files.exists(sessionFile)) {
                LOG.warn("[SessionConversionService] Session file does not exist: " + sessionFile);
                return ConversionResultCode.FILE_NOT_EXIST;
            }

            // Acquire file lock to prevent concurrent modification
            try {
                fileChannel = FileChannel.open(sessionFile, StandardOpenOption.WRITE);
                fileLock = fileChannel.tryLock();
                if (fileLock == null) {
                    LOG.warn("[SessionConversionService] Session file is locked by another process: " + sessionId);
                    return ConversionResultCode.FILE_LOCKED;
                }
            } catch (OverlappingFileLockException e) {
                LOG.warn("[SessionConversionService] Session file is already locked: " + sessionId);
                return ConversionResultCode.FILE_LOCKED;
            }

            // Create unique files in the same directory so the final move can stay atomic.
            // They are created owner-only: they hold a verbatim copy of the session.
            Path sessionDir = sessionFile.getParent();
            backupFile = SessionTempFiles.createPrivateTempFile(sessionDir, sessionId + ".jsonl.backup.", ".tmp");
            backupSourceSize = Files.size(sessionFile);
            this.copyBackup(sessionFile, backupFile);
            long backupSize = Files.size(backupFile);
            if (backupSize != backupSourceSize) {
                // Returned without an error but wrote fewer bytes. Treat it exactly
                // like a failed copy: no usable backup means no restore, and the
                // session on disk is by definition still intact.
                LOG.warn("[SessionConversionService] Backup of " + sessionId + " is short ("
                        + backupSize + " of " + backupSourceSize + " bytes); leaving the session untouched");
                return ConversionResultCode.CONVERSION_FAILED;
            }
            backupComplete = true;
            LOG.debug("[SessionConversionService] Created backup: " + backupFile);

            tempFile = SessionTempFiles.createPrivateTempFile(sessionDir, sessionId + ".jsonl.convert.", ".tmp");

            this.afterCompleteBackup(sessionFile);

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
                    return ConversionResultCode.ALREADY_CLI_SESSION;
                }
                LOG.debug("[SessionConversionService] Session is not an SDK-created session: " + sessionId);
                return ConversionResultCode.NOT_SDK_SESSION;
            }

            // Our work through the locked handle is done; release it before the
            // swap so the atomic move (and any backup restore) cannot trip over
            // our own open handle on Windows.
            releaseFileLock(fileLock, fileChannel);

            // Re-read the active session here, on the pooled thread, immediately
            // before the swap. The check in convertSdkSession ran on the calling
            // thread, and everything above took time; in that window the user can
            // open this very session in the chat, which puts the SDK back into
            // append mode. Replacing the file underneath a live writer would strand
            // every message appended from here on, so refuse instead.
            if (this.isSessionActive(sessionId)) {
                LOG.warn("[SessionConversionService] Conversion abandoned: session became active while converting");
                return ConversionResultCode.SESSION_ACTIVE;
            }

            // Atomic move: replace original file with modified temp file
            Files.move(tempFile, sessionFile, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            tempFile = null; // Mark as successfully moved

            LOG.debug("[SessionConversionService] Successfully converted session: " + sessionId
                    + " (" + modifiedCount.get() + " lines modified)");

            // No explicit index invalidation needed: the rewrite bumped the file
            // mtime so the incremental scan re-reads this session, and the
            // frontend follows success with a deep_search_history reload anyway.
            return null;

        } catch (Exception e) {
            // warn, not error: this branch recovers. The session is rolled back from its
            // backup below and the caller gets CONVERSION_FAILED, so nothing is lost and
            // the plugin has not malfunctioned — surfacing an IDE error report for a
            // handled condition would be misleading. It would also be actively harmful
            // here: a logger whose error() throws (DefaultLogger, used whenever no IDE
            // application is installed, which includes the unit-test JVM) would abort
            // this method before the restore below ever ran, turning a recoverable
            // failure into exactly the data loss this branch exists to prevent.
            LOG.warn("[SessionConversionService] Failed to convert session: " + e.getMessage(), e);

            // Release our own lock first so the restore move cannot fail on it (Windows).
            releaseFileLock(fileLock, fileChannel);

            // Restore only from a backup that is known to hold every byte of the
            // original. A temp file is created empty, so the copy that produced it
            // may have written only a prefix; writing that back over the session
            // would look like a successful rollback while actually truncating the
            // user's history. Without a complete backup the session file was never
            // modified, so the correct action is to leave it alone.
            if (backupComplete) {
                this.restoreBackup(backupFile, sessionFile, backupSourceSize);
            } else {
                LOG.warn("[SessionConversionService] No complete backup for " + sessionId
                        + "; the session file was not touched and stays as it is on disk");
            }

            return ConversionResultCode.CONVERSION_FAILED;
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
    }

    /**
     * No-op hook, invoked once the backup is known to hold every byte of the session
     * and the scratch temp file exists, immediately before the rewrite runs.
     *
     * <p>This is the first point at which a failure is still recoverable, and the last
     * point at which the file is still exactly as big as the backup — so it is where
     * the restore in the {@code catch} block has to be exercised from. It exists so
     * tests can abort there and, at the same time, move the file the way a concurrent
     * writer (grew) or a truncation (shrank) would: with nothing touching the file its
     * size always still equals the size the backup was taken at, and the two size
     * guards in {@link #restoreBackup} could never be reached.
     *
     * <p>Empty in production; subclasses in tests override it to inject the failure.
     *
     * @param sessionFile the file being converted.
     * @throws IOException to simulate a rewrite that died after the backup was taken.
     */
    // VisibleForTesting
    void afterCompleteBackup(Path sessionFile) throws IOException {
    }

    /**
     * Copy the session file to the backup path.
     *
     * <p>Split out so tests can simulate a copy that dies part way through — ENOSPC,
     * EIO, a network share going away — without filling an actual disk.
     *
     * @param source session file to copy.
     * @param backup already-created, empty destination.
     * @throws IOException if the copy fails, possibly after writing part of the file.
     */
    // VisibleForTesting
    void copyBackup(Path source, Path backup) throws IOException {
        Files.copy(source, backup, StandardCopyOption.REPLACE_EXISTING);
    }

    /**
     * Put the original session file back after a failed rewrite.
     *
     * <p>Only reached for a complete backup. Even then the restore is skipped when the
     * file has grown since the snapshot was taken: a writer that appended in between
     * would lose those rows, and rows newer than T0 are worth more than the older
     * snapshot. A file that shrank means something truncated it, and then the complete
     * backup is the only good copy left, so that case is restored.
     *
     * @param backupFile the verified backup, may be null when it was already moved.
     * @param sessionFile the session file to put the backup back in place of.
     * @param expectedSize size the session file had when the backup was taken.
     */
    private void restoreBackup(Path backupFile, Path sessionFile, long expectedSize) {
        if (backupFile == null || !Files.exists(backupFile)) {
            return;
        }
        try {
            long currentSize = Files.size(sessionFile);
            if (currentSize > expectedSize) {
                LOG.warn("[SessionConversionService] " + sessionFile.getFileName()
                        + " grew after the backup was taken (" + currentSize + " > " + expectedSize
                        + " bytes); not restoring the older snapshot over it");
                return;
            }
            Files.move(backupFile, sessionFile, StandardCopyOption.REPLACE_EXISTING);
            LOG.info("[SessionConversionService] Restored session from backup after failure");
        } catch (Exception restoreError) {
            LOG.error("[SessionConversionService] Failed to restore backup: "
                    + restoreError.getMessage(), restoreError);
        }
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
        String activeSessionId = this.activeSessionId();
        return activeSessionId != null && activeSessionId.equals(sessionId);
    }

    /**
     * Id of the session this window is currently chatting in, or null when there is none.
     * Read from the handler context at call time — the session changes as the user switches
     * chats, so it must never be cached.
     *
     * @return active session id, or null.
     */
    String activeSessionId() {
        try {
            var session = this.context.getSession();
            return session != null ? session.getSessionId() : null;
        } catch (Exception e) {
            LOG.warn("[SessionConversionService] Failed to resolve active session: " + e.getMessage());
            return null;
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
        // Resolve symlinks first: the CLI stores sessions under the physical path's key (issue #1789)
        String sanitized = PathUtils.sanitizePath(PathUtils.realPath(projectPath));
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
            // escapeJs() runs on the serialized JSON, which is the right order here:
            // it escapes the payload for a JS string literal AFTER the JSON quotes are
            // in place. Every character it rewrites is a valid JSON escape too, so the
            // JS parser reverses it and the frontend still receives the exact JSON text.
            String escapedJson = this.context.escapeJs(this.gson.toJson(result));
            String jsCode = "if (window.onConversionResult) { window.onConversionResult('" + escapedJson + "'); }";
            this.context.executeJavaScriptQueued(jsCode);
        }
    }
}
