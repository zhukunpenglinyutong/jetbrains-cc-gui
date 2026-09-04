package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.HistoryPathMatcher;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * Reads Gemini CLI (agy) conversation history from the CLI-owned storage at
 * {@code ~/.gemini/antigravity-cli/}:
 * <ul>
 *   <li>{@code cache/conversation_metadata.json} — legacy listing cache. The current
 *       CLI no longer maintains it (live 2026-09-04: entries months stale, none backed
 *       by an existing database), so an entry is trusted only when its
 *       {@code conversations/<id>.db} still exists; when nothing survives the filter,
 *       listing falls back to scanning the databases.
 *       {@code cache/last_conversations.json} — cwd → latest-conversation fallback
 *       for project scoping.</li>
 *   <li>{@code conversations/<uuid>.db} — one SQLite database per conversation
 *       (with {@code -shm}/{@code -wal} sidecars); {@code steps.step_payload} holds
 *       protobuf-encoded step content.</li>
 * </ul>
 *
 * <p>The CLI's internal protobuf schema is not a stable public contract, so the
 * payload decoder is intentionally minimal and defensive: only a small,
 * live-verified field map is read and anything else is skipped with a log line —
 * content is never fabricated. The storage contract (wire map, step-type enum,
 * cache shapes) is documented in {@code docs/gemini/GEMINI-INTEGRATION-QUICKSTART.md}.
 */
public class GeminiHistoryReader {

