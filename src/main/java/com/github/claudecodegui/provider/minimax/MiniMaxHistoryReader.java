package com.github.claudecodegui.provider.minimax;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.HistoryPathMatcher;
import com.github.claudecodegui.provider.common.HistoryCancellation;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;

/**
 * Reads MiniMax Code (mcode) session history from its on-disk v2 layout.
 *
 * <p>Layouts:
 * <ul>
 *   <li>mcode 0.7.x "v2-final-dated-session": the dir name suffix
 *       {@code session_&lt;base64-of-sessionId&gt;} identifies the session and the dir holds
 *       {@code manifest.json} (sessionId + timestamps) plus {@code messages.jsonl}
 *       (raw transcript; user prompts may arrive prefixed with injected reminder/context
 *       blocks, and workspace/cwd is not persisted).</li>
 *   <li>mcode 0.2.x legacy: {@code snapshot.json} (record + displayMessages) plus
 *       {@code display.jsonl} (event log fallback).</li>
 * </ul>
 *
 * <p>{@code snapshot.json} shape:
 * <pre>
 * {
 *   "record": {
 *     "sessionId": "mvs_...", "workspaceDir": "...", "title": "...",
 *     "createdAtMs": 1, "updatedAtMs": 2, "effectiveModel": "minimax/MiniMax-M3"
 *   },
 *   "displayMessages": [
 *     {"msg_id":"umsg_1","role":"user","msg_type":1,"msg_content":"...","timestamp":1},
 *     {"msg_id":"...","role":"assistant","msg_content":"...","thinking_content":"...",
 *      "tool_calls":[{"tool_name":"bash","tool_call_id":"...","tool_call_status":2,
 *                    "tool_call_args":"{...}","tool_call_result_data":"{...}"}]}
 *   ]
 * }
 * </pre>
 *
 * <p>Path matching is case-insensitive and normalizes {@code \} → {@code /} for Windows.
 */
public class MiniMaxHistoryReader {

