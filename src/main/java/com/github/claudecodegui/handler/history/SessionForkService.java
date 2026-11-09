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
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * Service to fork a session: duplicate an existing Claude session JSONL into a new,
 * fully independent session file so the user can branch a conversation from a past point.
 *
 * The source file is only ever read (never locked or rewritten), so forking the session
 * that is currently active in this window is safe — unlike conversion, which must reject
 * it because it replaces the file the SDK process keeps appending to. A torn last line
 * written concurrently by the CLI is never finalized into the fork: a mid-file non-JSON
 * row is copied verbatim (the reader tolerates those, the same way the source's reader
 * does), but a malformed terminal row is dropped — a fork file ending on a torn row
 * would be reported incomplete by the full-history reader forever, because nothing ever
 * appends behind it. Provided the tear falls between UTF-8 characters, dropping it
 * keeps the fork openable; a tear inside a multi-byte character fails the read and the
 * fork (a retry once the CLI has flushed succeeds).
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

    /** Thread-safe shared parser; one instance per row would dominate large transcripts. */
    private static final Gson ROW_GSON = new Gson();

    private final HandlerContext context;
    private final NodeJsServiceCaller nodeJsServiceCaller;

    SessionForkService(HandlerContext context, NodeJsServiceCaller nodeJsServiceCaller) {
        this.context = context;
        this.nodeJsServiceCaller = nodeJsServiceCaller;
    }

    /**
     * Resolve the user home at call time; the {@code .claude/projects} tree under it
     * holds the sessions. A static field would snapshot the Windows home at
     * class-load, but a WSL node stores sessions under the WSL filesystem;
     * {@link NodeDetector#resolveHomeForFileOps()} returns the correct home for the
     * active node. Every other history service in this package was migrated the same
     * way.
     */
    private static Path claudeHomeDir() {
        return Paths.get(NodeDetector.resolveHomeForFileOps());
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
        this.forkSession(content, projectPath, claudeHomeDir());
    }

    /**
     * Fork under an explicit user home. Production resolves the home per node at
     * call time (see {@link #claudeHomeDir()}); the overload exists so the
     * orchestration — payload validation, error routing, the pooled-thread run — is
     * testable against a temporary home, mirroring {@code HistoryDeleteService}.
     */
    void forkSession(String content, String projectPath, Path home) {
        ParsedForkRequest request = parseForkRequest(content);
        if (request.errorCode() != null) {
            this.sendForkResult(false, null, request.errorCode(), null);
            return;
        }
        ApplicationManager.getApplication().executeOnPooledThread(
                () -> this.doFork(request, projectPath, home));
    }

    /** Parsed and validated fork request; {@code errorCode} non-null means rejected. */
    record ParsedForkRequest(String sessionId, String forkPointUuid, String provider, String title,
                             ForkResultCode errorCode) {
    }

    /** Parse and validate the payload; each rejection logs its own reason. */
    static ParsedForkRequest parseForkRequest(String content) {
        JsonObject request;
        try {
            request = ROW_GSON.fromJson(content, JsonObject.class);
        } catch (JsonSyntaxException e) {
            LOG.warn("[SessionForkService] Fork rejected: unparseable payload");
            // Not a session-id problem: report the generic failure so the user is
            // not told their id is invalid when the payload itself was malformed.
            return new ParsedForkRequest(null, null, null, null, ForkResultCode.FORK_FAILED);
        }

        String sessionId = request != null && request.has("sessionId") && request.get("sessionId").isJsonPrimitive()
                ? request.get("sessionId").getAsString() : null;
        if (!HistoryDeleteService.isValidSessionId(sessionId)) {
            LOG.warn("[SessionForkService] Fork rejected: invalid sessionId");
            return new ParsedForkRequest(null, null, null, null, ForkResultCode.INVALID_SESSION_ID);
        }

        String forkPointUuid = request.has("forkPointUuid") && request.get("forkPointUuid").isJsonPrimitive()
                ? request.get("forkPointUuid").getAsString() : null;
        if (forkPointUuid != null && !HistoryDeleteService.isValidSessionId(forkPointUuid)) {
            LOG.warn("[SessionForkService] Fork rejected: invalid forkPointUuid");
            return new ParsedForkRequest(null, null, null, null, ForkResultCode.INVALID_SESSION_ID);
        }

        String provider = request.has("provider") && request.get("provider").isJsonPrimitive()
                ? request.get("provider").getAsString() : CLAUDE_PROVIDER;
        if (!CLAUDE_PROVIDER.equals(provider)) {
            LOG.info("[SessionForkService] Fork rejected: provider not supported: " + provider);
            return new ParsedForkRequest(null, null, null, null, ForkResultCode.UNSUPPORTED_PROVIDER);
        }

        // The frontend already truncates the title to the service limit; this is the
        // backend belt-and-braces so the Node call cannot fail on length alone.
        String forkTitle = request.has("title") && request.get("title").isJsonPrimitive()
                ? request.get("title").getAsString() : null;
        return new ParsedForkRequest(sessionId, forkPointUuid, provider,
                truncateForkTitle(forkTitle), null);
    }

    /** Run on the pooled thread: locate the source, copy, mirror sidechains, apply the title, report. */
    private void doFork(ParsedForkRequest request, String projectPath, Path home) {
        try {
            Path sessionFile = this.findSessionFile(request.sessionId(), projectPath, home);
            if (sessionFile == null) {
                LOG.warn("[SessionForkService] Session file not found: " + request.sessionId());
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

            this.copySessionFile(sessionFile, targetFile, request.sessionId(), newSessionId,
                    request.forkPointUuid());
            LOG.info("[SessionForkService] Forked session " + request.sessionId()
                    + (request.forkPointUuid() != null ? " at " + request.forkPointUuid() : "")
                    + " into " + newSessionId);

            // Sidechain transcripts and metadata are best-effort: the main fork is
            // already usable at this point, so a failure here degrades gracefully
            // (missing subagent panels) instead of failing the whole fork.
            this.copySidechains(sessionFile.getParent(), request.sessionId(), newSessionId);
            this.applyForkTitle(newSessionId, request.title());

            this.sendForkResult(true, newSessionId, null, request.forkPointUuid());
        } catch (FileAlreadyExistsException e) {
            // warn like HistoryDeleteService: a failed fork is a reported user
            // action, not an IDE-level fault.
            LOG.warn("[SessionForkService] Fork target already exists: " + e.getMessage());
            this.sendForkResult(false, null, ForkResultCode.FORK_FAILED, null);
        } catch (DanglingToolUseException e) {
            LOG.warn("[SessionForkService] " + e.getMessage());
            this.sendForkResult(false, null, ForkResultCode.UNRESOLVED_TOOL_USE, null);
        } catch (ForkPointNotFoundException e) {
            LOG.warn("[SessionForkService] Fork point not found in session: " + e.getMessage());
            this.sendForkResult(false, null, ForkResultCode.FORK_POINT_NOT_FOUND, null);
        } catch (Exception e) {
            LOG.warn("[SessionForkService] Failed to fork session: " + e.getMessage(), e);
            this.sendForkResult(false, null, ForkResultCode.FORK_FAILED, null);
        }
    }

    /** Thrown when the requested fork-point uuid does not exist in the source file. */
    static class ForkPointNotFoundException extends IOException {
        ForkPointNotFoundException(String message) {
            super(message);
        }
    }

    /**
     * Thrown when the rows kept around the fork point cannot end on a resolved
     * turn: the clicked reply's own cycle still carries a {@code tool_use} that
     * never received its {@code tool_result} (an interrupted turn), and no cut
     * keeps the reply while dropping the call.
     */
    static class DanglingToolUseException extends IOException {
        DanglingToolUseException(String message) {
            super(message);
        }
    }

    /**
     * Truncate a fork title to the custom-title service limit. The limit counts
     * UTF-16 code units (Node's {@code .length}, see session-titles-service.cjs), and
     * a plain substring could cut an emoji in half, so the cut backs off one unit
     * when it would split a surrogate pair.
     */
    // Package-private so the truncation contract is testable directly.
    static String truncateForkTitle(String title) {
        if (title == null || title.length() <= MAX_TITLE_LENGTH) {
            return title;
        }
        int end = MAX_TITLE_LENGTH;
        if (Character.isHighSurrogate(title.charAt(end - 1))) {
            end--;
        }
        return title.substring(0, end);
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
                // Rows are flushed one row behind: the last row taken can only be
                // judged once the stream ends, so a malformed terminal row is
                // dropped instead of being finalized into the fork — the full
                // history reader reports a fork ending on a torn row incomplete
                // forever, because nothing ever appends behind it. Mid-file
                // non-JSON rows stay verbatim: the reader tolerates those.
                int copied = 0;
                String pending = null;
                boolean pendingIsTail = false;
                Iterator<String> rows = lines.iterator();
                while (copied < limit && rows.hasNext()) {
                    String line = rows.next();
                    if (pending != null) {
                        writeForkRow(writer, pending, sourceSessionId, newSessionId);
                        copied++;
                    }
                    pending = line;
                    pendingIsTail = !rows.hasNext();
                }
                if (pending != null && copied < limit) {
                    if (pendingIsTail && parseRow(pending) == null) {
                        LOG.warn("[SessionForkService] Dropped a torn tail row (length "
                                + pending.length() + ") from the fork copy");
                    } else {
                        writeForkRow(writer, pending, sourceSessionId, newSessionId);
                        copied++;
                    }
                }
                if (copied == 0 && pending != null) {
                    // Every row of a non-empty source was dropped: publishing an
                    // empty fork file would look like a blank session, so fail
                    // the fork instead.
                    throw new IOException("Fork copy dropped every row of a non-empty transcript");
                }
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

    /** Write one rewritten fork row; the CLI's LF terminator is preserved. */
    private static void writeForkRow(BufferedWriter writer, String line, String sourceSessionId,
                                     String newSessionId) throws IOException {
        writer.write(rewriteRowForFork(line, sourceSessionId, newSessionId));
        // The CLI always writes '\n'; writer.newLine() would turn the
        // whole fork into CRLF on Windows and break byte-for-byte
        // comparisons with the source.
        writer.write('\n');
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
     * <p>Rows after the anchor are also screened for unresolved tool calls: an
     * interrupted or errored turn between the anchor and the next real user row
     * (or the end of the file) carries a {@code tool_use} without its result,
     * and keeping it would end the fork mid-call. The cut shrinks back to the
     * first assistant row of that incomplete cycle. When the incomplete cycle
     * reaches into the clicked reply itself, no cut keeps the reply while
     * dropping the call, so {@link DanglingToolUseException} is thrown instead
     * of publishing a fork the API would reject.
     *
     * @param source Source session file.
     * @param forkPointUuid Row uuid of the clicked assistant message.
     * @return Exclusive line index to stop at, or -1 when the uuid is not present.
     * @throws DanglingToolUseException when the anchor row's own turn ends on an
     *         unresolved tool call.
     */
    // Package-private so SessionForkServiceTest can exercise the boundary logic.
    static int resolveCutIndex(Path source, String forkPointUuid) throws IOException {
        String uuidNeedle = "\"uuid\":\"" + forkPointUuid + "\"";
        int anchor = -1;
        int lineIndex = 0;
        Set<String> pendingToolUses = new LinkedHashSet<>();
        // Pass one stops at the anchor line; nothing after it is retained. The
        // containment hit is only a candidate: the same needle can appear inside
        // row content (a tool echoing a transcript row embeds the whole JSON,
        // needle included), and cutting there would fork from the wrong turn. A
        // malformed row that happens to contain the needle is skipped, not fatal.
        try (Stream<String> lines = Files.lines(source, StandardCharsets.UTF_8)) {
            for (Iterator<String> it = lines.iterator(); it.hasNext(); lineIndex++) {
                String line = it.next();
                if (!line.contains(uuidNeedle)) {
                    continue;
                }
                JsonObject row = parseRow(line);
                if (row != null && forkPointUuid.equals(getJsonString(row, "uuid"))) {
                    anchor = lineIndex;
                    // Seed the pairing with the anchor row's own tool calls: an
                    // interrupted anchor turn must not pass the screen below.
                    if ("assistant".equals(getJsonString(row, "type"))) {
                        pendingToolUses.addAll(collectToolUseIds(row));
                    }
                    break;
                }
            }
        }
        if (anchor < 0) {
            return -1;
        }
        // First assistant row of a cycle whose tool calls are still open; -1
        // once every open call has received its result.
        int incompleteCycleStart = pendingToolUses.isEmpty() ? -1 : anchor;

        // Pass two walks the rows after the anchor tracking line numbers and the
        // tool_use/tool_result pairing: the previous version buffered every row
        // after the anchor in memory, and neither version verified that the rows
        // kept after the anchor resolve their tool calls.
        int cut = -1;
        int totalLines = 0;
        lineIndex = 0;
        try (Stream<String> lines = Files.lines(source, StandardCharsets.UTF_8)) {
            for (Iterator<String> it = lines.iterator(); it.hasNext(); lineIndex++) {
                String line = it.next();
                totalLines = lineIndex + 1;
                if (lineIndex <= anchor) {
                    continue;
                }
                JsonObject row = parseRow(line);
                if (row == null) {
                    continue;
                }
                String type = getJsonString(row, "type");
                if ("assistant".equals(type)) {
                    for (String id : collectToolUseIds(row)) {
                        if (pendingToolUses.add(id) && incompleteCycleStart < 0) {
                            incompleteCycleStart = lineIndex;
                        }
                    }
                } else if ("user".equals(type)) {
                    for (String id : collectToolResultIds(row)) {
                        pendingToolUses.remove(id);
                    }
                    if (pendingToolUses.isEmpty()) {
                        incompleteCycleStart = -1;
                    }
                    if (isRealUserTextRow(line)) {
                        // A real user turn starts here; an open tool call from
                        // the rows in between means the cycle before it never
                        // finished, so the cut excludes that cycle entirely.
                        cut = incompleteCycleStart >= 0 ? incompleteCycleStart : lineIndex;
                        break;
                    }
                }
            }
        }
        if (cut < 0) {
            // No following user turn: the fork keeps the rest of the transcript —
            // unless its tail is an interrupted cycle with an open tool call.
            cut = incompleteCycleStart >= 0 ? incompleteCycleStart : totalLines;
        }
        if (cut <= anchor) {
            throw new DanglingToolUseException(
                    "Fork point's turn ends on an unresolved tool call: " + forkPointUuid);
        }
        return cut;
    }

    /**
     * Collect the {@code tool_use} block ids of one row (an assistant row), in
     * order. String content or absent blocks yield an empty list.
     */
    private static List<String> collectToolUseIds(JsonObject row) {
        return collectBlockIds(row, "tool_use", "id");
    }

    /**
     * Collect the {@code tool_use_id} references of a row's {@code tool_result}
     * blocks (a user row carrying results), in order.
     */
    private static List<String> collectToolResultIds(JsonObject row) {
        return collectBlockIds(row, "tool_result", "tool_use_id");
    }

    private static List<String> collectBlockIds(JsonObject row, String blockType, String idField) {
        List<String> ids = new ArrayList<>();
        JsonElement message = row.get("message");
        if (message == null || !message.isJsonObject()) {
            return ids;
        }
        JsonElement content = message.getAsJsonObject().get("content");
        if (content == null || !content.isJsonArray()) {
            return ids;
        }
        for (JsonElement block : content.getAsJsonArray()) {
            if (!block.isJsonObject()) {
                continue;
            }
            JsonObject blockObject = block.getAsJsonObject();
            if (blockType.equals(getJsonString(blockObject, "type"))) {
                String id = getJsonString(blockObject, idField);
                if (id != null) {
                    ids.add(id);
                }
            }
        }
        return ids;
    }

    /**
     * Parse one JSONL row into an object, or null when the line is not a JSON
     * object (a truncated tail row or foreign payload must not crash the scan).
     */
    private static JsonObject parseRow(String line) {
        try {
            return ROW_GSON.fromJson(line, JsonObject.class);
        } catch (JsonSyntaxException e) {
            return null;
        }
    }

    /**
     * Check whether one JSONL row starts a new user turn. Mirrors {@code
     * HistoryMessageInjector.isHumanUserMessage}: text and image blocks both
     * make the row genuine user input, and a {@code tool_result} block does not
     * disqualify a row that also carries real input — only a tool-result-only
     * row (and meta or sidechain rows) belongs to the assistant cycle and must
     * not end the fork.
     *
     * @param line JSONL row to inspect.
     * @return true when the row is a genuine user text message.
     */
    static boolean isRealUserTextRow(String line) {
        JsonObject row = parseRow(line);
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
        boolean hasUserInput = false;
        for (JsonElement block : content.getAsJsonArray()) {
            if (!block.isJsonObject()) {
                continue;
            }
            String blockType = getJsonString(block.getAsJsonObject(), "type");
            if ("text".equals(blockType) || "image".equals(blockType)) {
                hasUserInput = true;
            }
        }
        return hasUserInput;
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
     *   <li>Current layout: the {@code subagents/} subtree of {@code <projectDir>/<sessionId>/},
     *       copied under the fork's id with .jsonl rows' id fields rewritten. Only that
     *       known subtree is copied — the delete path removes exactly the same subtree,
     *       so anything else beside it would survive a fork delete as an orphan.</li>
     *   <li>Legacy layout: {@code agent-*.jsonl} files directly in the project dir whose
     *       first lines reference the session, copied under fresh names.</li>
     * </ul>
     * Failures are logged and swallowed on purpose — see the caller.
     */
    // Package-private so SessionForkServiceTest can copy a temp sidechain tree.
    void copySidechains(Path sessionDir, String sourceSessionId, String newSessionId) {
        try {
            Path sidechainDir = sessionDir.resolve(sourceSessionId);
            // No-follow on both levels, mirroring the delete path: a link where
            // the sidechain dir is expected must not drag an outside tree in.
            if (Files.isDirectory(sidechainDir, LinkOption.NOFOLLOW_LINKS)) {
                // Mirror the delete path, which removes only the known subagents
                // subtree: copying foreign entries would leave fork directories the
                // delete can never fully clean up (residual empty shells).
                Path subagentsDir = sidechainDir.resolve("subagents");
                if (Files.isDirectory(subagentsDir, LinkOption.NOFOLLOW_LINKS)) {
                    this.copyDirectory(subagentsDir,
                            sessionDir.resolve(newSessionId).resolve("subagents"),
                            sourceSessionId, newSessionId);
                    LOG.debug("[SessionForkService] Copied sidechain directory for fork " + newSessionId);
                }
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
                    // No-follow semantics, mirroring the delete path: a link
                    // inside subagents/ must not pull in content from outside
                    // the source tree, and following a directory loop would
                    // recurse until StackOverflowError — which the catch below
                    // could not intercept anyway.
                    if (Files.isSymbolicLink(entry)) {
                        LOG.warn("[SessionForkService] Skipped a symbolic link in the sidechain copy: "
                                + entry);
                    } else if (Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) {
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
     * A {@code success:false} reply is not an exception — parse it so the cause lands
     * in the log instead of the title silently disappearing.
     */
    private void applyForkTitle(String newSessionId, String forkTitle) {
        if (forkTitle == null || forkTitle.isEmpty()) {
            return;
        }
        try {
            String reply = this.nodeJsServiceCaller.callNodeJsTitlesServiceWithParams(
                    "updateTitle", newSessionId, forkTitle);
            JsonObject result = reply != null ? ROW_GSON.fromJson(reply, JsonObject.class) : null;
            if (result != null && result.has("success") && !result.get("success").getAsBoolean()) {
                String error = result.has("error") && result.get("error").isJsonPrimitive()
                        ? result.get("error").getAsString() : "unknown error";
                LOG.warn("[SessionForkService] Fork title rejected by the titles service: " + error);
                return;
            }
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
     * @param home The user home whose {@code .claude/projects} is searched.
     * @return Session file path, or null when no project directory holds it. IO
     *         errors propagate: the caller reports them as {@code FORK_FAILED}
     *         instead of masking a permissions or disk problem as a missing session.
     */
    private Path findSessionFile(String sessionId, String projectPath, Path home) throws IOException {
        Path projectsDir = home.resolve(".claude").resolve("projects");
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
        }
        return null;
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
            String escapedJson = this.context.escapeJs(ROW_GSON.toJson(result));
            String jsCode = "if (window.onForkResult) { window.onForkResult('" + escapedJson + "'); }";
            this.context.executeJavaScriptQueued(jsCode);
        }
    }
}
