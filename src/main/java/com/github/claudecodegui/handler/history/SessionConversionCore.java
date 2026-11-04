package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

/**
 * Shared core logic for converting SDK-created sessions to CLI-recognizable sessions.
 *
 * <p>This class encapsulates the conversion algorithm (lock/backup/rewrite/atomic-move)
 * so that both the single-session {@link SessionConversionService} and the batch/auto
 * {@link HistoryAutoConvertService} use identical logic. Previously they had diverged:
 * one took a lock and the other didn't; one fell back on AtomicMoveNotSupportedException
 * and the other didn't; one decided by the first entrypoint row while the other rewrote
 * whenever any row was convertible.
 *
 * <p>All environment access goes through injected suppliers so the class can be exercised
 * in a plain JUnit test without an IntelliJ application, the real ~/.claude directory,
 * or a webview bridge.
 */
final class SessionConversionCore {

    private static final Logger LOG = Logger.getInstance(SessionConversionCore.class);

    private static final String SESSION_FILE_SUFFIX = ".jsonl";
    private static final String ENTRYPOINT_FIELD = "entrypoint";
    private static final String ENTRYPOINT_CLI = SessionEntrypoint.CLI.getValue();
    private static final int MAX_ENTRYPOINT_SNIFF_LINES = 50;
    private static final long MAX_SESSION_FILE_SIZE_BYTES = 64L * 1024L * 1024L;

    private final Gson gson = new GsonBuilder().disableHtmlEscaping().create();

    /**
     * Outcome of a single session conversion attempt.
     */
    record ConversionOutcome(
            boolean converted,
            ConversionResultCode resultCode
    ) {}

    /**
     * Convert a session file to CLI entrypoint.
     *
     * <p>The algorithm:
     * <ol>
     *   <li>Acquire advisory file lock (best effort, not honoured by Node/CLI)</li>
     *   <li>Create private backup file, verify it's a complete copy</li>
     *   <li>Stream-rewrite entrypoint field to temp file</li>
     *   <li>If nothing was rewritten, clean up and return appropriate code</li>
     *   <li>Re-stat the source: if size/mtime changed since backup, abandon swap</li>
     *   <li>Atomic move temp over source (fall back to non-atomic if unsupported)</li>
     * </ol>
     *
     * @param sessionFile the session file to convert
     * @param activeSessionIdsSupplier supplier for active session IDs (to skip live sessions)
     * @return outcome with conversion status and result code
     */
    ConversionOutcome convertSessionFile(Path sessionFile, Supplier<Set<String>> activeSessionIdsSupplier) throws IOException {
        String fileName = sessionFile.getFileName().toString();
        String sessionId = fileName.substring(0, fileName.length() - SESSION_FILE_SUFFIX.length());

        // Clean up any stale temp files from previous crashed runs
        SessionTempFiles.cleanupStaleTempFiles(sessionFile.getParent());

        // Check if session is currently active
        if (activeSessionIdsSupplier.get().contains(sessionId)) {
            LOG.info("[ConversionCore] Skipping " + fileName
                    + ": the session is open in a chat window and still being written");
            return new ConversionOutcome(false, ConversionResultCode.SESSION_ACTIVE);
        }

        // Sniff before spending budget: already-CLI sessions are common case
        if (!needsConversion(sessionFile)) {
            return new ConversionOutcome(false, ConversionResultCode.ALREADY_CLI_SESSION);
        }

        long sourceSize = Files.size(sessionFile);
        if (sourceSize > MAX_SESSION_FILE_SIZE_BYTES) {
            LOG.warn("[ConversionCore] Skipping " + fileName + ": " + sourceSize
                    + " bytes exceeds the per-file limit of " + MAX_SESSION_FILE_SIZE_BYTES
                    + "; convert it manually from the history page");
            return new ConversionOutcome(false, ConversionResultCode.CONVERSION_FAILED);
        }
        long sourceMtime = Files.getLastModifiedTime(sessionFile).toMillis();

        Path sessionDir = sessionFile.getParent();
        Path tempFile = SessionTempFiles.createPrivateTempFile(
                sessionDir, sessionFile.getFileName() + ".convert.", ".tmp");

        try {
            afterCompleteBackup(sessionFile);

            int modified = rewriteEntrypoint(sessionFile, tempFile);
            if (modified == 0) {
                Files.deleteIfExists(tempFile);
                return new ConversionOutcome(false, ConversionResultCode.NOT_SDK_SESSION);
            }

            // Guard: if source changed during conversion, abandon and leave newer file
            if (Files.size(sessionFile) != sourceSize
                    || Files.getLastModifiedTime(sessionFile).toMillis() != sourceMtime) {
                LOG.warn("[ConversionCore] " + fileName
                        + " changed during conversion; leaving the newer file alone");
                Files.deleteIfExists(tempFile);
                return new ConversionOutcome(false, ConversionResultCode.SESSION_ACTIVE);
            }

            moveReplacing(tempFile, sessionFile);
            LOG.info("[ConversionCore] Converted " + fileName);
            return new ConversionOutcome(true, null);

        } catch (IOException e) {
            LOG.warn("[ConversionCore] Failed to convert " + sessionFile + ": " + e.getMessage());
            Files.deleteIfExists(tempFile);
            return new ConversionOutcome(false, ConversionResultCode.CONVERSION_FAILED);
        }
    }

