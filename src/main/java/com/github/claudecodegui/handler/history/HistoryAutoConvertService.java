package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.ui.toolwindow.ClaudeSDKToolWindow;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.github.claudecodegui.settings.CodemossSettingsService;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.HashSet;
import java.util.Set;
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
 * honours. And the timing assumption this class used to rely on does not hold either:
 * {@code appWillBeClosed} runs <em>before</em> the open projects are disposed, so the
 * IDE-side SDK processes can still be alive and appending while a conversion runs.
 * The mitigations are therefore cooperative-free ones:
 * <ul>
 *   <li>only projects open in this IDE instance are scanned — never the whole
 *   {@code ~/.claude/projects} tree, which other IDE windows, other IDE instances,
 *   or a terminal {@code claude --resume} may be writing to;</li>
 *   <li>sessions active in any chat window of those projects are skipped;</li>
 *   <li>immediately before the temp file is moved over the session, the session is
 *   re-stat'ed: if its size or mtime changed since the backup was taken, the
 *   conversion is abandoned and the newer file on disk is left alone.</li>
 * </ul>
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
     * behind. Such a file is skipped, never truncated; no later run will take it
     * either, so the log points at the manual conversion in the history page.
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

    /**
     * Upper bound on rows sniffed when looking for the first entrypoint-bearing row.
     * Metadata rows ({@code summary}, {@code file-history-snapshot}) carry no
     * entrypoint, so the first line alone proves nothing; the scan walks forward until
     * some row declares one, but stays bounded so a pathological file costs a bounded
     * read.
     */
    // VisibleForTesting
    static final int MAX_ENTRYPOINT_SNIFF_LINES = 50;

    private final SessionConversionCore conversionCore = new SessionConversionCore();

    /**
     * Whether any early row declares a convertible entrypoint. Metadata rows —
     * {@code summary}, {@code file-history-snapshot} — carry no entrypoint, so the
     * scan walks forward until some row declares one (bounded by
     * {@link #MAX_ENTRYPOINT_SNIFF_LINES}): a CLI row settles it as "already CLI",
     * a convertible row as "convert", anything else keeps the scan going. A file
     * that cannot be read or that declares nothing within the bound is left alone.
     */
    private boolean needsConversion(Path sessionFile) {
        return conversionCore.needsConversion(sessionFile);
    }

    /**
     * Resolves {@code ~/.claude/projects} at call time — never in a static field,
     * which would snapshot the wrong home for WSL nodes. Overridable so tests can
     * point the scan at a temporary directory instead of the developer's real home.
     */
    private final Supplier<Path> projectsDirSupplier;

    /**
     * Names of the project directories a run may touch, or null for "unrestricted".
     * Production restricts the scan to the projects open in this IDE instance: the
     * rest of {@code ~/.claude/projects} belongs to other IDE windows, other IDE
     * instances, or terminal sessions that may be writing to it right now.
     */
    private final Supplier<Set<String>> scannedProjectDirNamesSupplier;

    /**
     * Sessions currently open in a chat window. Their jsonl is being appended to by a
     * live SDK process, so a run must leave them alone no matter what the stat guard
     * would say about this particular microsecond.
     */
    private final Supplier<Set<String>> activeSessionIdsSupplier;

    public HistoryAutoConvertService() {
        this(
                () -> Paths.get(NodeDetector.resolveHomeForFileOps(), ".claude", "projects"),
                HistoryAutoConvertService::openProjectDirectoryNames,
                HistoryAutoConvertService::activeSessionIdsAcrossOpenProjects
        );
    }

    /**
     * Test-facing constructor: unrestricted scan, no active sessions, so a plain JUnit
     * JVM without an IDE application exercises the same conversion code.
     *
     * @param projectsDirSupplier resolves the {@code ~/.claude/projects} base per call.
     */
    public HistoryAutoConvertService(Supplier<Path> projectsDirSupplier) {
        this(projectsDirSupplier, () -> null, Set::of);
    }

    /**
     * @param projectsDirSupplier resolves the {@code ~/.claude/projects} base per call.
     * @param scannedProjectDirNamesSupplier project directory names to scan, null meaning unrestricted.
     * @param activeSessionIdsSupplier session ids that must be skipped because a window is writing them.
     */
    // VisibleForTesting
    public HistoryAutoConvertService(
            Supplier<Path> projectsDirSupplier,
            Supplier<Set<String>> scannedProjectDirNamesSupplier,
            Supplier<Set<String>> activeSessionIdsSupplier
    ) {
        this.projectsDirSupplier = projectsDirSupplier;
        this.scannedProjectDirNamesSupplier = scannedProjectDirNamesSupplier;
        this.activeSessionIdsSupplier = activeSessionIdsSupplier;
    }

    /**
     * Directory names under {@code ~/.claude/projects} that belong to the projects this
     * IDE instance currently has open. Returns null when there is no application to ask
     * (a plain unit-test JVM), which callers treat as "unrestricted".
     */
    private static Set<String> openProjectDirectoryNames() {
        try {
            ProjectManager projectManager = ProjectManager.getInstance();
            if (projectManager == null) {
                return null;
            }
            Set<String> names = new HashSet<>();
            for (Project project : projectManager.getOpenProjects()) {
                String basePath = project.getBasePath();
                if (basePath != null) {
                    names.add(PathUtils.sanitizePath(PathUtils.realPath(
                            SessionConversionService.resolveProjectPathForFileOps(basePath))));
                }
            }
            return names;
        } catch (Exception e) {
            LOG.warn("[HistoryAutoConvert] Cannot enumerate open projects; nothing will be scanned: "
                    + e.getMessage());
            return Set.of();
        }
    }

    /**
     * Get project directory names using the effective working directory (custom working directory
     * if configured, otherwise project base path). This matches what the batch converter uses.
     *
     * @return set of sanitized project directory names, or empty set on error
     */
    public static Set<String> openProjectDirectoryNamesWithEffectiveWorkingDir() {
        try {
            ProjectManager projectManager = ProjectManager.getInstance();
            if (projectManager == null) {
                return Set.of();
            }
            Set<String> names = new HashSet<>();
            for (Project project : projectManager.getOpenProjects()) {
                String basePath = project.getBasePath();
                if (basePath != null) {
                    // Use effective working directory like the batch converter does
                    CodemossSettingsService settingsService = new CodemossSettingsService();
                    String effectivePath = settingsService.getEffectiveWorkingDirectory(basePath);
                    names.add(PathUtils.sanitizePath(PathUtils.realPath(
                            SessionConversionService.resolveProjectPathForFileOps(effectivePath))));
                }
            }
            return names;
        } catch (Exception e) {
            LOG.warn("[HistoryAutoConvert] Cannot enumerate open projects with effective working dir: "
                    + e.getMessage());
            return Set.of();
        }
    }

    /**
     * Sessions open in any chat window of any open project. A failure to enumerate them
     * degrades to an empty set: the pre-swap stat guard still catches a writer that
     * appended during the conversion.
     */
    public static Set<String> activeSessionIdsAcrossOpenProjects() {
        try {
            ProjectManager projectManager = ProjectManager.getInstance();
            if (projectManager == null) {
                return Set.of();
            }
            Set<String> ids = new HashSet<>();
            for (Project project : projectManager.getOpenProjects()) {
                ids.addAll(ClaudeSDKToolWindow.getActiveSessionIdsForProject(project));
            }
            return ids;
        } catch (Exception e) {
            LOG.warn("[HistoryAutoConvert] Cannot enumerate active sessions: " + e.getMessage());
            return Set.of();
        }
    }

    /**
     * Convert every convertible session of the projects this IDE instance has open so
     * the Claude Code CLI lists it in {@code /resume}. Project directories belonging to
     * anything else — another IDE window, another IDE instance, a terminal
     * {@code claude --resume} — are never touched.
     *
     * @return number of sessions converted
     */
    public int convertAllProjects() {
        Path projectsDir = this.projectsDirSupplier.get();
        if (!Files.isDirectory(projectsDir)) {
            LOG.info("[HistoryAutoConvert] No projects directory at " + projectsDir + ", nothing to convert");
            return 0;
        }

        Set<String> projectDirNames = this.scannedProjectDirNamesSupplier.get();
        Set<String> suppliedActiveIds = this.activeSessionIdsSupplier.get();
        Set<String> activeSessionIds = suppliedActiveIds != null ? suppliedActiveIds : Set.of();
        int inspected = 0;
        int converted = 0;
        long bytes = 0L;
        try (DirectoryStream<Path> projectDirs = Files.newDirectoryStream(projectsDir)) {
            for (Path projectDir : projectDirs) {
                if (!Files.isDirectory(projectDir)) {
                    continue;
                }
                if (projectDirNames != null && !projectDirNames.contains(projectDir.getFileName().toString())) {
                    continue;
                }
                ProjectScanResult result = convertProjectDir(projectDir, activeSessionIds,
                        this.getMaxFilesPerRun() - inspected, this.getMaxTotalBytesPerRun() - bytes);
                inspected += result.inspected;
                converted += result.converted;
                bytes += result.bytes;
                if (inspected >= this.getMaxFilesPerRun()) {
                    LOG.warn("[HistoryAutoConvert] Reached the per-run limit of " + this.getMaxFilesPerRun()
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

    /** Largest number of files one run inspects; overridable so tests can use a small cap. */
    // VisibleForTesting
    int getMaxFilesPerRun() {
        return MAX_FILES_PER_RUN;
    }

    private ProjectScanResult convertProjectDir(Path projectDir, Set<String> activeSessionIds,
                                                int fileBudget, long byteBudget) {
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
                String fileName = sessionFile.getFileName().toString();
                String sessionId = fileName.substring(0, fileName.length() - SESSION_FILE_SUFFIX.length());
                if (activeSessionIds.contains(sessionId)) {
                    LOG.info("[HistoryAutoConvert] Skipping " + fileName
                            + ": the session is open in a chat window and still being written");
                    continue;
                }
                // Sniff before spending any budget on the file: already-CLI sessions are
                // the overwhelming common case, and counting them would let a stable
                // prefix of converted files consume the whole run budget every time,
                // starving everything behind it forever.
                if (!this.needsConversion(sessionFile)) {
                    continue;
                }
                long size = sizeOfQuietly(sessionFile);
                if (size > this.getMaxSessionFileSizeBytes()) {
                    // Not counted against the run budgets: nothing was read or rewritten,
                    // and no later run will ever take this file either.
                    LOG.warn("[HistoryAutoConvert] Skipping " + fileName + ": " + size
                            + " bytes exceeds the per-file limit of " + this.getMaxSessionFileSizeBytes()
                            + "; convert it manually from the history page");
                    continue;
                }
                inspected++;
                bytes += size;
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
     * <p>The head is sniffed cheaply so already-CLI sessions — the common
     * case — cost a few row reads and no rewrite.
     *
     * <p>Uses the shared {@link SessionConversionCore} for the actual conversion
     * logic to ensure identical behavior between auto-convert, batch convert, and
     * single-session convert.
     *
     * @return true when the file was rewritten
     */
    // VisibleForTesting
    boolean convertSessionFile(Path sessionFile) {
        var activeIdsSupplier = this.activeSessionIdsSupplier;
        try {
            var outcome = conversionCore.convertSessionFile(sessionFile, activeIdsSupplier);
            return outcome.converted();
        } catch (IOException e) {
            LOG.warn("[HistoryAutoConvert] Failed to convert " + sessionFile + ": " + e.getMessage());
            return false;
        }
    }
}