    private static final Logger LOG = Logger.getInstance(GeminiHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;
    private static final String SQLITE_JDBC = "org.sqlite.JDBC";
    /** Same whitelist the shared delete service enforces before any path is resolved. */
    private static final String SAFE_ID_PATTERN = "^[A-Za-z0-9._-]+$";

    // Live step_type enum values (integer column, verified against agy 1.1.22).
    private static final int STEP_TYPE_USER = 14;
    private static final int STEP_TYPE_AGENT = 15;
    private static final int STEP_TYPE_TOOL = 132;

    private final Gson gson;
    private final Path cliHome;

    public GeminiHistoryReader() {
        this(defaultCliHome(), new Gson());
    }

    /** Test constructor that points the reader at an isolated CLI-home fixture. */
    GeminiHistoryReader(Path cliHome, Gson gson) {
        this.cliHome = cliHome;
        this.gson = gson;
    }

    static Path defaultCliHome() {
        String home = NodeDetector.resolveHomeForFileOps();
        return Paths.get(home, ".gemini", "antigravity-cli");
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public String provider = "gemini";
        /** Decoded workspace paths from the CLI's WorkspaceURIs (first one mirrors cwd). */
        public List<String> workspaces;
    }

    // ── Listing ──────────────────────────────────────────────────────────────

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("sessionCount", sessions.size());
            int totalMessages = sessions.stream().mapToInt(s -> s.messageCount).sum();
            result.put("total", totalMessages);
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[GeminiHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Gemini sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    public List<SessionInfo> listSessionsForProject(String projectPath) throws IOException {
        List<SessionInfo> all = listAllSessions();
        if (projectPath == null || projectPath.trim().isEmpty()) {
            return all;
        }
        String normalizedProject = normalizePath(projectPath);
        Set<String> lastConversationIds = lastConversationIdsForProject(normalizedProject);
        List<SessionInfo> filtered = new ArrayList<>();
        for (SessionInfo session : all) {
            if (matchesProject(session, normalizedProject, lastConversationIds, projectPath)) {
                filtered.add(session);
            }
        }
        filtered.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return filtered;
    }

    public List<SessionInfo> listAllSessions() throws IOException {
        Path cache = metadataCachePath();
        if (Files.isRegularFile(cache)) {
            List<SessionInfo> fromCache = listSessionsFromMetadataCache(cache);
            if (!fromCache.isEmpty()) {
                return fromCache;
            }
            // Every cache entry was a ghost (no backing database) — the scan is
            // the effective listing source on a stale cache (live 2026-09-04).
            LOG.debug("[GeminiHistoryReader] Metadata cache yielded no sessions with an "
                    + "existing conversation database, scanning conversations/");
        }
        return listSessionsByScanningDatabases();
    }

    private List<SessionInfo> listSessionsFromMetadataCache(Path cache) {
        List<SessionInfo> sessions = new ArrayList<>();
        JsonObject root;
        try {
            root = JsonParser.parseString(Files.readString(cache, StandardCharsets.UTF_8))
                    .getAsJsonObject();
        } catch (Exception e) {
            LOG.warn("[GeminiHistoryReader] Metadata cache unreadable, falling back to db scan: "
                    + e.getMessage());
            return sessions;
        }
        JsonObject conversations = root.has("conversations") && root.get("conversations").isJsonObject()
                ? root.getAsJsonObject("conversations")
                : null;
        if (conversations == null) {
            return sessions;
        }
        int skipped = 0;
        for (Map.Entry<String, JsonElement> entry : conversations.entrySet()) {
            try {
                SessionInfo info = sessionFromCacheEntry(entry.getKey(), entry.getValue());
                if (info != null) {
                    sessions.add(info);
                } else {
                    skipped++;
                }
            } catch (Exception e) {
                // Skip malformed entries; a broken one must never break the listing.
                skipped++;
                LOG.debug("[GeminiHistoryReader] Skipping malformed cache entry "
                        + entry.getKey() + ": " + e.getMessage());
            }
        }
        if (skipped > 0) {
            LOG.debug("[GeminiHistoryReader] Skipped " + skipped
                    + " metadata-cache entr(ies) (malformed, internal, or without an "
                    + "existing conversation database)");
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private SessionInfo sessionFromCacheEntry(String key, JsonElement element) {
        if (element == null || !element.isJsonObject()) {
            return null;
        }
        JsonObject entry = element.getAsJsonObject();
        if (entry.has("is_internal") && entry.get("is_internal").isJsonPrimitive()
                && entry.get("is_internal").getAsBoolean()) {
            return null;
        }
        JsonElement summaryElement = entry.get("summary");
        if (summaryElement == null || !summaryElement.isJsonObject()) {
            return null;
        }
        JsonObject summary = summaryElement.getAsJsonObject();
        String id = stringField(summary, "ID");
        if (id == null || id.isBlank() || !isSafeSessionId(id)) {
            return null;
        }
        SessionInfo info = new SessionInfo();
        info.sessionId = id.trim();
        // The cache is stale whenever the CLI resets its storage: entries whose
        // conversation database no longer exists must not shadow the real ones
        // (live 2026-09-04: 84 entries, 0 with a database on disk).
        if (!Files.isRegularFile(conversationDbPath(info.sessionId))) {
            return null;
        }
        String title = stringField(summary, "Title");
        String preview = stringField(summary, "Preview");
        info.title = resolveSessionTitle(title, preview, info.sessionId);
        info.messageCount = intField(summary, "NumSteps");
        info.lastTimestamp = parseTimestamp(stringField(summary, "UpdatedAt"));
        if (info.lastTimestamp <= 0) {
            info.lastTimestamp = parseTimestamp(stringField(entry, "last_modified_time"));
        }
        if (info.lastTimestamp <= 0) {
            info.lastTimestamp = fileMtime(conversationDbPath(info.sessionId));
        }
        info.firstTimestamp = info.lastTimestamp;
        info.workspaces = decodeWorkspaceUris(summary);
        info.cwd = info.workspaces != null && !info.workspaces.isEmpty() ? info.workspaces.get(0) : null;
        if (info.lastTimestamp <= 0) {
            info.lastTimestamp = System.currentTimeMillis();
            info.firstTimestamp = info.lastTimestamp;
        }
        return info;
    }

    /**
     * Fallback when the metadata cache is missing, unreadable, or stale (no entry
     * backed by an existing database — the effective listing source on a current
     * CLI install): scan the per-conversation databases directly. Titles come from
     * the CLI's summaries database when it can be opened (best-effort — it is
     * equally stale on current installs); otherwise the session id doubles as the
     * title.
     */
    private List<SessionInfo> listSessionsByScanningDatabases() throws IOException {
        Map<String, String[]> summaries = loadConversationSummaries();
        List<SessionInfo> sessions = new ArrayList<>();
        Path conversationsDir = conversationsPath();
        if (!Files.isDirectory(conversationsDir)) {
            return sessions;
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(conversationsDir, "*.db")) {
            for (Path db : stream) {
                String fileName = db.getFileName().toString();
                String id = fileName.substring(0, fileName.length() - ".db".length());
                if (!isSafeSessionId(id)) {
                    continue;
                }
                SessionInfo info = new SessionInfo();
                info.sessionId = id;
                String[] summary = summaries.get(id);
                info.title = summary != null
                        ? resolveSessionTitle(summary[0], summary[1], id)
                        : id;
                info.lastTimestamp = fileMtime(db);
                info.firstTimestamp = info.lastTimestamp;
                info.messageCount = 0;
                info.cwd = null;
                sessions.add(info);
            }
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    /** conversation_id → {title, preview} from the CLI's summaries database (best effort). */
    private Map<String, String[]> loadConversationSummaries() {
        Map<String, String[]> out = new HashMap<>();
        Path summariesDb = cliHome.resolve("conversation_summaries.db");
        if (!Files.isRegularFile(summariesDb)) {
            return out;
        }
        try (Connection conn = openReadOnlyConnection(summariesDb)) {
            if (conn == null) {
                return out;
            }
            String sql = "SELECT conversation_id, title, preview FROM conversation_summaries";
            try (Statement st = conn.createStatement();
                 ResultSet rs = st.executeQuery(sql)) {
                while (rs.next()) {
                    String id = rs.getString(1);
                    if (id != null && !id.isBlank()) {
                        out.put(id.trim(), new String[]{rs.getString(2), rs.getString(3)});
                    }
                }
            }
        } catch (Exception e) {
            LOG.debug("[GeminiHistoryReader] Summaries database unusable: " + e.getMessage());
        }
        return out;
    }

    private boolean matchesProject(SessionInfo session, String normalizedProject,
                                   Set<String> lastConversationIds, String rawProjectPath) {
        if (session.workspaces != null) {
            for (String workspace : session.workspaces) {
                if (workspace != null && pathsMatch(workspace, normalizedProject)) {
                    return true;
                }
            }
        }
        if (lastConversationIds.contains(session.sessionId)) {
            // The CLI itself launched this conversation from the current project
            // directory even though no workspace URI points here.
            if (session.cwd == null) {
                session.cwd = rawProjectPath;
            }
            return true;
        }
        return false;
    }

    /** Ids the CLI recorded as its latest conversation for the given project directory. */
    private Set<String> lastConversationIdsForProject(String normalizedProject) {
        Set<String> ids = new HashSet<>();
        Path lastConversations = cliHome.resolve("cache").resolve("last_conversations.json");
        if (!Files.isRegularFile(lastConversations)) {
            return ids;
        }
        try {
            JsonObject root = JsonParser.parseString(
                    Files.readString(lastConversations, StandardCharsets.UTF_8)).getAsJsonObject();
            for (Map.Entry<String, JsonElement> entry : root.entrySet()) {
                if (!entry.getValue().isJsonPrimitive()) {
                    continue;
                }
                String cwd = normalizePath(entry.getKey());
                if (cwd.equals(normalizedProject) || pathsMatch(cwd, normalizedProject)) {
                    ids.add(entry.getValue().getAsString());
                }
            }
        } catch (Exception e) {
            LOG.debug("[GeminiHistoryReader] last_conversations.json unreadable: " + e.getMessage());
        }
        return ids;
    }

    // ── Content loading ──────────────────────────────────────────────────────

    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            LOG.warn("[GeminiHistoryReader] Refusing session id outside the shared whitelist: "
                    + sessionId);
            return List.of();
        }
        Path db = conversationDbPath(sessionId.trim());
        if (!Files.isRegularFile(db)) {
            return List.of();
        }
        Connection conn = null;
        Path tempCopy = null;
        try {
            try {
                conn = openReadOnlyConnection(db);
            } catch (SQLException e) {
                // A live -wal sidecar can defeat mode=ro; fall back to reading a copy.
                tempCopy = copyWithSidecarsToTemp(db);
                if (tempCopy == null) {
                    throw e;
                }
                conn = openReadOnlyConnection(tempCopy);
            }
            return readStepsIntoEnvelopes(conn);
        } catch (SQLException e) {
            LOG.warn("[GeminiHistoryReader] Failed to load conversation " + sessionId + ": "
                    + e.getMessage());
            return List.of();
        } finally {
            if (conn != null) {
                try {
                    conn.close();
                } catch (SQLException ignored) {
                }
            }
            if (tempCopy != null) {
                deleteTempCopy(tempCopy);
            }
        }
    }

    private List<JsonObject> readStepsIntoEnvelopes(Connection conn) throws SQLException {
        List<JsonObject> messages = new ArrayList<>();
        String sql = "SELECT idx, step_type, step_payload FROM steps ORDER BY idx";
        try (Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(sql)) {
            int counter = 0;
            Set<String> emittedToolUseIds = new HashSet<>();
            int undecodable = 0;
            int unknownTypes = 0;
            Set<String> unknownTypeValues = new TreeSet<>();
            while (rs.next()) {
                Object rawStepType = rs.getObject("step_type");
                StepRole role = roleOf(rawStepType);
                if (role == null) {
                    // Bounded count-then-summarize instead of a line per step —
                    // live histories carry hundreds of bookkeeping steps.
                    unknownTypes++;
                    if (rawStepType != null) {
                        unknownTypeValues.add(String.valueOf(rawStepType));
                    }
                    continue;
                }
                byte[] payload = rs.getBytes("step_payload");
                List<JsonObject> envelopes = decodeStep(role, payload, ++counter, emittedToolUseIds);
                if (envelopes.isEmpty()) {
                    undecodable++;
                }
                messages.addAll(envelopes);
            }
            if (unknownTypes > 0) {
                LOG.info("[GeminiHistoryReader] Skipped " + unknownTypes
                        + " step(s) with unknown step_type(s) " + unknownTypeValues
                        + " (CLI-injected/context bookkeeping — no content fabricated)");
            }
            if (undecodable > 0) {
                LOG.info("[GeminiHistoryReader] Skipped " + undecodable
                        + " step(s) with undecodable payloads (no content fabricated)");
            }
        }
        return messages;
    }

    private enum StepRole { USER, AGENT, TOOL }

    /**
     * The step_type column is an integer enum in live databases (14/15/132; 101 and
     * 17/23/90/98 among other values are CLI-injected/context bookkeeping, not
     * conversation turns — skipped deliberately, summarized in one log line per
     * load). Fixture databases and future CLI revisions may carry the role as text
     * instead.
     */
    private static StepRole roleOf(Object stepType) {
        if (stepType instanceof Number) {
            int value = ((Number) stepType).intValue();
            if (value == STEP_TYPE_USER) {
                return StepRole.USER;
            }
            if (value == STEP_TYPE_AGENT) {
                return StepRole.AGENT;
            }
            if (value == STEP_TYPE_TOOL) {
                return StepRole.TOOL;
            }
            return null;
        }
        if (stepType instanceof String) {
            switch (((String) stepType).trim().toLowerCase()) {
                case "user":
                    return StepRole.USER;
                case "agent":
                    return StepRole.AGENT;
                case "tool":
                    return StepRole.TOOL;
                default:
                    return null;
            }
        }
        return null;
    }

    /**
     * Decode one step into zero or more message envelopes. Only fields present in the
     * storage contract are read; a payload that yields nothing is skipped — never guessed.
     *
     * <p>Two wire shapes are honoured. The live shape nests content one level down:
     * user text under field 19, agent text plus tool calls under field 20, the executed
     * tool call under field 5 and its render/result under field 140. The flat shape
     * (fields 1–4 as strings) is the fixture contract kept for the decode pipeline.
     */
    private List<JsonObject> decodeStep(StepRole role, byte[] payload, int counter,
                                        Set<String> emittedToolUseIds) {
        List<JsonObject> out = new ArrayList<>();
        if (payload == null || payload.length == 0) {
            return out;
        }
        ProtoFields fields = ProtoFields.parse(payload);
        switch (role) {
            case USER: {
                String text = nestedText(fields, 19, 2);
                if (text == null) {
                    text = fields.string(1);
                }
                if (text != null && !text.isBlank()) {
                    out.add(buildUserTextMessage(text, "gemini-user-" + counter));
                }
                break;
            }
            case AGENT: {
                // Iterate EVERY repeated field-20 blob and collect text plus tool
                // calls across all of them — committing to one blob silently dropped
                // whatever sat in the others. (Live corpus 2026-09-04: 22382/22382
                // agent steps carry exactly one blob, so this is behaviour-preserving
                // there and lossless everywhere else.)
                StringBuilder text = null;
                List<byte[]> callBlobs = new ArrayList<>();
                for (byte[] blob : fields.messages(20)) {
                    ProtoFields nested = ProtoFields.parse(blob);
                    String candidate = nested.string(3);
                    if (candidate != null && !candidate.isBlank()) {
                        text = text == null ? new StringBuilder(candidate)
                                : text.append("\n\n").append(candidate);
                    }
                    callBlobs.addAll(nested.messages(7));
                }
                if (text == null) {
                    // Flat fixture shape: field 2 carries the agent response.
                    String flat = fields.string(2);
                    if (flat != null && !flat.isBlank()) {
                        text = new StringBuilder(flat);
                    }
                }
                if (text != null && text.length() > 0) {
                    out.add(buildAssistantTextMessage(text.toString(), "gemini-assistant-" + counter));
                }
                for (byte[] callBlob : callBlobs) {
                    appendToolUse(callBlob, counter, emittedToolUseIds, out);
                }
                break;
            }
            case TOOL: {
                byte[] callBlob = null;
                for (byte[] blob : fields.messages(5)) {
                    ProtoFields nested = ProtoFields.parse(blob);
                    byte[] candidate = nested.first(4);
                    if (candidate != null) {
                        callBlob = candidate;
                        break;
                    }
                }
                String toolSummary = null;
                String resultText = null;
                ProtoFields render = fields.firstMessage(140);
                if (render != null) {
                    for (byte[] entry : render.messages(1)) {
                        ProtoFields kv = ProtoFields.parse(entry);
                        String key = kv.string(1);
                        if ("toolSummary".equals(key)) {
                            toolSummary = kv.string(2);
                        }
                    }
                    resultText = render.string(2);
                }
                if (callBlob != null) {
                    String callId = appendToolUse(callBlob, counter, emittedToolUseIds, out);
                    // A call blob without a name emits no tool_use envelope — a
                    // tool_result without a call id would be an orphan block
                    // (Gson drops the null tool_use_id property).
                    if (callId != null) {
                        String contentText = resultText != null && !resultText.isBlank()
                                ? resultText
                                : toolSummary;
                        if (contentText != null && !contentText.isBlank()) {
                            out.add(buildToolResultMessage(callId,
                                    truncate(contentText, MAX_TOOL_RESULT_CHARS)));
                        }
                    }
                } else {
                    // Flat fixture shape: field 3 name + field 4 summary.
                    String name = fields.string(3);
                    String summary = fields.string(4);
                    if (name != null && !name.isBlank()) {
                        String callId = "gemini-tool-" + counter;
                        out.add(buildToolUseMessage(callId, name, new JsonObject()));
                        if (summary != null && !summary.isBlank()) {
                            out.add(buildToolResultMessage(callId, truncate(summary, MAX_TOOL_RESULT_CHARS)));
                        }
                    }
                }
                break;
            }
            default:
                break;
        }
        return out;
    }

    /**
     * Emit a tool_use envelope for the call unless its id was already emitted (the CLI
     * records the same call both on the agent step and on the executed tool step).
     *
     * @return the call id used for the envelope (synthesized when the payload has none)
     */
    private String appendToolUse(byte[] callBlob, int counter, Set<String> emittedToolUseIds,
                                 List<JsonObject> out) {
        ProtoFields call = ProtoFields.parse(callBlob);
        String callId = call.string(1);
        String name = call.string(2);
        String argsJson = call.string(3);
        if (name == null || name.isBlank()) {
            return null;
        }
        boolean synthesized = callId == null || callId.isBlank();
        String dedupeId = synthesized ? "gemini-tool-" + counter : callId.trim();
        if (!synthesized && emittedToolUseIds.contains(dedupeId)) {
            return dedupeId;
        }
        emittedToolUseIds.add(dedupeId);
        out.add(buildToolUseMessage(dedupeId, name.trim(), parseToolInput(argsJson)));
        return dedupeId;
    }

    private static JsonObject parseToolInput(String argsJson) {
        if (argsJson == null || argsJson.isBlank()) {
            return new JsonObject();
        }
        try {
            JsonElement parsed = JsonParser.parseString(argsJson);
            if (parsed.isJsonObject()) {
                return parsed.getAsJsonObject();
            }
            JsonObject wrap = new JsonObject();
            wrap.add("value", parsed);
            return wrap;
        } catch (Exception e) {
            JsonObject wrap = new JsonObject();
            wrap.addProperty("raw", argsJson);
            return wrap;
        }
    }

    // ── Delete ───────────────────────────────────────────────────────────────

    /**
     * Physical removal of the conversation database plus its -shm/-wal sidecars.
     * Sibling conversations and the CLI-owned caches are not touched.
     */
    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            LOG.warn("[GeminiHistoryReader] Refusing to delete session with invalid id: " + sessionId);
            return false;
        }
        Path conversationsDir = conversationsPath().normalize();
        Path db = conversationsDir.resolve(sessionId.trim() + ".db").normalize();
        if (!db.startsWith(conversationsDir)) {
            LOG.warn("[GeminiHistoryReader] Refusing out-of-bounds delete path: " + db);
            return false;
        }
        boolean deleted = Files.deleteIfExists(db);
        Files.deleteIfExists(conversationsDir.resolve(sessionId.trim() + ".db-shm"));
        Files.deleteIfExists(conversationsDir.resolve(sessionId.trim() + ".db-wal"));
        if (deleted) {
            LOG.info("[GeminiHistoryReader] Deleted conversation " + sessionId);
        }
        return deleted;
    }

    // ── Protobuf wire walking (minimal, read-only) ───────────────────────────

    /**
     * One pass over a protobuf message collecting varint and length-delimited fields
     * by number. Anything malformed stops the scan quietly — partial data is fine,
     * an exception is not.
     */
    private static final class ProtoFields {
        private final Map<Integer, Long> varints = new HashMap<>();
        private final Map<Integer, List<byte[]>> messages = new LinkedHashMap<>();

        static ProtoFields parse(byte[] data) {
            ProtoFields out = new ProtoFields();
            if (data == null) {
                return out;
            }
            int i = 0;
            try {
                while (i < data.length) {
                    long tag = readVarint(data, i);
                    i = varintEnd(data, i);
                    int field = (int) (tag >>> 3);
                    long wire = tag & 0x7;
                    if (field <= 0) {
                        break;
                    }
                    if (wire == 0) {
                        out.varints.put(field, readVarint(data, i));
                        i = varintEnd(data, i);
                    } else if (wire == 2) {
                        long len = readVarint(data, i);
                        i = varintEnd(data, i);
                        if (len < 0 || i + len > data.length) {
                            break;
                        }
                        out.messages.computeIfAbsent(field, k -> new ArrayList<>())
                                .add(java.util.Arrays.copyOfRange(data, i, (int) (i + len)));
                        i += (int) len;
                    } else if (wire == 1) {
                        i += 8;
                    } else if (wire == 5) {
                        i += 4;
                    } else {
                        break;
                    }
                    if (i > data.length) {
                        break;
                    }
                }
            } catch (IndexOutOfBoundsException e) {
                // Truncated or garbage payload — keep whatever parsed cleanly.
            }
            return out;
        }

        String string(int field) {
            List<byte[]> blobs = messages.get(field);
            if (blobs == null) {
                return null;
            }
            for (byte[] blob : blobs) {
                String text = utf8(blob);
                if (text != null && !text.isEmpty()) {
                    return text;
                }
            }
            return null;
        }

        byte[] first(int field) {
            List<byte[]> blobs = messages.get(field);
            return blobs != null && !blobs.isEmpty() ? blobs.get(0) : null;
        }

        ProtoFields firstMessage(int field) {
            byte[] blob = first(field);
            return blob != null ? parse(blob) : null;
        }

        List<byte[]> messages(int field) {
            List<byte[]> blobs = messages.get(field);
            return blobs != null ? blobs : List.of();
        }
    }

    private static long readVarint(byte[] data, int offset) {
        long result = 0;
        int shift = 0;
        int i = offset;
        while (true) {
            if (i >= data.length || shift > 63) {
                throw new ArrayIndexOutOfBoundsException("varint overruns payload");
            }
            byte b = data[i++];
            result |= (long) (b & 0x7F) << shift;
            if ((b & 0x80) == 0) {
                return result;
            }
            shift += 7;
        }
    }

    private static int varintEnd(byte[] data, int offset) {
        int i = offset;
        while (i < data.length && (data[i] & 0x80) != 0) {
            i++;
        }
        return i + 1;
    }

    private static String utf8(byte[] data) {
        try {
            return StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(data)).toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    /**
     * First nested blob of {@code outer} whose sub-field {@code inner} carries a
     * non-blank string. Live payloads repeat the outer field number, so the blobs
     * are iterated until the text one is found — the first occurrence carries no
     * special meaning.
     */
    private static String nestedText(ProtoFields fields, int outer, int inner) {
        for (byte[] blob : fields.messages(outer)) {
            ProtoFields nested = ProtoFields.parse(blob);
            String candidate = nested.string(inner);
            if (candidate != null && !candidate.isBlank()) {
                return candidate;
            }
        }
        return null;
    }

    // ── Envelope builders (shared Claude-compatible load format) ─────────────

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

    private static JsonObject buildToolResultMessage(String toolUseId, String contentText) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_result");
        block.addProperty("tool_use_id", toolUseId);
        block.addProperty("is_error", false);
        block.addProperty("content", contentText != null ? contentText : "");
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private Path conversationsPath() {
        return cliHome.resolve("conversations");
    }

    private Path metadataCachePath() {
        return cliHome.resolve("cache").resolve("conversation_metadata.json");
    }

    private Path conversationDbPath(String sessionId) {
        return conversationsPath().resolve(sessionId + ".db");
    }

    private static boolean isSafeSessionId(String sessionId) {
        if (sessionId == null || sessionId.trim().isEmpty()) {
            return false;
        }
        return sessionId.trim().matches(SAFE_ID_PATTERN);
    }

    private Connection openReadOnlyConnection(Path database) throws SQLException {
        ensureSqliteDriver();
        String url = "jdbc:sqlite:file:" + database.toAbsolutePath() + "?mode=ro";
        Connection conn = DriverManager.getConnection(url);
        try (Statement st = conn.createStatement()) {
            st.execute("PRAGMA query_only = ON");
        } catch (SQLException ignored) {
            // Older SQLite builds may not support query_only; mode=ro is enough.
        }
        return conn;
    }

    /**
     * Copy a conversation database and its -shm/-wal sidecars to a temporary directory
     * so a live writer cannot defeat the read-only open. Package-private for the
     * temp-hygiene test.
     *
     * <p>Hygiene: a successful copy is removed with its directory by the caller's
     * finally ({@link #deleteTempCopy}); a failed copy removes the directory it
     * created here — nothing leaks.
     *
     * @return path of the copied database, or null when nothing was copied
     */
    Path copyWithSidecarsToTemp(Path db) throws IOException {
        Path tempDir;
        try {
            tempDir = Files.createTempDirectory("gemini-history-");
        } catch (IOException e) {
            LOG.debug("[GeminiHistoryReader] Temp dir creation failed: " + e.getMessage());
            return null;
        }
        tempDir.toFile().deleteOnExit();
        try {
            Path target = tempDir.resolve(db.getFileName().toString());
            Files.copy(db, target, StandardCopyOption.REPLACE_EXISTING);
            for (String sidecar : new String[]{".db-shm", ".db-wal"}) {
                Path source = db.resolveSibling(db.getFileName() + sidecar);
                if (Files.isRegularFile(source)) {
                    Files.copy(source, tempDir.resolve(source.getFileName().toString()),
                            StandardCopyOption.REPLACE_EXISTING);
                }
            }
            target.toFile().deleteOnExit();
            return target;
        } catch (IOException e) {
            LOG.debug("[GeminiHistoryReader] Temp copy failed: " + e.getMessage());
            deleteTempDir(tempDir);
            return null;
        }
    }

    /** Best-effort removal of a temp directory and whatever a failed copy left in it. */
    private static void deleteTempDir(Path dir) {
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(dir)) {
            for (Path leftover : stream) {
                Files.deleteIfExists(leftover);
            }
        } catch (IOException ignored) {
        }
        try {
            Files.deleteIfExists(dir);
        } catch (IOException ignored) {
            dir.toFile().deleteOnExit();
        }
    }

    private static void deleteTempCopy(Path db) {
        Path parent = db.getParent();
        try {
            Files.deleteIfExists(db);
            if (parent != null && Files.isDirectory(parent)) {
                try (DirectoryStream<Path> stream = Files.newDirectoryStream(parent)) {
                    for (Path leftover : stream) {
                        Files.deleteIfExists(leftover);
                        leftover.toFile().deleteOnExit();
                    }
                }
                Files.deleteIfExists(parent);
            }
        } catch (IOException ignored) {
            db.toFile().deleteOnExit();
        }
    }

    private static void ensureSqliteDriver() throws SQLException {
        try {
            Class.forName(SQLITE_JDBC);
        } catch (ClassNotFoundException e) {
            throw new SQLException("sqlite-jdbc driver not on classpath", e);
        }
    }

    private static String stringField(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return null;
        }
        try {
            return obj.get(field).getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    private static int intField(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()
                || !obj.get(field).isJsonPrimitive()) {
            return 0;
        }
        try {
            return obj.get(field).getAsInt();
        } catch (Exception e) {
            return 0;
        }
    }

    private static long parseTimestamp(String raw) {
        if (raw == null || raw.isBlank()) {
            return 0L;
        }
        try {
            return Instant.parse(raw.trim()).toEpochMilli();
        } catch (Exception e) {
            return 0L;
        }
    }

    /** Title priority: CLI Title → first-prompt Preview → session id. */
    static String resolveSessionTitle(String title, String preview, String sessionId) {
        if (title != null && !title.trim().isEmpty()) {
            return truncate(title.trim(), MAX_TITLE_CHARS);
        }
        if (preview != null && !preview.trim().isEmpty()) {
            return truncate(preview.trim(), MAX_TITLE_CHARS);
        }
        return sessionId != null ? sessionId : "";
    }

    private static List<String> decodeWorkspaceUris(JsonObject summary) {
        if (!summary.has("WorkspaceURIs") || !summary.get("WorkspaceURIs").isJsonArray()) {
            return null;
        }
        List<String> out = new ArrayList<>();
        for (JsonElement element : summary.getAsJsonArray("WorkspaceURIs")) {
            if (!element.isJsonPrimitive()) {
                continue;
            }
            String path = decodeFileUri(element.getAsString());
            if (path != null && !path.isEmpty()) {
                out.add(path);
            }
        }
        return out;
    }

    private static String decodeFileUri(String uri) {
        if (uri == null || uri.isBlank()) {
            return null;
        }
        String trimmed = uri.trim();
        try {
            String path = new URI(trimmed).getPath();
            if (path != null && !path.isEmpty()) {
                return path;
            }
        } catch (Exception ignored) {
            // Not a parseable URI — fall through to manual decoding.
        }
        if (trimmed.startsWith("file://")) {
            String raw = trimmed.substring("file://".length());
            try {
                return URLDecoder.decode(raw, StandardCharsets.UTF_8);
            } catch (Exception e) {
                return raw;
            }
        }
        return trimmed.startsWith("/") ? trimmed : null;
    }

    static String normalizePath(String path) {
        return HistoryPathMatcher.normalize(path);
    }

    static boolean pathsMatch(String sessionCwd, String projectPath) {
        return HistoryPathMatcher.matches(sessionCwd, projectPath);
    }

    private static long fileMtime(Path path) {
        try {
            if (path != null && Files.isRegularFile(path)) {
                return Files.getLastModifiedTime(path).toMillis();
            }
        } catch (IOException ignored) {
        }
        return 0L;
    }

    private static String truncate(String value, int maxChars) {
        if (value == null) {
            return "";
        }
        if (value.length() <= maxChars) {
            return value;
        }
        return value.substring(0, maxChars) + "…";
    }
}
