package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.function.Supplier;

/**
 * Headless auto-conversion of SDK-created sessions to CLI-recognizable ones.
 *
 * <p>Runs at IDE shutdown, so it must not depend on {@link HandlerContext}: the
 * webview is already gone and any attempt to push a result back would fail. This
 * service only touches files and logs.
 *
 * <p><strong>Not</strong> safe to call while a session is actively being written. The
 * rewrite itself is atomic (temp file + {@code ATOMIC_MOVE}), so the file is never
 * observed half-written — but atomicity protects the file, not the writer. A process
 * that holds the jsonl open (the SDK daemon, or a separate {@code claude} CLI in a
 * terminal) keeps appending to the inode it opened, which is the one this service
 * replaces and then deletes: those rows are silently dropped. Worse, a partially
 * written last line can be read mid-append, fail to parse, and be emitted verbatim
 * followed by a newline, which splits that record across two lines and makes the
 * session unparseable for the CLI.
 *
 * <p>No lock is taken here, and none would help: {@code SessionConversionService}'s
 * {@code tryLock} is an advisory {@code fcntl} lock that neither Node nor the CLI
 * honours. Excluding an external writer requires cooperation we do not have and is
 * tracked as separate work; the current mitigation is that this service only ever
 * rewrites the rows it can parse, and it runs at IDE shutdown, when the IDE-side SDK
 * process is already gone.
 */
public class HistoryAutoConvertService {

    private static final Logger LOG = Logger.getInstance(HistoryAutoConvertService.class);

    private static final String SESSION_FILE_SUFFIX = ".jsonl";
    private static final String ENTRYPOINT_FIELD = "entrypoint";

    /**
     * Upper bound on files inspected per run. A large history must never delay IDE
     * shutdown, so the scan is best-effort: whatever is left converts on a later run.
     */
    private static final int MAX_FILES_PER_RUN = 2000;

    /**
     * Largest single session file this run will rewrite. Every conversion needs two
     * full copies on disk (backup + temp) and a full read/write pass, and it all has
     * to fit the bounded shutdown budget of {@code AutoConvertOnExitListener} — a
     * 500 MB session would blow that budget on its own and leave scratch files
     * behind. Such a file is skipped, never truncated, and converts on a later run.
     */
    // VisibleForTesting
    static final long MAX_SESSION_FILE_SIZE_BYTES = 64L * 1024L * 1024L;

    /**
     * Largest total volume of session data inspected per run. The per-file cap alone
     * does not bound the work: the maximum file count times the per-file cap is still
     * more than a hundred gigabytes of I/O, which is exactly
     * what turns a shutdown into a visible stall.
     */
    // VisibleForTesting
    static final long MAX_TOTAL_BYTES_PER_RUN = 512L * 1024L * 1024L;

    private static final String ENTRYPOINT_CLI = SessionEntrypoint.CLI.getValue();

    private final Gson gson = new Gson();

    /**
     * Resolves {@code ~/.claude/projects} at call time — never in a static field,
     * which would snapshot the wrong home for WSL nodes. Overridable so tests can
     * point the scan at a temporary directory instead of the developer's real home.
     */
    private final Supplier<Path> projectsDirSupplier;