    private static final Logger LOG = Logger.getInstance(MiniMaxHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;
    private static final int MAX_TITLE_SCAN_LINES = 200;

    /**
     * Matches a balanced XML-ish block at the very start of a text: injected
     * reminder/context wrappers ({@code <system-reminder>…</system-reminder>},
     * {@code <plugin-hook-context>…</plugin-hook-context>}, …). The real user
     * prompt follows these leading blocks; repeated application strips them all.
     */
    private static final Pattern LEADING_XML_BLOCK =
            Pattern.compile("^<([A-Za-z][\\w-]*)(?:\\s[^>]*)?>[\\s\\S]*?</\\1>\\s*");

    private final Gson gson;
    private final Path minimaxHome;
    private final Path sessionsRoot;

    public MiniMaxHistoryReader() {
        this(defaultMiniMaxHome(), new Gson());
    }

    MiniMaxHistoryReader(Path minimaxHome, Gson gson) {
        this.minimaxHome = minimaxHome;
        this.sessionsRoot = minimaxHome.resolve(Paths.get("v2", "sessions"));
        this.gson = gson;
    }

    private static Path defaultMiniMaxHome() {
        return resolveMinimaxHome(
                System.getenv("MINIMAX_CODE_HOME"),
                System.getenv("MINIMAX_HOME"),
                System.getenv("MINIMAX_DATA_DIR"),
                NodeDetector.resolveHomeForFileOps());
    }

    /**
     * Pure home resolution for tests. Order mirrors where the mcode CLI looks:
     * plugin overrides first, then MINIMAX_DATA_DIR — the variable the
     * official Windows install shims export, which relocates the whole data
     * dir (config + v2/sessions) away from ~/.minimax — and the default last.
     * Ignoring it made every shim-launched session invisible to history.
     */
    static Path resolveMinimaxHome(String codeHome, String home, String dataDir, String defaultUserHome) {
        String override = firstNonBlank(codeHome, home, dataDir);
        if (override != null) {
            return Paths.get(override.trim());
        }
        return Paths.get(defaultUserHome, ".minimax");
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "minimax";
    }

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("sessionCount", sessions.size());
            result.put("provider", "minimax");
            int totalMessages = sessions.stream().mapToInt(s -> s.messageCount).sum();
            result.put("total", totalMessages);
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[MiniMaxHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read MiniMax sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    public List<SessionInfo> listSessionsForProject(String projectPath) throws IOException {
        List<SessionInfo> all = listAllSessions();
        if (projectPath == null || projectPath.trim().isEmpty()) {
            return all;
        }
        List<SessionInfo> filtered = new ArrayList<>();
        for (SessionInfo session : all) {
            // 0.7.x layouts persist no workspace, so their sessions carry no cwd;
            // filtering them out would keep the new transcript layout invisible.
            if (session.cwd == null || pathsMatch(session.cwd, projectPath)) {
                filtered.add(session);
            }
        }
        filtered.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return filtered;
    }

    public List<SessionInfo> listAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();
        if (!Files.isDirectory(sessionsRoot)) {
            LOG.info("[MiniMaxHistoryReader] Sessions root missing: " + sessionsRoot);
            return sessions;
        }
        // v2/sessions/YYYY/MM/DD/<session-dir>
        try (DirectoryStream<Path> years = Files.newDirectoryStream(sessionsRoot)) {
            for (Path year : years) {
                if (!Files.isDirectory(year)) {
                    continue;
                }
                try (DirectoryStream<Path> months = Files.newDirectoryStream(year)) {
                    for (Path month : months) {
                        if (!Files.isDirectory(month)) {
                            continue;
                        }
                        try (DirectoryStream<Path> days = Files.newDirectoryStream(month)) {
                            for (Path day : days) {
                                if (!Files.isDirectory(day)) {
                                    continue;
                                }
                                collectSessionDirs(day, sessions);
                            }
                        }
                    }
                }
            }
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private void collectSessionDirs(Path dayDir, List<SessionInfo> out) {
        try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(dayDir)) {
            for (Path sessionDir : sessionDirs) {
                if (!Files.isDirectory(sessionDir)) {
                    continue;
                }
                SessionInfo info = readSessionSummary(sessionDir);
                if (info != null) {
                    out.add(info);
                }
            }
        } catch (IOException e) {
            LOG.warn("[MiniMaxHistoryReader] Failed to scan " + dayDir + ": " + e.getMessage());
        }
    }

    private SessionInfo readSessionSummary(Path sessionDir) {
        try {
            Path snapshotPath = sessionDir.resolve("snapshot.json");
            if (!Files.isRegularFile(snapshotPath)) {
                return readManifestSummary(sessionDir);
            }
            JsonObject snapshot = JsonParser
                    .parseString(Files.readString(snapshotPath, StandardCharsets.UTF_8))
                    .getAsJsonObject();
            JsonObject record = snapshot.has("record") && snapshot.get("record").isJsonObject()
                    ? snapshot.getAsJsonObject("record") : null;
            if (record == null) {
                return null;
            }
            String sessionId = text(record, "sessionId");
            if (sessionId == null || sessionId.isBlank()) {
                return null;
            }

            SessionInfo info = new SessionInfo();
            info.sessionId = sessionId;
            info.cwd = text(record, "workspaceDir");
            info.title = truncate(firstNonBlank(
                    text(record, "title"),
                    deriveTitleFromSnapshot(snapshot)
            ), MAX_TITLE_CHARS);
            info.firstTimestamp = longVal(record, "createdAtMs", 0L);
            info.lastTimestamp = longVal(record, "updatedAtMs", info.firstTimestamp);
            if (info.lastTimestamp <= 0) {
                try {
                    info.lastTimestamp = Files.getLastModifiedTime(snapshotPath).toMillis();
                } catch (IOException ignored) {
                }
            }

            JsonArray displayMessages = snapshot.has("displayMessages")
                    && snapshot.get("displayMessages").isJsonArray()
                    ? snapshot.getAsJsonArray("displayMessages") : null;
            info.messageCount = displayMessages != null ? displayMessages.size() : 0;

            info.fileSize = Files.size(snapshotPath);
            Path displayPath = sessionDir.resolve("display.jsonl");
            if (Files.isRegularFile(displayPath)) {
                info.fileSize += Files.size(displayPath);
            }
            return info;
        } catch (Exception e) {
            LOG.warn("[MiniMaxHistoryReader] Failed to read session summary " + sessionDir + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Reads a mcode 0.7.x "v2-final-dated-session" directory. The manifest
     * carries the session id and timestamps; the transcript (messages.jsonl)
     * supplies the title. The layout does not persist the workspace, so
     * {@code cwd} stays null and such sessions are surfaced in every project
     * list (see {@link #listSessionsForProject}).
     */
    private SessionInfo readManifestSummary(Path sessionDir) {
        Path manifestPath = sessionDir.resolve("manifest.json");
        if (!Files.isRegularFile(manifestPath)) {
            return null;
        }
        try {
            JsonObject manifest = JsonParser
                    .parseString(Files.readString(manifestPath, StandardCharsets.UTF_8))
                    .getAsJsonObject();
            String sessionId = text(manifest, "sessionId");
            if (sessionId == null || sessionId.isBlank()) {
                return null;
            }

            SessionInfo info = new SessionInfo();
            info.sessionId = sessionId;
            info.cwd = null;
            info.title = truncate(stripInjectedContext(firstUserText(sessionDir)), MAX_TITLE_CHARS);
            info.firstTimestamp = longVal(manifest, "createdAtMs", 0L);
            info.lastTimestamp = longVal(manifest, "updatedAtMs", info.firstTimestamp);
            if (info.lastTimestamp <= 0) {
                try {
                    info.lastTimestamp = Files.getLastModifiedTime(manifestPath).toMillis();
                } catch (IOException ignored) {
                }
            }

            MessageScan scan = scanMessagesFile(sessionDir.resolve("messages.jsonl"));
            info.messageCount = scan.lineCount;
            info.fileSize = Files.size(manifestPath);
            Path messagesPath = sessionDir.resolve("messages.jsonl");
            if (Files.isRegularFile(messagesPath)) {
                info.fileSize += Files.size(messagesPath);
            }
            return info;
        } catch (Exception e) {
            LOG.warn("[MiniMaxHistoryReader] Failed to read manifest summary " + sessionDir + ": " + e.getMessage());
            return null;
        }
    }

    /** The first user prompt of the transcript with injected context stripped. */
    private static String firstUserText(Path sessionDir) {
        Path messagesPath = sessionDir.resolve("messages.jsonl");
        if (!Files.isRegularFile(messagesPath)) {
            return "";
        }
        try (BufferedReader reader = Files.newBufferedReader(messagesPath, StandardCharsets.UTF_8)) {
            String rawLine;
            int scanned = 0;
            while (scanned < MAX_TITLE_SCAN_LINES && (rawLine = reader.readLine()) != null) {
                scanned++;
                String line = rawLine.trim();
                if (line.isEmpty()) {
                    continue;
                }
                JsonObject msg = messageOf(line);
                if (msg == null || !"user".equals(text(msg, "role"))) {
                    continue;
                }
                String stripped = stripInjectedContext(joinedTextBlocks(msg));
                if (!stripped.isBlank()) {
                    return stripped;
                }
            }
        } catch (Exception e) {
            LOG.warn("[MiniMaxHistoryReader] Failed to derive title from " + messagesPath + ": " + e.getMessage());
        }
        return "";
    }

    private static final class MessageScan {
        final int lineCount;

        MessageScan(int lineCount) {
            this.lineCount = lineCount;
        }
    }

    /** Counts non-blank transcript lines without parsing the JSON. */
    private static MessageScan scanMessagesFile(Path messagesPath) {
        if (!Files.isRegularFile(messagesPath)) {
            return new MessageScan(0);
        }
        int lines = 0;
        try (BufferedReader reader = Files.newBufferedReader(messagesPath, StandardCharsets.UTF_8)) {
            String rawLine;
            while ((rawLine = reader.readLine()) != null) {
                if (!rawLine.isBlank()) {
                    lines++;
                }
            }
        } catch (IOException e) {
            LOG.warn("[MiniMaxHistoryReader] Failed to count messages in " + messagesPath + ": " + e.getMessage());
        }
        return new MessageScan(lines);
    }

    /** Parses one messages.jsonl line into its inner {@code message} object, or null. */
    private static JsonObject messageOf(String line) {
        try {
            JsonObject obj = JsonParser.parseString(line).getAsJsonObject();
            return obj.has("message") && obj.get("message").isJsonObject()
                    ? obj.getAsJsonObject("message") : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Joins the {@code text} blocks of a message, skipping non-object entries. */
    private static String joinedTextBlocks(JsonObject msg) {
        StringBuilder sb = new StringBuilder();
        JsonArray content = msg.has("content") && msg.get("content").isJsonArray()
                ? msg.getAsJsonArray("content") : null;
        if (content == null) {
            return "";
        }
        for (JsonElement el : content) {
            if (!el.isJsonObject()) {
                continue;
            }
            String t = text(el.getAsJsonObject(), "text");
            if (t != null && !t.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append('\n');
                }
                sb.append(t);
            }
        }
        return sb.toString();
    }

    /**
     * Removes leading balanced XML blocks (mcode-injected reminders/context)
     * from a user prompt, e.g. {@code <system-reminder>…</system-reminder>
     * <plugin-hook-context>…</plugin-hook-context>\n\nreal prompt} →
     * {@code real prompt}. A prompt that itself starts with XML-ish text loses
     * its first balanced block — accepted trade-off, since every CCGUI-spawned
     * session's first message is context-prefixed.
     */
    static String stripInjectedContext(String userText) {
        if (userText == null) {
            return "";
        }
        String stripped = userText.trim();
        while (!stripped.isEmpty()) {
            var matcher = LEADING_XML_BLOCK.matcher(stripped);
            if (!matcher.find()) {
                break;
            }
            stripped = stripped.substring(matcher.end()).trim();
        }
        return stripped;
    }

    private static String deriveTitleFromSnapshot(JsonObject snapshot) {
        JsonArray messages = snapshot.has("displayMessages")
                && snapshot.get("displayMessages").isJsonArray()
                ? snapshot.getAsJsonArray("displayMessages") : null;
        if (messages == null) {
            return "";
        }
        for (JsonElement el : messages) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject msg = el.getAsJsonObject();
            if ("user".equals(text(msg, "role"))) {
                String content = text(msg, "msg_content");
                if (content != null && !content.isBlank()) {
                    return content;
                }
            }
        }
        return "";
    }

    /**
     * Loads one session's messages as Claude-shaped JSON objects.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        return getSessionMessagesInternal(sessionId, cwd, () -> false, false);
    }

    public List<JsonObject> getSessionMessages(String sessionId, String cwd,
                                               BooleanSupplier cancellation) throws IOException {
        return getSessionMessagesInternal(sessionId, cwd, cancellation, true);
    }

    private List<JsonObject> getSessionMessagesInternal(String sessionId, String cwd,
                                                         BooleanSupplier cancellation, boolean failMissing) throws IOException {
        HistoryCancellation.check(cancellation);
        SessionLookup lookup = lookupSessionDir(sessionId, cwd, cancellation);
        Path sessionDir = lookup.dir();
        if (sessionDir == null) {
            if (failMissing) {
                if (lookup.inconclusive()) {
                    // A snapshot being rewritten can hide its own session id; retry instead of retiring.
                    throw new IOException("MiniMax session snapshots are not readable yet: " + sessionId);
                }
                throw new com.github.claudecodegui.provider.common.SessionHistoryNotFoundException(sessionId, cwd);
            }

            return new ArrayList<>();
        }
        return readSessionDirectory(sessionDir, sessionId, cancellation, failMissing);
    }

    /** Reads one resolved session directory; strict reads never report an existing directory as missing. */
    List<JsonObject> readSessionDirectory(Path sessionDir, String sessionId, BooleanSupplier cancellation,
                                          boolean failMissing) throws IOException {
        // Preferred source: snapshot.json displayMessages.
        Path snapshotPath = sessionDir.resolve("snapshot.json");
        boolean snapshotReadable = false;
        if (Files.isRegularFile(snapshotPath)) {
            try {
                JsonObject snapshot = JsonParser
                        .parseString(Files.readString(snapshotPath, StandardCharsets.UTF_8))
                        .getAsJsonObject();
                snapshotReadable = true;
                if (snapshot.has("displayMessages")
                        && snapshot.get("displayMessages").isJsonArray()
                        && !snapshot.getAsJsonArray("displayMessages").isEmpty()) {
                    return buildMessages(snapshot.getAsJsonArray("displayMessages"), cancellation);
                }
            } catch (CancellationException e) {
                throw e;
            } catch (Exception e) {
                LOG.warn("[MiniMaxHistoryReader] Failed to parse snapshot.json, falling back to display.jsonl: "
                        + e.getMessage());
            }
        }

        // Preferred source for the 0.7.x layout: the raw messages.jsonl transcript.
        boolean manifestReadable = isReadableManifest(sessionDir.resolve("manifest.json"));
        Path messagesPath = sessionDir.resolve("messages.jsonl");
        if (Files.isRegularFile(messagesPath)) {
            return parseMessagesJsonl(messagesPath, cancellation);
        }

        // Fallback: replay display.jsonl events, deduplicating upserts by msg_id.
        Path displayPath = sessionDir.resolve("display.jsonl");
        if (Files.isRegularFile(displayPath)) {
            return parseDisplayJsonl(displayPath, cancellation);
        }
        if (failMissing && !snapshotReadable && !manifestReadable) {
            // The session directory exists, so an unreadable transcript is retryable, never a retirement signal.
            throw new IOException("MiniMax session history is not readable yet: " + sessionId);
        }
        // A readable snapshot/manifest without messages is a valid empty session.
        return new ArrayList<>();
    }

    /** True when a manifest.json exists and parses into a JSON object. */
    private static boolean isReadableManifest(Path manifestPath) {
        if (!Files.isRegularFile(manifestPath)) {
            return false;
        }
        try {
            JsonParser.parseString(Files.readString(manifestPath, StandardCharsets.UTF_8));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private Path resolveSessionDir(String sessionId, String cwd) throws IOException {
        return resolveSessionDir(sessionId, cwd, () -> false);
    }

    private Path resolveSessionDir(String sessionId, String cwd,
                                   BooleanSupplier cancellation) throws IOException {
        return lookupSessionDir(sessionId, cwd, cancellation).dir();
    }

    /** A session directory lookup that also reports whether an unreadable snapshot could hide the session. */
    private record SessionLookup(Path dir, boolean inconclusive) {
    }

    private SessionLookup lookupSessionDir(String sessionId, String cwd,
                                           BooleanSupplier cancellation) throws IOException {
        HistoryCancellation.check(cancellation);
        if (!isSafeSessionId(sessionId)) {
            return new SessionLookup(null, false);
        }
        String wanted = sessionId.trim();
        Path best = null;
        boolean inconclusive = false;
        if (!Files.isDirectory(sessionsRoot)) {
            return new SessionLookup(null, false);
        }
        // Fast path: 0.7.x dir names embed the session id as base64
        // ("…-session_<base64(sessionId)>"), and their manifest carries no
        // workspace to filter on — a name match is authoritative regardless of
        // cwd. Falls through to the snapshot scan below for legacy layouts.
        Path dated = findSessionDirByName(wanted);
        if (dated != null) {
            return new SessionLookup(dated, false);
        }
        // Session dirs are dated mcode-internal names; match by the sessionId
        // inside snapshot.json instead of guessing the dir naming scheme.
        try (DirectoryStream<Path> years = Files.newDirectoryStream(sessionsRoot)) {
            for (Path year : years) {
                HistoryCancellation.check(cancellation);
                if (!Files.isDirectory(year)) {
                    continue;
                }
                try (DirectoryStream<Path> months = Files.newDirectoryStream(year)) {
                    for (Path month : months) {
                        HistoryCancellation.check(cancellation);
                        if (!Files.isDirectory(month)) {
                            continue;
                        }
                        try (DirectoryStream<Path> days = Files.newDirectoryStream(month)) {
                            for (Path day : days) {
                                HistoryCancellation.check(cancellation);
                                if (!Files.isDirectory(day)) {
                                    continue;
                                }
                                try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(day)) {
                                    for (Path sessionDir : sessionDirs) {
                                        HistoryCancellation.check(cancellation);
                                        if (!Files.isDirectory(sessionDir)) {
                                            continue;
                                        }
                                        // Read snapshot.json once per dir — the record
                                        // carries both the id and the workspace.
                                        JsonObject record = readSessionRecord(sessionDir, cancellation);
                                        if (record == null) {
                                            inconclusive |= mayHideSession(sessionDir, wanted);
                                            continue;
                                        }
                                        if (!wanted.equals(text(record, "sessionId"))) {
                                            continue;
                                        }
                                        // Prefer a session whose workspace matches cwd.
                                        if (cwd != null && !cwd.isBlank()) {
                                            String ws = text(record, "workspaceDir");
                                            if (ws != null && pathsMatch(ws, cwd)) {
                                                return new SessionLookup(sessionDir, false);
                                            }
                                        }
                                        if (best == null) {
                                            best = sessionDir;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return new SessionLookup(best, best == null && inconclusive);
    }

    /**
     * Locates a 0.7.x session directory by decoding the base64 suffix of
     * {@code …-session_<base64(sessionId)>} dir names; null when no dir name
     * decodes to the wanted id (legacy layouts fall back to the snapshot scan).
     */
    private Path findSessionDirByName(String wantedSessionId) throws IOException {
        try (DirectoryStream<Path> years = Files.newDirectoryStream(sessionsRoot)) {
            for (Path year : years) {
                if (!Files.isDirectory(year)) {
                    continue;
                }
                try (DirectoryStream<Path> months = Files.newDirectoryStream(year)) {
                    for (Path month : months) {
                        if (!Files.isDirectory(month)) {
                            continue;
                        }
                        try (DirectoryStream<Path> days = Files.newDirectoryStream(month)) {
                            for (Path day : days) {
                                if (!Files.isDirectory(day)) {
                                    continue;
                                }
                                try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(day)) {
                                    for (Path sessionDir : sessionDirs) {
                                        if (wantedSessionId.equals(decodeSessionId(sessionDir))) {
                                            return sessionDir;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        return null;
    }

    /** Decodes the base64-encoded session id embedded in a dated session dir name. */
    static String decodeSessionId(Path sessionDir) {
        String name = sessionDir.getFileName().toString();
        int idx = name.indexOf("session_");
        if (idx < 0) {
            return null;
        }
        String encoded = name.substring(idx + "session_".length());
        try {
            int padding = (4 - encoded.length() % 4) % 4;
            return new String(Base64.getDecoder().decode(encoded + "=".repeat(padding)),
                    StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /**
     * True when a directory that could not be identified might still be the wanted session: its
     * snapshot is mid-rewrite but names the session, or a transcript exists before any snapshot.
     */
    private static boolean mayHideSession(Path sessionDir, String wantedSessionId) {
        Path snapshotPath = sessionDir.resolve("snapshot.json");
        if (!Files.isRegularFile(snapshotPath)) {
            return Files.isRegularFile(sessionDir.resolve("display.jsonl"));
        }
        try {
            String text = Files.readString(snapshotPath, StandardCharsets.UTF_8);
            try {
                JsonParser.parseString(text).getAsJsonObject();
                return false;
            } catch (Exception unparseable) {
                return text.contains(wantedSessionId);
            }
        } catch (IOException unreadable) {
            return true;
        }
    }

    /**
     * Reads the {@code record} object from a session's snapshot.json, or null
     * when the snapshot is missing or malformed.
     */
    private static JsonObject readSessionRecord(Path sessionDir) {
        return readSessionRecord(sessionDir, () -> false);
    }

    private static JsonObject readSessionRecord(
            Path sessionDir,
            BooleanSupplier cancellation
    ) {
        try {
            HistoryCancellation.check(cancellation);
            Path snapshotPath = sessionDir.resolve("snapshot.json");
            if (!Files.isRegularFile(snapshotPath)) {
                return null;
            }
            JsonObject snapshot = JsonParser
                    .parseString(Files.readString(snapshotPath, StandardCharsets.UTF_8))
                    .getAsJsonObject();
            return snapshot.has("record") && snapshot.get("record").isJsonObject()
                    ? snapshot.getAsJsonObject("record") : null;
        } catch (CancellationException e) {
            throw e;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Converts mcode displayMessages into Claude-shaped messages:
     * user text, assistant thinking / text, tool_use, and tool_result.
     *
     * <p>Also maps the last assistant {@code usage} object from the on-disk
     * snapshot into the generated assistant message's top-level {@code usage}
     * field so the context-usage status bar can read it.</p>
     */
    private static List<JsonObject> buildMessages(JsonArray displayMessages) {
        return buildMessages(displayMessages, () -> false);
    }

    private static List<JsonObject> buildMessages(
            JsonArray displayMessages,
            BooleanSupplier cancellation
    ) {
        // Find the last assistant displayMessage that carries a non-empty usage object.
        JsonObject targetUsage = null;
        int targetAssistantIndex = -1;
        for (int i = 0; i < displayMessages.size(); i++) {
            HistoryCancellation.check(cancellation);
            JsonElement el = displayMessages.get(i);
            if (!el.isJsonObject()) {
                // One malformed entry must not fail the whole snapshot (which
                // would fall back to display.jsonl) — skip it, like the loop below.
                continue;
            }
            JsonObject msg = el.getAsJsonObject();
            if ("assistant".equals(text(msg, "role")) && msg.has("usage") && msg.get("usage").isJsonObject()) {
                targetUsage = msg.getAsJsonObject("usage");
                targetAssistantIndex = i;
            }
        }

        List<JsonObject> messages = new ArrayList<>();
        int counter = 0;
        int pendingTargetAssistantLastIdx = -1;
        for (int i = 0; i < displayMessages.size(); i++) {
            HistoryCancellation.check(cancellation);
            JsonElement el = displayMessages.get(i);
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject msg = el.getAsJsonObject();
            String role = text(msg, "role");

            // If the previous displayMessage was the target assistant and the current
            // one is not an assistant, attach the mapped usage to the last assistant
            // message that belongs to that original assistant.
            if (pendingTargetAssistantLastIdx >= 0 && !"assistant".equals(role)) {
                attachMappedUsage(messages.get(pendingTargetAssistantLastIdx), targetUsage);
                pendingTargetAssistantLastIdx = -1;
            }

            if ("user".equals(role)) {
                String content = text(msg, "msg_content");
                if (content == null || content.isBlank()) {
                    continue;
                }
                counter++;
                messages.add(buildUserTextMessage(content, "minimax-user-" + counter));
            } else if ("assistant".equals(role)) {
                String thinking = text(msg, "thinking_content");
                if (thinking != null && !thinking.isBlank()) {
                    counter++;
                    messages.add(buildAssistantThinkingMessage(thinking, "minimax-think-" + counter));
                    if (i == targetAssistantIndex) {
                        pendingTargetAssistantLastIdx = messages.size() - 1;
                    }
                }
                String content = text(msg, "msg_content");
                if (content != null && !content.isBlank()) {
                    counter++;
                    messages.add(buildAssistantTextMessage(content, "minimax-text-" + counter));
                    if (i == targetAssistantIndex) {
                        pendingTargetAssistantLastIdx = messages.size() - 1;
                    }
                }
                if (msg.has("tool_calls") && msg.get("tool_calls").isJsonArray()) {
                    for (JsonElement callEl : msg.getAsJsonArray("tool_calls")) {
                        if (!callEl.isJsonObject()) {
                            continue;
                        }
                        JsonObject call = callEl.getAsJsonObject();
                        String callId = firstNonBlank(text(call, "tool_call_id"),
                                text(call, "toolCallId"));
                        if (callId == null || callId.isBlank()) {
                            callId = "minimax-tool-" + (++counter);
                        }
                        String name = firstNonBlank(text(call, "tool_name"), text(call, "toolName"));
                        if (name == null || name.isBlank()) {
                            name = "tool";
                        }
                        JsonObject input = parseJsonObject(text(call, "tool_call_args"));
                        messages.add(buildToolUseMessage(callId, name, input));
                        if (i == targetAssistantIndex) {
                            pendingTargetAssistantLastIdx = messages.size() - 1;
                        }

                        String resultData = firstNonBlank(text(call, "tool_call_result_data"),
                                text(call, "toolCallResultData"));
                        String resultText = extractToolResultText(resultData);
                        if (!resultText.isBlank()) {
                            messages.add(buildToolResultMessage(
                                    callId, truncate(resultText, MAX_TOOL_RESULT_CHARS),
                                    isErrorResult(resultData)));
                        }
                    }
                }
            }
        }

        // If the last displayMessage was the target assistant, attach usage now.
        if (pendingTargetAssistantLastIdx >= 0) {
            attachMappedUsage(messages.get(pendingTargetAssistantLastIdx), targetUsage);
        }

        return messages;
    }

    private static void attachMappedUsage(JsonObject target, JsonObject usage) {
        if (target == null || usage == null) {
            return;
        }
        JsonObject mapped = new JsonObject();
        if (usage.has("input_tokens") && usage.get("input_tokens").isJsonPrimitive()
                && usage.get("input_tokens").getAsInt() > 0) {
            mapped.addProperty("input_tokens", usage.get("input_tokens").getAsInt());
        }
        if (usage.has("output_tokens") && usage.get("output_tokens").isJsonPrimitive()
                && usage.get("output_tokens").getAsInt() > 0) {
            mapped.addProperty("output_tokens", usage.get("output_tokens").getAsInt());
        }
        if (usage.has("total_tokens") && usage.get("total_tokens").isJsonPrimitive()
                && usage.get("total_tokens").getAsInt() > 0) {
            mapped.addProperty("total_tokens", usage.get("total_tokens").getAsInt());
        }
        if (usage.has("cache_read") && usage.get("cache_read").isJsonPrimitive()
                && usage.get("cache_read").getAsInt() > 0) {
            mapped.addProperty("cache_read_input_tokens", usage.get("cache_read").getAsInt());
        }
        if (usage.has("context_window") && usage.get("context_window").isJsonPrimitive()
                && usage.get("context_window").getAsInt() > 0) {
            mapped.addProperty("model_context_window", usage.get("context_window").getAsInt());
        }
        target.add("usage", mapped);
    }

    /**
     * Fallback parser for display.jsonl: keeps the latest display_upserted
     * event per msg_id (upserts may re-emit updated tool results).
     */
    private List<JsonObject> parseDisplayJsonl(Path displayPath) throws IOException {
        return parseDisplayJsonl(displayPath, () -> false);
    }

    private List<JsonObject> parseDisplayJsonl(
            Path displayPath,
            BooleanSupplier cancellation
    ) throws IOException {
        // LinkedHashMap: the stable timestamp sort below keeps first-seen
        // (file) order for messages sharing a timestamp.
        Map<String, JsonObject> latestById = new LinkedHashMap<>();
        Map<String, Long> seqById = new HashMap<>();
        try (java.io.BufferedReader reader = Files.newBufferedReader(displayPath, StandardCharsets.UTF_8)) {
            String rawLine;
            while ((rawLine = reader.readLine()) != null) {
                HistoryCancellation.check(cancellation);
                String line = rawLine.trim();
                if (line.isEmpty()) {
                    continue;
                }
                JsonObject obj;
                try {
                    obj = JsonParser.parseString(line).getAsJsonObject();
                } catch (Exception e) {
                    continue;
                }
                if (!"message.display_upserted".equals(text(obj, "kind"))) {
                    continue;
                }
                String msgId = text(obj, "msgId");
                if (msgId == null || msgId.isBlank()) {
                    continue;
                }
                long seq = longVal(obj, "seq", -1L);
                Long prev = seqById.get(msgId);
                if (prev == null || seq >= prev) {
                    seqById.put(msgId, seq);
                    JsonObject message = obj.has("message") && obj.get("message").isJsonObject()
                            ? obj.getAsJsonObject("message") : null;
                    if (message != null) {
                        latestById.put(msgId, message);
                    }
                }
            }
        }
        JsonArray ordered = new JsonArray();
        latestById.entrySet().stream()
                .sorted(Map.Entry.comparingByValue(
                        Comparator.comparingLong((JsonObject m) -> longVal(m, "timestamp", 0L))))
                .forEach(entry -> ordered.add(entry.getValue()));
        return buildMessages(ordered, cancellation);
    }

    /**
     * Parses the mcode 0.7.x {@code messages.jsonl} raw transcript. Each line is
     * converted to the legacy displayMessage shape and fed through
     * {@link #buildMessages}, so thinking / text / tool_use / tool_result and
     * usage mapping behave exactly as with the 0.2.x layout. Injected
     * reminder/context prefixes are stripped from user prompts; tool results
     * arrive as separate {@code toolResult} lines and are re-paired with their
     * tool calls by id afterwards.
     */
    private List<JsonObject> parseMessagesJsonl(Path messagesPath, BooleanSupplier cancellation) throws IOException {
        JsonArray display = new JsonArray();
        // tool_call display objects in file order — tool results are looked up later.
        Map<String, JsonObject> toolCallsByCallId = new LinkedHashMap<>();
        Map<String, String> resultDataByCallId = new HashMap<>();
        try (BufferedReader reader = Files.newBufferedReader(messagesPath, StandardCharsets.UTF_8)) {
            String rawLine;
            while ((rawLine = reader.readLine()) != null) {
                HistoryCancellation.check(cancellation);
                String line = rawLine.trim();
                if (line.isEmpty()) {
                    continue;
                }
                JsonObject msg = messageOf(line);
                if (msg == null) {
                    continue;
                }
                String role = text(msg, "role");
                JsonArray content = msg.has("content") && msg.get("content").isJsonArray()
                        ? msg.getAsJsonArray("content") : null;
                if ("toolResult".equals(role)) {
                    String callId = firstNonBlank(text(msg, "toolCallId"), text(msg, "tool_call_id"));
                    String joined = joinedTextBlocks(msg);
                    if (callId != null && !joined.isBlank()) {
                        JsonObject data = new JsonObject();
                        JsonArray blocks = new JsonArray();
                        JsonObject textBlock = new JsonObject();
                        textBlock.addProperty("type", "text");
                        textBlock.addProperty("text", joined);
                        blocks.add(textBlock);
                        data.add("content", blocks);
                        resultDataByCallId.put(callId, data.toString());
                    }
                    continue;
                }
                if ("user".equals(role)) {
                    String stripped = stripInjectedContext(joinedTextBlocks(msg));
                    if (stripped.isBlank()) {
                        continue;
                    }
                    JsonObject displayMsg = new JsonObject();
                    displayMsg.addProperty("role", "user");
                    displayMsg.addProperty("msg_content", stripped);
                    display.add(displayMsg);
                    continue;
                }
                if ("assistant".equals(role)) {
                    JsonObject displayMsg = new JsonObject();
                    displayMsg.addProperty("role", "assistant");
                    String thinking = joinedBlocks(msg, content, "thinking");
                    if (!thinking.isBlank()) {
                        displayMsg.addProperty("thinking_content", thinking);
                    }
                    String textContent = joinedBlocks(msg, content, "text");
                    if (!textContent.isBlank()) {
                        displayMsg.addProperty("msg_content", textContent);
                    }
                    JsonArray toolCalls = toolCallEntries(msg, content, toolCallsByCallId);
                    if (toolCalls.size() > 0) {
                        displayMsg.add("tool_calls", toolCalls);
                    }
                    if (msg.has("usage") && msg.get("usage").isJsonObject()) {
                        displayMsg.add("usage", msg.getAsJsonObject("usage").deepCopy());
                    }
                    if (displayMsg.size() > 1) {
                        display.add(displayMsg);
                    }
                }
                // Other roles (e.g. "custom" internal messages) are not displayable.
            }
        }
        // Re-pair tool results with their calls (separate toolResult lines upstream).
        for (Map.Entry<String, JsonObject> entry : toolCallsByCallId.entrySet()) {
            String resultData = resultDataByCallId.get(entry.getKey());
            if (resultData != null) {
                entry.getValue().addProperty("tool_call_result_data", resultData);
            }
        }
        return buildMessages(display, cancellation);
    }

    /** Joins the string payload of every block of {@code blockType} in a message. */
    private static String joinedBlocks(JsonObject msg, JsonArray content, String blockType) {
        StringBuilder sb = new StringBuilder();
        if (content == null) {
            return "";
        }
        for (JsonElement el : content) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject block = el.getAsJsonObject();
            if (!blockType.equals(text(block, "type"))) {
                continue;
            }
            String t = text(block, blockType.equals("thinking") ? "thinking" : "text");
            if (t != null && !t.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append('\n');
                }
                sb.append(t);
            }
        }
        return sb.toString();
    }

    /**
     * Collects {@code toolCall} blocks into legacy {@code tool_calls} entries and
     * registers them by call id so later {@code toolResult} lines can pair up.
     */
    private static JsonArray toolCallEntries(JsonObject msg, JsonArray content,
                                             Map<String, JsonObject> toolCallsByCallId) {
        JsonArray entries = new JsonArray();
        if (content == null) {
            return entries;
        }
        for (JsonElement el : content) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject block = el.getAsJsonObject();
            if (!"toolCall".equals(text(block, "type"))) {
                continue;
            }
            String callId = firstNonBlank(text(block, "id"), text(block, "tool_call_id"));
            if (callId == null || callId.isBlank()) {
                continue;
            }
            String name = firstNonBlank(text(block, "name"), text(block, "tool_name"));
            JsonObject entry = new JsonObject();
            entry.addProperty("tool_call_id", callId);
            entry.addProperty("tool_name", name != null ? name : "tool");
            JsonElement args = block.get("arguments");
            if (args != null && args.isJsonObject()) {
                entry.addProperty("tool_call_args", args.getAsJsonObject().toString());
            } else if (args != null && args.isJsonPrimitive()) {
                entry.addProperty("tool_call_args", args.getAsString());
            } else {
                entry.addProperty("tool_call_args", "{}");
            }
            entries.add(entry);
            toolCallsByCallId.put(callId, entry);
        }
        return entries;
    }

    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        Path sessionDir = resolveSessionDir(sessionId, projectPath);
        if (sessionDir == null) {
            return false;
        }
        deleteRecursively(sessionDir);
        Path parent = sessionDir.getParent();
        pruneEmptyDirs(parent, 3);
        return true;
    }

    private static void pruneEmptyDirs(Path dir, int depth) {
        if (dir == null || depth <= 0) {
            return;
        }
        try {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
                if (stream.iterator().hasNext()) {
                    return;
                }
            }
            Files.deleteIfExists(dir);
            pruneEmptyDirs(dir.getParent(), depth - 1);
        } catch (IOException ignored) {
        }
    }

    private static void deleteRecursively(Path root) throws IOException {
        // NOFOLLOW_LINKS: a (crafted) symlink inside a session dir must be
        // deleted as a link, never recursed into — otherwise the contents of
        // the directory it points at would be wiped along with the session.
        if (root == null || !Files.exists(root, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        if (Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(root)) {
                for (Path child : stream) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(root);
    }

    // ------------------------------------------------------------------
    // Message builders (Claude-shaped, same as KimiHistoryReader)
    // ------------------------------------------------------------------

    private static JsonObject buildUserTextMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildAssistantTextMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildAssistantThinkingMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "thinking");
        block.addProperty("thinking", text);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildToolUseMessage(String id, String name, JsonObject input) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", name);
        block.add("input", input != null ? input : new JsonObject());
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static JsonObject buildToolResultMessage(String toolUseId, String contentText, boolean isError) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("is_error", isError);
        block.addProperty("content", contentText != null ? contentText : "");
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    // ------------------------------------------------------------------
    // Small helpers
    // ------------------------------------------------------------------

    /**
     * mcode tool results are JSON strings like
     * {@code {"content":[{"type":"text","text":"..."}]}}.
     */
    private static String extractToolResultText(String resultData) {
        if (resultData == null || resultData.isBlank()) {
            return "";
        }
        JsonObject obj = parseJsonObject(resultData);
        if (obj == null) {
            return resultData;
        }
        if (obj.has("content") && obj.get("content").isJsonArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonElement el : obj.getAsJsonArray("content")) {
                if (el.isJsonPrimitive()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(el.getAsString());
                    continue;
                }
                if (!el.isJsonObject()) {
                    continue;
                }
                String t = text(el.getAsJsonObject(), "text");
                if (t != null && !t.isEmpty()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(t);
                }
            }
            if (sb.length() > 0) {
                return sb.toString();
            }
        }
        if (obj.has("error") && !obj.get("error").isJsonNull()) {
            JsonElement err = obj.get("error");
            return err.isJsonPrimitive() ? err.getAsString() : err.toString();
        }
        return obj.toString();
    }

    /**
     * Structured error check: only a non-null top-level {@code "error"} field
     * marks the result as failed. A raw substring match would false-positive
     * on tool output that merely quotes JSON containing the word "error".
     */
    private static boolean isErrorResult(String resultData) {
        JsonObject obj = parseJsonObject(resultData);
        return obj != null && obj.has("error") && !obj.get("error").isJsonNull();
    }

    private static JsonObject parseJsonObject(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            JsonElement el = JsonParser.parseString(raw);
            return el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    static String normalizePath(String path) {
        return HistoryPathMatcher.normalize(path);
    }

    static boolean pathsMatch(String sessionCwd, String projectPath) {
        return HistoryPathMatcher.matches(sessionCwd, projectPath);
    }

    static boolean isSafeSessionId(String sessionId) {
        if (sessionId == null || sessionId.trim().isEmpty()) {
            return false;
        }
        String trimmed = sessionId.trim();
        if (trimmed.equals(".") || trimmed.contains("..")
                || trimmed.contains("/") || trimmed.contains("\\")) {
            return false;
        }
        return trimmed.matches("^[A-Za-z0-9._-]+$");
    }

    private static String text(JsonObject obj, String key) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return null;
        }
        JsonElement el = obj.get(key);
        return el.isJsonPrimitive() ? el.getAsString() : null;
    }

    private static long longVal(JsonObject obj, String key, long fallback) {
        if (obj == null || !obj.has(key) || obj.get(key).isJsonNull()) {
            return fallback;
        }
        try {
            return obj.get(key).getAsLong();
        } catch (Exception e) {
            return fallback;
        }
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) {
                return value;
            }
        }
        return null;
    }

    private static String truncate(String value, int maxChars) {
        if (value == null) {
            return "";
        }
        return value.length() <= maxChars ? value : value.substring(0, maxChars) + "…";
    }
}