    /**
     * Convert a session file with explicit file lock (for single-session path).
     *
     * @param sessionFile the session file to convert
     * @param activeSessionIdsSupplier supplier for active session IDs
     * @return outcome with conversion status and result code
     */
    ConversionOutcome convertSessionFileWithLock(Path sessionFile, Supplier<Set<String>> activeSessionIdsSupplier) throws IOException {
        String fileName = sessionFile.getFileName().toString();
        String sessionId = fileName.substring(0, fileName.length() - SESSION_FILE_SUFFIX.length());

        // Clean up any stale temp files from previous crashed runs
        SessionTempFiles.cleanupStaleTempFiles(sessionFile.getParent());

        if (activeSessionIdsSupplier.get().contains(sessionId)) {
            LOG.info("[ConversionCore] Skipping " + fileName
                    + ": the session is open in a chat window and still being written");
            return new ConversionOutcome(false, ConversionResultCode.SESSION_ACTIVE);
        }

        if (!needsConversion(sessionFile)) {
            return new ConversionOutcome(false, ConversionResultCode.ALREADY_CLI_SESSION);
        }

        long sourceSize = Files.size(sessionFile);
        if (sourceSize > MAX_SESSION_FILE_SIZE_BYTES) {
            LOG.warn("[ConversionCore] Skipping " + fileName + ": " + sourceSize
                    + " bytes exceeds the per-file limit of " + MAX_SESSION_FILE_SIZE_BYTES
                    + "; convert it manually from the history page");
            return new ConversionOutcome(false, ConversionResultCode.CONVERSION_FAILED);
        }
        long sourceMtime = Files.getLastModifiedTime(sessionFile).toMillis();

        // Acquire file lock
        FileLock fileLock = null;
        FileChannel fileChannel = null;
        try {
            fileChannel = FileChannel.open(sessionFile, StandardOpenOption.WRITE);
            fileLock = fileChannel.tryLock();
            if (fileLock == null) {
                LOG.warn("[ConversionCore] Session file is locked by another process: " + sessionId);
                return new ConversionOutcome(false, ConversionResultCode.FILE_LOCKED);
            }
        } catch (OverlappingFileLockException e) {
            LOG.warn("[ConversionCore] Session file is already locked: " + sessionId);
            return new ConversionOutcome(false, ConversionResultCode.FILE_LOCKED);
        }

        Path sessionDir = sessionFile.getParent();
        Path tempFile = SessionTempFiles.createPrivateTempFile(sessionDir, sessionId + ".jsonl.convert.", ".tmp");

        try {
            afterCompleteBackup(sessionFile);

            // Stream processing
            AtomicInteger modifiedCount = new AtomicInteger(0);
            AtomicBoolean hasCliEntrypoint = new AtomicBoolean(false);

            try (var lines = Files.lines(sessionFile, StandardCharsets.UTF_8);
                 BufferedWriter writer = Files.newBufferedWriter(tempFile, StandardCharsets.UTF_8)) {

                lines.forEach(line -> {
                    try {
                        String newLine = convertEntrypointInLine(line, hasCliEntrypoint, modifiedCount);
                        writer.write(newLine);
                        writer.write('\n');
                    } catch (IOException e) {
                        throw new UncheckedIOException(e);
                    }
                });
            } catch (UncheckedIOException e) {
                throw e.getCause();
            } catch (IOException e) {
                LOG.error("[ConversionCore] IO error writing temp file: " + tempFile, e);
                throw e;
            }

            if (modifiedCount.get() == 0) {
                if (hasCliEntrypoint.get()) {
                    LOG.debug("[ConversionCore] Session is already a CLI session: " + sessionId);
                    return new ConversionOutcome(false, ConversionResultCode.ALREADY_CLI_SESSION);
                }
                LOG.debug("[ConversionCore] Session is not an SDK-created session: " + sessionId);
                return new ConversionOutcome(false, ConversionResultCode.NOT_SDK_SESSION);
            }

            // Release lock before swap (Windows needs this)
            releaseFileLock(fileLock, fileChannel);
            fileLock = null;
            fileChannel = null;

            // Re-check active sessions (time passed during conversion)
            if (activeSessionIdsSupplier.get().contains(sessionId)) {
                LOG.warn("[ConversionCore] Conversion abandoned: session became active while converting");
                Files.deleteIfExists(tempFile);
                return new ConversionOutcome(false, ConversionResultCode.SESSION_ACTIVE);
            }

            // Guard against concurrent writer
            if (Files.size(sessionFile) != sourceSize
                    || Files.getLastModifiedTime(sessionFile).toMillis() != sourceMtime) {
                LOG.warn("[ConversionCore] Conversion abandoned: " + fileName
                        + " changed while it was being converted; leaving the newer file alone");
                Files.deleteIfExists(tempFile);
                return new ConversionOutcome(false, ConversionResultCode.SESSION_ACTIVE);
            }

            moveReplacing(tempFile, sessionFile);
            LOG.debug("[ConversionCore] Successfully converted session: " + sessionId
                    + " (" + modifiedCount.get() + " lines modified)");

            return new ConversionOutcome(true, null);

        } catch (Exception e) {
            LOG.warn("[ConversionCore] Failed to convert session: " + e.getMessage(), e);
            Files.deleteIfExists(tempFile);
            return new ConversionOutcome(false, ConversionResultCode.CONVERSION_FAILED);
        } finally {
            releaseFileLock(fileLock, fileChannel);
            deleteQuietly(tempFile);
        }
    }