    public HistoryAutoConvertService() {
        this(() -> Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude", "projects"));
    }

    /**
     * @param projectsDirSupplier resolves the {@code ~/.claude/projects} base per call.
     */
    public HistoryAutoConvertService(Supplier<Path> projectsDirSupplier) {
        this.projectsDirSupplier = projectsDirSupplier;
    }

    /**
     * Convert every SDK-created session found under {@code ~/.claude/projects} so
     * the Claude Code CLI lists it in {@code /resume}.
     *
     * @return number of sessions converted
     */
    public int convertAllProjects() {
        Path projectsDir = this.projectsDirSupplier.get();
        if (!Files.isDirectory(projectsDir)) {
            LOG.info("[HistoryAutoConvert] No projects directory at " + projectsDir + ", nothing to convert");
            return 0;
        }

        int inspected = 0;
        int converted = 0;
        long bytes = 0L;
        try (DirectoryStream<Path> projectDirs = Files.newDirectoryStream(projectsDir)) {
            for (Path projectDir : projectDirs) {
                if (!Files.isDirectory(projectDir)) {
                    continue;
                }
                ProjectScanResult result = convertProjectDir(projectDir,
                        MAX_FILES_PER_RUN - inspected, this.getMaxTotalBytesPerRun() - bytes);
                inspected += result.inspected;
                converted += result.converted;
                bytes += result.bytes;
                if (inspected >= MAX_FILES_PER_RUN) {
                    LOG.warn("[HistoryAutoConvert] Reached the per-run limit of " + MAX_FILES_PER_RUN
                            + " session files; remaining sessions convert on a later run");
                    break;
                }
                if (bytes >= this.getMaxTotalBytesPerRun()) {
                    LOG.warn("[HistoryAutoConvert] Reached the per-run budget of "
                            + this.getMaxTotalBytesPerRun()
                            + " bytes of session data; remaining sessions convert on a later run");
                    break;
                }
            }
        } catch (IOException e) {
            LOG.warn("[HistoryAutoConvert] Failed to scan " + projectsDir + ": " + e.getMessage());
        }

        if (converted > 0) {
            LOG.info("[HistoryAutoConvert] Converted " + converted + " session(s) to CLI entries");
        }
        return converted;
    }

    /** Counters for one project directory: files looked at, files rewritten, bytes seen. */
    private record ProjectScanResult(int inspected, int converted, long bytes) { }

    /** Largest single file a run will rewrite; overridable so tests can use small budgets. */
    // VisibleForTesting
    long getMaxSessionFileSizeBytes() {
        return MAX_SESSION_FILE_SIZE_BYTES;
    }

    /** Total data budget for one run; overridable so tests can use small budgets. */
    // VisibleForTesting
    long getMaxTotalBytesPerRun() {
        return MAX_TOTAL_BYTES_PER_RUN;
    }

    private ProjectScanResult convertProjectDir(Path projectDir, int fileBudget, long byteBudget) {
        int inspected = 0;
        int converted = 0;
        long bytes = 0L;
        if (fileBudget <= 0 || byteBudget <= 0) {
            return new ProjectScanResult(0, 0, 0L);
        }
        try (DirectoryStream<Path> sessionFiles = Files.newDirectoryStream(projectDir, "*" + SESSION_FILE_SUFFIX)) {
            for (Path sessionFile : sessionFiles) {
                if (!Files.isRegularFile(sessionFile)) {
                    continue;
                }
                inspected++;
                bytes += sizeOfQuietly(sessionFile);
                if (convertSessionFile(sessionFile)) {
                    converted++;
                }
                if (inspected >= fileBudget || bytes >= byteBudget) {
                    break;
                }
            }
        } catch (IOException e) {
            LOG.warn("[HistoryAutoConvert] Failed to scan " + projectDir + ": " + e.getMessage());
        }
        return new ProjectScanResult(inspected, converted, bytes);
    }

    /** Size of a file for budget accounting; zero when it cannot be read. */
    private static long sizeOfQuietly(Path file) {
        try {
            return Files.size(file);
        } catch (IOException e) {
            return 0L;
        }
    }

    /**
     * Convert a single session file when its entrypoint marks it as SDK-created.
     *
     * <p>The first line is sniffed cheaply so already-CLI sessions — the common
     * case — cost one read and no rewrite.
     *
     * <p>The session file is only ever modified by the final {@code move}, and the
     * backup is only ever written back when it is known to be a complete copy taken
     * from the current state of the file. Both conditions matter: a restore that used
     * a truncated backup would replace a whole session with its own first half, which
     * is silent, unrecoverable, and triggered by nothing more exotic than a full disk
     * or a network home going away mid-copy.
     *
     * @return true when the file was rewritten
     */
    // VisibleForTesting
    boolean convertSessionFile(Path sessionFile) {
        if (!needsConversion(sessionFile)) {
            return false;
        }

        Path backupFile = null;
        Path tempFile = null;
        // Flipped to true only once the backup provably holds every byte of the
        // source. Until then the backup is at best useless and at worst a fragment,
        // so the catch block must leave the session file completely alone.
        boolean backupComplete = false;
        long backupSourceSize = 0L;
        try {
            backupSourceSize = Files.size(sessionFile);
            if (backupSourceSize > this.getMaxSessionFileSizeBytes()) {
                LOG.warn("[HistoryAutoConvert] Skipping " + sessionFile.getFileName() + ": " + backupSourceSize
                        + " bytes exceeds the per-file limit of " + this.getMaxSessionFileSizeBytes()
                        + "; it converts on a later run");
                return false;
            }

            Path sessionDir = sessionFile.getParent();
            backupFile = SessionTempFiles.createPrivateTempFile(
                    sessionDir, sessionFile.getFileName() + ".backup.", ".tmp");
            copyBackup(sessionFile, backupFile);
            long backupSize = Files.size(backupFile);
            if (backupSize != backupSourceSize) {
                // A copy that returned without throwing but wrote fewer bytes is just
                // as unsafe as one that threw. Treat it as "no backup" rather than
                // trusting a size we did not verify.
                LOG.warn("[HistoryAutoConvert] Backup of " + sessionFile.getFileName() + " is short ("
                        + backupSize + " of " + backupSourceSize + " bytes); leaving the session untouched");
                return false;
            }
            backupComplete = true;

            tempFile = SessionTempFiles.createPrivateTempFile(
                    sessionDir, sessionFile.getFileName() + ".convert.", ".tmp");

            int modified = rewriteEntrypoint(sessionFile, tempFile);
            if (modified == 0) {
                Files.deleteIfExists(tempFile);
                tempFile = null;
                return false;
            }

            moveReplacing(tempFile, sessionFile);
            tempFile = null;
            LOG.info("[HistoryAutoConvert] Converted " + sessionFile.getFileName());
            return true;
        } catch (IOException e) {
            LOG.warn("[HistoryAutoConvert] Failed to convert " + sessionFile + ": " + e.getMessage());
            if (backupComplete) {
                restoreBackup(backupFile, sessionFile, backupSourceSize);
            } else {
                LOG.warn("[HistoryAutoConvert] No complete backup of " + sessionFile.getFileName()
                        + "; the session file was not touched and stays as it is on disk");
            }
            return false;
        } finally {
            deleteQuietly(tempFile);
            deleteQuietly(backupFile);
        }
    }

    /**
     * Copy the session file to the backup path.
     *
     * <p>Split out from {@link #convertSessionFile} so tests can simulate a copy that
     * dies half way through — ENOSPC, EIO, a network share vanishing — without having
     * to fill an actual disk.
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
     * Whether the file's first row declares a convertible entrypoint.
     * A file that cannot be read or parsed is left alone.
     */
    private boolean needsConversion(Path sessionFile) {
        try (BufferedReader reader = Files.newBufferedReader(sessionFile, StandardCharsets.UTF_8)) {
            String firstLine = reader.readLine();
            if (firstLine == null) {
                return false;
            }
            JsonObject row = parseRow(firstLine);
            if (row == null) {
                return false;
            }
            return SessionEntrypoint.fromValue(readEntrypoint(row)).isConvertibleToCli();
        } catch (IOException e) {
            LOG.warn("[HistoryAutoConvert] Cannot read " + sessionFile + ": " + e.getMessage());
            return false;
        }
    }

    /**
     * Rewrite the entrypoint of every convertible row into a temp file.
     *
     * @return number of rewritten rows
     */
    private int rewriteEntrypoint(Path source, Path target) throws IOException {
        int modified = 0;
        try (BufferedReader reader = Files.newBufferedReader(source, StandardCharsets.UTF_8);
             BufferedWriter writer = Files.newBufferedWriter(target, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                writer.write(convertLine(line));
                writer.newLine();
                if (isConvertedLine(line)) {
                    modified++;
                }
            }
        } catch (UncheckedIOException e) {
            throw e.getCause();
        }
        return modified;
    }

    private String convertLine(String line) {
        JsonObject row = parseRow(line);
        if (row == null || !SessionEntrypoint.fromValue(readEntrypoint(row)).isConvertibleToCli()) {
            return line;
        }
        row.addProperty(ENTRYPOINT_FIELD, ENTRYPOINT_CLI);
        return gson.toJson(row);
    }

    private boolean isConvertedLine(String line) {
        JsonObject row = parseRow(line);
        return row != null && SessionEntrypoint.fromValue(readEntrypoint(row)).isConvertibleToCli();
    }

    /** Parse a JSONL row, tolerating non-JSON payloads by keeping the line verbatim. */
    private JsonObject parseRow(String line) {
        if (line == null || line.isBlank()) {
            return null;
        }
        try {
            return gson.fromJson(line, JsonObject.class);
        } catch (JsonSyntaxException e) {
            return null;
        }
    }

    private String readEntrypoint(JsonObject row) {
        if (!row.has(ENTRYPOINT_FIELD)) {
            return null;
        }
        JsonElement value = row.get(ENTRYPOINT_FIELD);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }

    /**
     * Replace the target atomically, falling back to a non-atomic replace where the
     * filesystem does not support it. A plain replace still keeps the file whole:
     * the temp file is complete before the move.
     */
    private void moveReplacing(Path tempFile, Path target) throws IOException {
        try {
            Files.move(tempFile, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tempFile, target, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /**
     * Put the original file back after a failed rewrite.
     *
     * <p>Only called for a backup that is known to be complete — see
     * {@link #convertSessionFile} — and even then only when the file on disk has not
     * grown since the backup was taken. A writer that appended in the meantime would
     * lose those rows to a restore, and rows written after T0 are worth more than the
     * older snapshot. A file that shrank means something truncated it, and then the
     * complete backup is the only good copy left, so that case is restored.
     *
     * <p>The restore is a rename rather than a copy: the scratch file sits in the
     * same directory, so the move stays within one filesystem, and a crash during it
     * cannot leave a half-written session behind.
     */
    private void restoreBackup(Path backupFile, Path sessionFile, long expectedSize) {
        if (backupFile == null || !Files.exists(backupFile)) {
            return;
        }
        try {
            long currentSize = Files.size(sessionFile);
            if (currentSize > expectedSize) {
                LOG.warn("[HistoryAutoConvert] " + sessionFile.getFileName() + " grew after the backup was taken ("
                        + currentSize + " > " + expectedSize + " bytes); not restoring the older snapshot over it");
                return;
            }
            moveReplacing(backupFile, sessionFile);
            LOG.info("[HistoryAutoConvert] Restored " + sessionFile.getFileName() + " from backup");
        } catch (IOException e) {
            LOG.error("[HistoryAutoConvert] Failed to restore backup for " + sessionFile + ": " + e.getMessage());
        }
    }

    private void deleteQuietly(Path path) {
        if (path == null) {
            return;
        }
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            LOG.warn("[HistoryAutoConvert] Failed to delete temp file " + path + ": " + e.getMessage());
        }
    }
}
