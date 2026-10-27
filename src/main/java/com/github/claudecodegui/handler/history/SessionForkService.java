package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PathUtils;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.Iterator;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

/**
 * Service to fork a session: duplicate an existing Claude session JSONL into a new,
 * fully independent session file so the user can branch a conversation from a past point.
 *
 * The source file is only ever read (never locked or rewritten), so forking the session
 * that is currently active in this window is safe — unlike conversion, which must reject
 * it because it replaces the file the SDK process keeps appending to. A torn last line
 * written concurrently by the CLI is copied verbatim and tolerated by the reader, the
 * same way non-JSON rows are.
 *
 * Only the Claude provider is supported for now. Codex sessions are resumed through the
 * app-server thread mechanism rather than by file identity, so a copied rollout file
 * cannot simply be resumed under a new id.
 *
 * @author Gadfly
 */
class SessionForkService {

    private static final Logger LOG = Logger.getInstance(SessionForkService.class);

    private static final String CLAUDE_PROVIDER = "claude";

    /** Matches the custom-title service limit; see session-titles-service.cjs. */
    static final int MAX_TITLE_LENGTH = 50;

    private final HandlerContext context;
    private final NodeJsServiceCaller nodeJsServiceCaller;
    private final Gson gson = new Gson();

    SessionForkService(HandlerContext context, NodeJsServiceCaller nodeJsServiceCaller) {
        this.context = context;
        this.nodeJsServiceCaller = nodeJsServiceCaller;
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
     * Fork a session.
     *
     * @param content JSON payload from the frontend: {@code {sessionId, provider?, title?, forkPointUuid?}}.
     *                The optional title is applied to the fork via the custom-title
     *                service so the list can tell the copy apart from the original.
     *                The optional forkPointUuid is the row uuid of an assistant message:
     *                the fork then contains only the conversation up to the end of that
     *                reply's turn instead of the whole session.
     * @param projectPath Project path (optional, will scan all projects if null).
     */
    void forkSession(String content, String projectPath) {
        JsonObject request;
        try {
            request = this.gson.fromJson(content, JsonObject.class);
        } catch (JsonSyntaxException e) {
            LOG.warn("[SessionForkService] Fork rejected: unparseable payload");
            // Not a session-id problem: report the generic failure so the user is
            // not told their id is invalid when the payload itself was malformed.
            this.sendForkResult(false, null, ForkResultCode.FORK_FAILED, null);
            return;
        }

        String sessionId = request != null && request.has("sessionId") && request.get("sessionId").isJsonPrimitive()
                ? request.get("sessionId").getAsString() : null;
        if (!HistoryDeleteService.isValidSessionId(sessionId)) {
            LOG.warn("[SessionForkService] Fork rejected: invalid sessionId");
            this.sendForkResult(false, null, ForkResultCode.INVALID_SESSION_ID, null);
            return;
        }

        String forkPointUuid = request.has("forkPointUuid") && request.get("forkPointUuid").isJsonPrimitive()
                ? request.get("forkPointUuid").getAsString() : null;
        if (forkPointUuid != null && !HistoryDeleteService.isValidSessionId(forkPointUuid)) {
            LOG.warn("[SessionForkService] Fork rejected: invalid forkPointUuid");
            this.sendForkResult(false, null, ForkResultCode.INVALID_SESSION_ID, null);
            return;
        }

        String provider = request.has("provider") && request.get("provider").isJsonPrimitive()
                ? request.get("provider").getAsString() : CLAUDE_PROVIDER;
        if (!CLAUDE_PROVIDER.equals(provider)) {
            LOG.info("[SessionForkService] Fork rejected: provider not supported: " + provider);
            this.sendForkResult(false, null, ForkResultCode.UNSUPPORTED_PROVIDER, null);
            return;
        }

        // The frontend already truncates the title to the service limit; this is the
        // backend belt-and-braces so the Node call cannot fail on length alone.
        // Truncate by code point: a plain substring can split a surrogate pair and
        // persist half an emoji.
        String forkTitle = request.has("title") && request.get("title").isJsonPrimitive()
                ? request.get("title").getAsString() : null;
        if (forkTitle != null && forkTitle.codePointCount(0, forkTitle.length()) > MAX_TITLE_LENGTH) {
            forkTitle = forkTitle.substring(0, forkTitle.offsetByCodePoints(0, MAX_TITLE_LENGTH));
        }

        String finalForkTitle = forkTitle;
        String finalForkPointUuid = forkPointUuid;
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            try {
                Path sessionFile = this.findSessionFile(sessionId, projectPath);
                if (sessionFile == null) {
                    LOG.warn("[SessionForkService] Session file not found: " + sessionId);
                    this.sendForkResult(false, null, ForkResultCode.SESSION_NOT_FOUND, null);
                    return;
                }

                // The finder only returns existing files; this catches a narrow TOCTOU
                // window where another process deletes the file after discovery.
                if (!Files.exists(sessionFile)) {
                    LOG.warn("[SessionForkService] Session file does not exist: " + sessionFile);
                    this.sendForkResult(false, null, ForkResultCode.FILE_NOT_EXIST, null);
                    return;
                }

                String newSessionId = UUID.randomUUID().toString();
                Path targetFile = sessionFile.getParent().resolve(newSessionId + ".jsonl");

                this.copySessionFile(sessionFile, targetFile, sessionId, newSessionId, finalForkPointUuid);
                LOG.info("[SessionForkService] Forked session " + sessionId
                        + (finalForkPointUuid != null ? " at " + finalForkPointUuid : "")
                        + " into " + newSessionId);

                // Sidechain transcripts and metadata are best-effort: the main fork is
                // already usable at this point, so a failure here degrades gracefully
                // (missing subagent panels) instead of failing the whole fork.
                this.copySidechains(sessionFile.getParent(), sessionId, newSessionId);
                this.applyForkTitle(newSessionId, finalForkTitle);

                this.sendForkResult(true, newSessionId, null, finalForkPointUuid);
            } catch (FileAlreadyExistsException e) {
                LOG.error("[SessionForkService] Fork target already exists: " + e.getMessage());
                this.sendForkResult(false, null, ForkResultCode.FORK_FAILED, null);
            } catch (ForkPointNotFoundException e) {
                LOG.warn("[SessionForkService] Fork point not found in session: " + e.getMessage());
                this.sendForkResult(false, null, ForkResultCode.FORK_POINT_NOT_FOUND, null);
            } catch (Exception e) {
                LOG.error("[SessionForkService] Failed to fork session: " + e.getMessage(), e);
                this.sendForkResult(false, null, ForkResultCode.FORK_FAILED, null);
            }
        });
    }

    /** Thrown when the requested fork-point uuid does not exist in the source file. */
    static class ForkPointNotFoundException extends IOException {
        ForkPointNotFoundException(String message) {
            super(message);
        }
    }

    /**
     * Stream-copy one session JSONL to {@code target}, rewriting every occurrence of the
     * source session id to {@code newSessionId}. Uses a byte-level replacement rather
     * than JSON round-tripping: the CLI writes compact JSON, so the replacement preserves
     * every other byte of the row, reaches id fields nested inside message objects, and
     * only touches fields whose value is exactly the source session id — other ids that
     * merely share the field name (e.g. an agent's own thread id) stay intact.
     * {@code uuid}/{@code parentUuid} chains are intentionally kept identical so the
     * forked conversation replays exactly.
     *
     * @param source Source session file (read-only; never locked so a concurrently
     *               active session cannot be disturbed).
     * @param target Fork file to create.
     * @param sourceSessionId Session id of the original.
     * @param newSessionId Session id of the fork.
     * @param forkPointUuid Optional assistant-row uuid; when present the copy stops at
     *                      the end of that reply's turn (see {@link #resolveCutIndex}).
     */
    // Package-private so SessionForkServiceTest can exercise the copy against temp dirs.
    void copySessionFile(Path source, Path target, String sourceSessionId, String newSessionId,
                         String forkPointUuid) throws IOException {
        // Two streaming passes keep memory flat for large transcripts: pass one locates
        // the exclusive cut line, pass two copies up to it.
        final int limit;
        if (forkPointUuid != null) {
            int cut = resolveCutIndex(source, forkPointUuid);
            if (cut < 1) {
                throw new ForkPointNotFoundException(forkPointUuid);
            }
            limit = cut;
        } else {
            limit = Integer.MAX_VALUE;
        }

        Path tempFile = Files.createTempFile(target.getParent(), newSessionId + ".jsonl.fork.", ".tmp");
        try {
            try (Stream<String> lines = Files.lines(source, StandardCharsets.UTF_8);
                 BufferedWriter writer = Files.newBufferedWriter(tempFile, StandardCharsets.UTF_8)) {
                AtomicInteger copied = new AtomicInteger(0);
                lines.takeWhile(line -> copied.get() < limit).forEach(line -> {
                    try {
                        writer.write(this.rewriteRowForFork(line, sourceSessionId, newSessionId));
                        // The CLI always writes '\n'; writer.newLine() would turn the
                        // whole fork into CRLF on Windows and break byte-for-byte
                        // comparisons with the source.
                        writer.write('\n');
                    } catch (IOException e) {
                        throw new UncheckedIOException(e);
                    } finally {
                        copied.incrementAndGet();
                    }
                });
            } catch (UncheckedIOException e) {
                // UncheckedIOException wraps the IOException thrown inside the lambda.
                // Unwrap and rethrow so the outer catch(Exception) handles it uniformly.
                throw e.getCause();
            }

            // No REPLACE_EXISTING: the target name was just generated, so an existing
            // file would mean a freak UUID collision and must fail loudly.
            Files.move(tempFile, target, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            try {
                Files.deleteIfExists(tempFile);
            } catch (IOException cleanupError) {
                LOG.warn("[SessionForkService] Failed to clean up temp file: " + cleanupError.getMessage());
            }
        }
    }

    /**
     * Resolve the exclusive cut line for a fork at the given assistant message.
     * The fork must never end on a dangling {@code tool_use}: the API rejects a
     * resume whose last turn carries a tool call without its result. The cut is
     * therefore placed at the end of the clicked reply's whole turn — after the
     * assistant row, any tool_result user rows and further assistant rows of the
     * same cycle are kept, and the cut lands right before the next real user text
     * message (or end of file).
     *
     * @param source Source session file.
     * @param forkPointUuid Row uuid of the clicked assistant message.
     * @return Exclusive line index to stop at, or -1 when the uuid is not present.
     */
    // Package-private so SessionForkServiceTest can exercise the boundary logic.
    static int resolveCutIndex(Path source, String forkPointUuid) throws IOException {
        String uuidNeedle = "\"uuid\":\"" + forkPointUuid + "\"";
        int anchor = -1;
        int lineIndex = 0;
        // Pass one stops at the anchor line; nothing after it is retained.
        try (Stream<String> lines = Files.lines(source, StandardCharsets.UTF_8)) {
            for (Iterator<String> it = lines.iterator(); it.hasNext(); lineIndex++) {
                if (it.next().contains(uuidNeedle)) {
                    anchor = lineIndex;
                    break;
                }
            }
        }
        if (anchor < 0) {
            return -1;
        }

        // Pass two only tracks line numbers: the previous version buffered every
        // row after the anchor, which peaked at the whole file tail in memory.
        int cut = -1;
        int totalLines = 0;
        lineIndex = 0;
        try (Stream<String> lines = Files.lines(source, StandardCharsets.UTF_8)) {
            for (Iterator<String> it = lines.iterator(); it.hasNext(); lineIndex++) {
                String line = it.next();
                totalLines = lineIndex + 1;
                if (lineIndex > anchor && isRealUserTextRow(line)) {
                    cut = lineIndex;
                    break;
                }
            }
        }
        // No following user turn: the fork keeps the rest of the transcript.
        return cut >= 0 ? cut : totalLines;
    }

    /**
     * Check whether one JSONL row starts a new user turn. Mirrors the frontend's
     * tool-result-only detection: user rows carrying tool results (and meta or
     * sidechain rows) belong to the assistant cycle and must not end the fork.
     *
     * @param line JSONL row to inspect.
     * @return true when the row is a genuine user text message.
     */
    static boolean isRealUserTextRow(String line) {
        JsonObject row;
        try {
            row = new Gson().fromJson(line, JsonObject.class);
        } catch (JsonSyntaxException e) {
            return false;
        }
        if (row == null || !"user".equals(getJsonString(row, "type"))) {
            return false;
        }
        if (isTrue(row, "isMeta") || isTrue(row, "isSidechain") || isTrue(row, "isCompactSummary")) {
            return false;
        }
        JsonElement message = row.get("message");
        if (message == null || !message.isJsonObject()) {
            return false;
        }
        JsonElement content = message.getAsJsonObject().get("content");
        if (content == null || content.isJsonNull()) {
            return false;
        }
        if (content.isJsonPrimitive()) {
            String text = content.getAsString();
            return !text.isBlank() && !"[tool_result]".equals(text);
        }
        if (!content.isJsonArray()) {
            return false;
        }
        boolean hasText = false;
        for (JsonElement block : content.getAsJsonArray()) {
            if (!block.isJsonObject()) {
                continue;
            }
            String blockType = getJsonString(block.getAsJsonObject(), "type");
            if ("tool_result".equals(blockType)) {
                return false;
            }
            if ("text".equals(blockType)) {
                hasText = true;
            }
        }
        return hasText;
    }

    private static String getJsonString(JsonObject row, String field) {
        JsonElement element = row.get(field);
        return element != null && element.isJsonPrimitive() ? element.getAsString() : null;
    }

    private static boolean isTrue(JsonObject row, String field) {
        JsonElement element = row.get(field);
        return element != null && element.isJsonPrimitive() && element.getAsJsonPrimitive().isBoolean()
                && element.getAsBoolean();
    }

    /**
     * Rewrite the session id references of one JSONL row for the fork.
     *
     * @param line JSONL row to rewrite.
     * @param sourceSessionId Session id of the original.
     * @param newSessionId Session id of the fork.
     * @return the row with every {@code sessionId}/{@code parentSessionId} occurrence of
     *         the source id replaced by the fork id; everything else is byte-identical.
     */
    // Package-private so SessionForkServiceTest can exercise the per-row rewrite directly.
    static String rewriteRowForFork(String line, String sourceSessionId, String newSessionId) {
        return line
                .replace("\"sessionId\":\"" + sourceSessionId + "\"",
                         "\"sessionId\":\"" + newSessionId + "\"")
                .replace("\"parentSessionId\":\"" + sourceSessionId + "\"",
                         "\"parentSessionId\":\"" + newSessionId + "\"");
    }

    /**
     * Copy the sidechain transcripts that belong to the source session so the fork is
     * fully independent (its subagent panels work, and deleting either session leaves
     * the other's sidechains alone). Handles both layouts:
     * <ul>
     *   <li>Current layout: {@code <projectDir>/<sessionId>/} directory, copied wholesale
     *       under the fork's id, with .jsonl rows' id fields rewritten.</li>
     *   <li>Legacy layout: {@code agent-*.jsonl} files directly in the project dir whose
     *       first lines reference the session, copied under fresh names.</li>
     * </ul>
     * Failures are logged and swallowed on purpose — see the caller.
     */
    private void copySidechains(Path sessionDir, String sourceSessionId, String newSessionId) {
        try {
            Path sidechainDir = sessionDir.resolve(sourceSessionId);
            if (Files.isDirectory(sidechainDir)) {
                this.copyDirectory(sidechainDir, sessionDir.resolve(newSessionId), sourceSessionId, newSessionId);
                LOG.debug("[SessionForkService] Copied sidechain directory for fork " + newSessionId);
            }
        } catch (Exception e) {
            LOG.warn("[SessionForkService] Failed to copy sidechain directory: " + e.getMessage());
        }

        try (Stream<Path> entries = Files.list(sessionDir)) {
            entries.filter(path -> {
                        String filename = path.getFileName().toString();
                        return filename.startsWith("agent-") && filename.endsWith(".jsonl")
                                && AgentFileMatcher.isRelatedToSession(path, sourceSessionId);
                    })
                    .forEach(agentFile -> {
                        try {
                            Path forkAgentFile = sessionDir.resolve("agent-" + UUID.randomUUID() + ".jsonl");
                            this.copySessionFile(agentFile, forkAgentFile, sourceSessionId, newSessionId, null);
                            LOG.debug("[SessionForkService] Copied legacy agent file for fork "
                                    + newSessionId + ": " + agentFile.getFileName());
                        } catch (Exception e) {
                            LOG.warn("[SessionForkService] Failed to copy agent file "
                                    + agentFile.getFileName() + ": " + e.getMessage());
                        }
                    });
        } catch (Exception e) {
            LOG.warn("[SessionForkService] Failed to scan for legacy agent files: " + e.getMessage());
        }
    }

    private void copyDirectory(Path sourceDir, Path targetDir, String sourceSessionId, String newSessionId)
            throws IOException {
        Files.createDirectories(targetDir);
        try (Stream<Path> entries = Files.list(sourceDir)) {
            entries.forEach(entry -> {
                Path target = targetDir.resolve(entry.getFileName().toString());
                try {
                    if (Files.isDirectory(entry)) {
                        this.copyDirectory(entry, target, sourceSessionId, newSessionId);
                    } else if (entry.getFileName().toString().endsWith(".jsonl")) {
                        this.copySessionFile(entry, target, sourceSessionId, newSessionId, null);
                    } else {
                        Files.copy(entry, target);
                    }
                } catch (Exception e) {
                    LOG.warn("[SessionForkService] Failed to copy sidechain entry "
                            + entry.getFileName() + ": " + e.getMessage());
                }
            });
        }
    }

    /**
     * Apply the fork's list title via the custom-title service. Best-effort: the fork is
     * already complete and usable; an untitled fork merely shows its default title.
     */
    private void applyForkTitle(String newSessionId, String forkTitle) {
        if (forkTitle == null || forkTitle.isEmpty()) {
            return;
        }
        try {
            this.nodeJsServiceCaller.callNodeJsTitlesServiceWithParams("updateTitle", newSessionId, forkTitle);
            LOG.debug("[SessionForkService] Applied fork title: " + forkTitle);
        } catch (Exception e) {
            LOG.warn("[SessionForkService] Failed to apply fork title: " + e.getMessage());
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

            LOG.debug("[SessionForkService] Scanning project directories for session: " + sessionId);
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
            LOG.error("[SessionForkService] Error finding session file: " + e.getMessage(), e);
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
     * Send fork result to frontend via the safe HandlerContext helper.
     *
     * @param success Whether the fork was created.
     * @param newSessionId Session id of the fork, or null on failure.
     * @param code Failure code, or null on success.
     * @param forkPointUuid Echoed fork point, or null for a whole-session fork; the
     *                      frontend auto-opens the fork in the chat only for
     *                      message-level forks (history-list forks must not yank the
     *                      user out of the list).
     */
    private void sendForkResult(boolean success, String newSessionId, ForkResultCode code,
                                String forkPointUuid) {
        JsonObject result = new JsonObject();
        result.addProperty("success", success);
        if (newSessionId != null) {
            result.addProperty("newSessionId", newSessionId);
        }
        if (code != null) {
            result.addProperty("errorCode", code.getCode());
        }
        if (forkPointUuid != null) {
            result.addProperty("forkPointUuid", forkPointUuid);
        }

        Project project = this.context.getProject();
        if (project != null && !project.isDisposed()) {
            String escapedJson = this.context.escapeJs(this.gson.toJson(result));
            String jsCode = "if (window.onForkResult) { window.onForkResult('" + escapedJson + "'); }";
            this.context.executeJavaScriptQueued(jsCode);
        }
    }
}