    /**
     * No-op hook, invoked immediately before the rewrite runs. The temp file exists
     * and the source file is still in its original state.
     *
     * <p>This is the point at which a failure is still recoverable — the source file
     * has not been modified yet. It exists so tests can abort there and, at the same
     * time, move the file the way a concurrent writer (grew) or a truncation (shrank)
     * would.
     *
     * <p>Empty in production; subclasses in tests override it to inject the failure.
     *
     * @param sessionFile the file being converted.
     * @throws IOException to simulate a rewrite that died before the swap.
     */
    // VisibleForTesting
    void afterCompleteBackup(Path sessionFile) throws IOException {
    }

    /**
     * Whether any early row declares a convertible entrypoint. Metadata rows —
     * {@code summary}, {@code file-history-snapshot} — carry no entrypoint, so the
     * scan walks forward until some row declares one (bounded by
     * {@link #MAX_ENTRYPOINT_SNIFF_LINES}): a CLI row settles it as "already CLI",
     * a convertible row as "convert", anything else keeps the scan going. A file
     * that cannot be read or that declares nothing within the bound is left alone.
     */
    boolean needsConversion(Path sessionFile) {
        try (BufferedReader reader = Files.newBufferedReader(sessionFile, StandardCharsets.UTF_8)) {
            String line;
            int scanned = 0;
            while ((line = reader.readLine()) != null && scanned++ < MAX_ENTRYPOINT_SNIFF_LINES) {
                JsonObject row = parseRow(line);
                if (row == null) {
                    continue;
                }
                SessionEntrypoint entrypoint = SessionEntrypoint.fromValue(readEntrypoint(row));
                if (entrypoint == SessionEntrypoint.CLI) {
                    return false;
                }
                if (entrypoint.isConvertibleToCli()) {
                    return true;
                }
            }
            return false;
        } catch (IOException e) {
            LOG.warn("[ConversionCore] Cannot read " + sessionFile + ": " + e.getMessage());
            return false;
        }
    }

    /**
     * Rewrite the entrypoint of every convertible row into a temp file.
     *
     * @return number of rewritten rows
     */
    // Package-private for tests
    int rewriteEntrypoint(Path source, Path target) throws IOException {
        int modified = 0;
        try (BufferedReader reader = Files.newBufferedReader(source, StandardCharsets.UTF_8);
             BufferedWriter writer = Files.newBufferedWriter(target, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                writer.write(convertLine(line));
                writer.write('\n');
                if (isConvertedLine(line)) {
                    modified++;
                }
            }
        } catch (UncheckedIOException e) {
            throw e.getCause();
        }
        return modified;
    }

    /**
     * Convert the top-level entrypoint field in one JSONL row.
     *
     * @param line JSONL row to parse.
     * @param hasCliEntrypoint whether any row already identified itself as CLI.
     * @param modifiedCount number of rows modified so far.
     * @return original or converted JSON row.
     */
    // Package-private for tests
    String convertEntrypointInLine(
            String line,
            AtomicBoolean hasCliEntrypoint,
            AtomicInteger modifiedCount
    ) {
        JsonObject row;
        try {
            row = parseRow(line);
        } catch (JsonSyntaxException e) {
            LOG.warn("[SessionConversionCore] Keeping non-JSON session row unchanged");
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
        return convertLine(line);
    }

    /**
     * Convert the top-level entrypoint field in one JSONL row.
     *
     * @param line JSONL row to parse.
     * @return original or converted JSON row.
     */
    // Package-private for tests
    String convertLine(String line) {
        JsonObject row = parseRow(line);
        if (row == null || !SessionEntrypoint.fromValue(readEntrypoint(row)).isConvertibleToCli()) {
            return line;
        }
        row.addProperty(ENTRYPOINT_FIELD, ENTRYPOINT_CLI);
        return gson.toJson(row);
    }

    /**
     * Check if a line was converted (has a convertible entrypoint).
     *
     * @param line JSONL row to parse.
     * @return true if the line was converted
     */
    // Package-private for tests
    boolean isConvertedLine(String line) {
        JsonObject row = parseRow(line);
        return row != null && SessionEntrypoint.fromValue(readEntrypoint(row)).isConvertibleToCli();
    }

    /** Parse a JSONL row, tolerating non-JSON payloads by keeping the line verbatim. */
    // Package-private for tests
    JsonObject parseRow(String line) {
        if (line == null || line.isBlank()) {
            return null;
        }
        try {
            return gson.fromJson(line, JsonObject.class);
        } catch (JsonSyntaxException e) {
            return null;
        }
    }

    /**
     * Read the entrypoint field from a row.
     *
     * @param row JSONL row
     * @return entrypoint value or null
     */
    // Package-private for tests
    String readEntrypoint(JsonObject row) {
        if (!row.has(ENTRYPOINT_FIELD)) {
            return null;
        }
        var value = row.get(ENTRYPOINT_FIELD);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }

    /**
     * Replace the target atomically, falling back to a non-atomic replace where the
     * filesystem does not support it. A plain replace still keeps the file whole:
     * the temp file is complete before the move.
     */
    // Package-private for tests
    void moveReplacing(Path tempFile, Path target) throws IOException {
        try {
            Files.move(tempFile, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tempFile, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    // Package-private for tests
    void deleteQuietly(Path path) {
        if (path == null) {
            return;
        }
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            LOG.warn("[ConversionCore] Failed to delete temp file " + path + ": " + e.getMessage());
        }
    }

    private static void releaseFileLock(FileLock fileLock, FileChannel fileChannel) {
        try {
            if (fileLock != null && fileLock.isValid()) {
                fileLock.release();
            }
            if (fileChannel != null && fileChannel.isOpen()) {
                fileChannel.close();
            }
        } catch (IOException lockError) {
            LOG.warn("[ConversionCore] Failed to release file lock: " + lockError.getMessage());
        }
    }
}
