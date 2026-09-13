package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.HistoryPathMatcher;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Reads OpenCode CLI session history.
 *
 * <p>OpenCode 1.x stores sessions in SQLite at
 * {@code ~/.local/share/opencode/opencode.db} (or {@code $XDG_DATA_HOME/opencode/opencode.db}).
 * Older builds used a JSON tree under {@code .../storage/}:
 * <pre>
 *   storage/session/&lt;projectHash&gt;/ses_xxx.json
 *   storage/message/ses_xxx/msg_yyy.json
 *   storage/part/msg_yyy/prt_zzz.json
 * </pre>
 *
 * <p>This reader prefers the SQLite database when present and falls back to the
 * legacy JSON layout so both eras remain visible. Sessions are filtered by the
 * {@code directory} field (normalized, case-insensitive) so Windows backslash
 * paths match Unix-style paths written by the CLI.
 */
public class OpenCodeHistoryReader {

    private static final Logger LOG = Logger.getInstance(OpenCodeHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;
    private static final String SQLITE_JDBC = "org.sqlite.JDBC";

    private final Gson gson;
    private final Path storageRoot;
    private final Path databasePath;

    public OpenCodeHistoryReader() {
        this(defaultStorageRoot(), defaultDatabasePath(defaultStorageRoot()), new Gson());
    }

    OpenCodeHistoryReader(Path storageRoot, Gson gson) {
        this(storageRoot, defaultDatabasePath(storageRoot), gson);
    }

    /**
     * Test constructor that can point storage and database at independent fixtures.
     */
    OpenCodeHistoryReader(Path storageRoot, Path databasePath, Gson gson) {
        this.storageRoot = storageRoot;
        this.databasePath = databasePath;
        this.gson = gson;
    }

    private static Path defaultStorageRoot() {
        return defaultOpenCodeHome().resolve("storage");
    }

    private static Path defaultDatabasePath(Path storageRoot) {
        Path parent = storageRoot != null ? storageRoot.getParent() : null;
        if (parent != null) {
            return parent.resolve("opencode.db");
        }
        return defaultOpenCodeHome().resolve("opencode.db");
    }

    private static Path defaultOpenCodeHome() {
        String home = NodeDetector.resolveHomeForFileOps();
        String xdg = System.getenv("XDG_DATA_HOME");
        if (xdg != null && !xdg.trim().isEmpty()) {
            return Paths.get(xdg.trim(), "opencode");
        }
        // OpenCode docs: macOS/Linux ~/.local/share/opencode ; Windows %USERPROFILE%\.local\share\opencode
        return Paths.get(home, ".local", "share", "opencode");
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "opencode";
        /** Restored model id (e.g. opencode/deepseek-v4-flash-free). Optional. */
        public String model;
        /** OpenCode agent name when known. Optional. */
        public String agent;
    }

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("sessionCount", sessions.size());
            result.put("provider", "opencode");
            int totalMessages = sessions.stream().mapToInt(s -> s.messageCount).sum();
            result.put("total", totalMessages);
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[OpenCodeHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read OpenCode sessions: " + e.getMessage());
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
            if (session.cwd != null && pathsMatch(session.cwd, projectPath)) {
                filtered.add(session);
            }
        }
        filtered.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return filtered;
    }

    public List<SessionInfo> listAllSessions() throws IOException {
        // Prefer SQLite (OpenCode 1.x). Merge legacy JSON so unmigrated installs still work.
        Map<String, SessionInfo> byId = new LinkedHashMap<>();
        for (SessionInfo session : listSessionsFromDatabase()) {
            byId.put(session.sessionId, session);
        }
        for (SessionInfo session : listSessionsFromJsonStorage()) {
            byId.putIfAbsent(session.sessionId, session);
        }
        List<SessionInfo> sessions = new ArrayList<>(byId.values());
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    // ── SQLite (OpenCode 1.x) ───────────────────────────────────────────────

    private List<SessionInfo> listSessionsFromDatabase() {
        List<SessionInfo> sessions = new ArrayList<>();
        if (databasePath == null || !Files.isRegularFile(databasePath)) {
            return sessions;
        }
        try (Connection conn = openReadOnlyConnection()) {
            if (conn == null || !tableExists(conn, "session")) {
                return sessions;
            }
            // Skip child/subagent sessions (parent_id set) so the main list stays clean.
            String sql = """
                    SELECT s.id, s.directory, s.title, s.time_created, s.time_updated,
                           s.model, s.agent, s.parent_id,
                           (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
                    FROM session s
                    WHERE s.parent_id IS NULL OR TRIM(s.parent_id) = ''
                    """;
            try (Statement st = conn.createStatement();
                 ResultSet rs = st.executeQuery(sql)) {
                while (rs.next()) {
                    String id = rs.getString("id");
                    if (id == null || id.isBlank() || !isSafeSessionId(id)) {
                        continue;
                    }
                    SessionInfo info = new SessionInfo();
                    info.sessionId = id.trim();
                    info.cwd = rs.getString("directory");
                    info.title = rs.getString("title");
                    info.firstTimestamp = rs.getLong("time_created");
                    info.lastTimestamp = rs.getLong("time_updated");
                    info.messageCount = rs.getInt("message_count");
                    info.provider = "opencode";
                    info.model = normalizeOpenCodeModel(rs.getString("model"));
                    info.agent = blankToNull(rs.getString("agent"));
                    if (info.model == null) {
                        info.model = inferModelFromLastAssistant(conn, info.sessionId);
                    }
                    try {
                        info.fileSize = Files.size(databasePath);
                    } catch (IOException ignored) {
                        info.fileSize = 0;
                    }
                    if (info.lastTimestamp <= 0) {
                        info.lastTimestamp = info.firstTimestamp;
                    }
                    if (info.firstTimestamp <= 0) {
                        info.firstTimestamp = info.lastTimestamp;
                    }
                    if (info.title == null || info.title.isBlank()) {
                        String firstUser = firstUserTitleFromDb(conn, info.sessionId);
                        info.title = firstUser != null
                                ? truncate(firstUser, MAX_TITLE_CHARS)
                                : "OpenCode session " + shortId(info.sessionId);
                    }
                    sessions.add(info);
                }
            }
        } catch (Exception e) {
            LOG.warn("[OpenCodeHistoryReader] SQLite list failed (" + databasePath + "): " + e.getMessage());
        }
        return sessions;
    }

    private String inferModelFromLastAssistant(Connection conn, String sessionId) {
        String sql = """
                SELECT data FROM message
                WHERE session_id = ?
                ORDER BY time_created DESC
                LIMIT 40
                """;
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, sessionId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    JsonObject msg = parseObject(rs.getString("data"));
                    if (msg == null || !"assistant".equals(text(msg, "role"))) {
                        continue;
                    }
                    String model = normalizeOpenCodeModelFromMessage(msg);
                    if (model != null) {
                        return model;
                    }
                }
            }
        } catch (SQLException ignored) {
        }
        return null;
    }

    /**
     * OpenCode stores model as JSON {@code {"id":"…","providerID":"…"}} or a plain string.
     * UI / CLI expect {@code provider/model}.
     */
    static String normalizeOpenCodeModel(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.startsWith("{")) {
            JsonObject obj = parseObject(trimmed);
            if (obj == null) {
                return null;
            }
            return normalizeOpenCodeModelFromMessage(obj);
        }
        return trimmed;
    }

    static String normalizeOpenCodeModelFromMessage(JsonObject msg) {
        if (msg == null) {
            return null;
        }
        if (msg.has("model") && msg.get("model").isJsonObject()) {
            JsonObject nested = msg.getAsJsonObject("model");
            String provider = text(nested, "providerID");
            String modelId = text(nested, "modelID");
            if (modelId == null || modelId.isBlank()) {
                modelId = text(nested, "id");
            }
            if (modelId != null && !modelId.isBlank()) {
                if (provider != null && !provider.isBlank() && !modelId.contains("/")) {
                    return provider + "/" + modelId;
                }
                return modelId;
            }
        }
        String provider = text(msg, "providerID");
        String modelId = text(msg, "modelID");
        if (modelId == null || modelId.isBlank()) {
            modelId = text(msg, "id");
        }
        if (modelId == null || modelId.isBlank()) {
            return null;
        }
        if (provider != null && !provider.isBlank() && !modelId.contains("/")) {
            return provider + "/" + modelId;
        }
        return modelId;
    }

    private static String blankToNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        return value.trim();
    }

    private String firstUserTitleFromDb(Connection conn, String sessionId) {
        String sql = """
                SELECT m.id, m.data
                FROM message m
                WHERE m.session_id = ?
                ORDER BY m.time_created ASC
                """;
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, sessionId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String data = rs.getString("data");
                    JsonObject msg = parseObject(data);
                    if (msg == null || !"user".equals(text(msg, "role"))) {
                        continue;
                    }
                    if (msg.has("summary") && msg.get("summary").isJsonObject()) {
                        String t = text(msg.getAsJsonObject("summary"), "title");
                        if (t != null && !t.isBlank()) {
                            return t;
                        }
                    }
                    String messageId = rs.getString("id");
                    String fromParts = extractMessageTextFromParts(loadPartsFromDb(conn, messageId));
                    if (fromParts != null && !fromParts.isBlank()) {
                        return fromParts;
                    }
                }
            }
        } catch (SQLException e) {
            return null;
        }
        return null;
    }

    private List<JsonObject> getSessionMessagesFromDatabase(String sessionId) {
        List<JsonObject> out = new ArrayList<>();
        if (databasePath == null || !Files.isRegularFile(databasePath) || !isSafeSessionId(sessionId)) {
            return out;
        }
        try (Connection conn = openReadOnlyConnection()) {
            if (conn == null || !tableExists(conn, "message")) {
                return out;
            }
            String sql = """
                    SELECT id, data, time_created
                    FROM message
                    WHERE session_id = ?
                    ORDER BY time_created ASC, id ASC
                    """;
            try (PreparedStatement ps = conn.prepareStatement(sql)) {
                ps.setString(1, sessionId.trim());
                try (ResultSet rs = ps.executeQuery()) {
                    int counter = 0;
                    while (rs.next()) {
                        String messageId = rs.getString("id");
                        JsonObject msg = parseObject(rs.getString("data"));
                        if (msg == null) {
                            continue;
                        }
                        String role = text(msg, "role");
                        List<JsonObject> parts = loadPartsFromDb(conn, messageId);
                        if ("user".equals(role)) {
                            String body = extractMessageTextFromParts(parts);
                            if (body == null || body.isBlank()) {
                                if (msg.has("summary") && msg.get("summary").isJsonObject()) {
                                    body = text(msg.getAsJsonObject("summary"), "title");
                                }
                            }
                            if (body == null || body.isBlank()) {
                                continue;
                            }
                            counter++;
                            out.add(buildUserTextMessage(body, messageId != null ? messageId : "oc-user-" + counter));
                        } else if ("assistant".equals(role)) {
                            List<JsonObject> converted = convertAssistantParts(
                                    messageId != null ? messageId : "asst",
                                    counter,
                                    parts
                            );
                            counter += converted.size();
                            out.addAll(converted);
                        }
                    }
                }
            }
        } catch (Exception e) {
            LOG.warn("[OpenCodeHistoryReader] SQLite messages failed for " + sessionId + ": " + e.getMessage());
        }
        return out;
    }

    private List<JsonObject> loadPartsFromDb(Connection conn, String messageId) throws SQLException {
        List<JsonObject> parts = new ArrayList<>();
        if (messageId == null || messageId.isBlank() || !tableExists(conn, "part")) {
            return parts;
        }
        String sql = """
                SELECT data
                FROM part
                WHERE message_id = ?
                ORDER BY time_created ASC, id ASC
                """;
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, messageId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    JsonObject part = parseObject(rs.getString("data"));
                    if (part != null) {
                        parts.add(part);
                    }
                }
            }
        }
        return parts;
    }

    private boolean deleteSessionFromDatabase(String sessionId) {
        if (databasePath == null || !Files.isRegularFile(databasePath) || !isSafeSessionId(sessionId)) {
            return false;
        }
        try (Connection conn = openWritableConnection()) {
            if (conn == null || !tableExists(conn, "session")) {
                return false;
            }
            // FK cascades remove message/part rows when present.
            try (PreparedStatement ps = conn.prepareStatement("DELETE FROM session WHERE id = ?")) {
                ps.setString(1, sessionId.trim());
                return ps.executeUpdate() > 0;
            }
        } catch (Exception e) {
            LOG.warn("[OpenCodeHistoryReader] SQLite delete failed for " + sessionId + ": " + e.getMessage());
            return false;
        }
    }

    private Connection openReadOnlyConnection() throws SQLException {
        ensureSqliteDriver();
        String url = "jdbc:sqlite:file:" + databasePath.toAbsolutePath() + "?mode=ro";
        Connection conn = DriverManager.getConnection(url);
        try (Statement st = conn.createStatement()) {
            st.execute("PRAGMA query_only = ON");
        } catch (SQLException ignored) {
            // Older SQLite builds may not support query_only; mode=ro is enough.
        }
        return conn;
    }

    private Connection openWritableConnection() throws SQLException {
        ensureSqliteDriver();
        String url = "jdbc:sqlite:" + databasePath.toAbsolutePath();
        return DriverManager.getConnection(url);
    }

    private static void ensureSqliteDriver() throws SQLException {
        try {
            Class.forName(SQLITE_JDBC);
        } catch (ClassNotFoundException e) {
            throw new SQLException("sqlite-jdbc driver not on classpath", e);
        }
    }

    private static boolean tableExists(Connection conn, String table) throws SQLException {
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")) {
            ps.setString(1, table);
            try (ResultSet rs = ps.executeQuery()) {
                return rs.next();
            }
        }
    }

    private static JsonObject parseObject(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            JsonElement el = JsonParser.parseString(raw);
            return el != null && el.isJsonObject() ? el.getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    // ── Legacy JSON storage ─────────────────────────────────────────────────

    private List<SessionInfo> listSessionsFromJsonStorage() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();
        Path sessionRoot = storageRoot.resolve("session");
        if (!Files.isDirectory(sessionRoot)) {
            return sessions;
        }
        try (Stream<Path> files = Files.walk(sessionRoot, 2)) {
            files.filter(p -> Files.isRegularFile(p) && p.getFileName().toString().endsWith(".json"))
                    .forEach(file -> {
                        SessionInfo info = readSessionSummary(file);
                        if (info != null) {
                            sessions.add(info);
                        }
                    });
        }
        return sessions;
    }

    private SessionInfo readSessionSummary(Path file) {
        try {
            String raw = Files.readString(file, StandardCharsets.UTF_8);
            JsonObject obj = JsonParser.parseString(raw).getAsJsonObject();
            String id = text(obj, "id");
            if (id == null || id.isBlank() || !isSafeSessionId(id)) {
                return null;
            }
            // Skip child/subagent sessions in the main list.
            String parentId = text(obj, "parentID");
            if (parentId == null || parentId.isBlank()) {
                parentId = text(obj, "parent_id");
            }
            if (parentId != null && !parentId.isBlank()) {
                return null;
            }

            SessionInfo info = new SessionInfo();
            info.sessionId = id;
            info.cwd = text(obj, "directory");
            info.provider = "opencode";
            info.title = text(obj, "title");
            info.agent = blankToNull(text(obj, "agent"));
            if (obj.has("model") && !obj.get("model").isJsonNull()) {
                if (obj.get("model").isJsonPrimitive()) {
                    info.model = normalizeOpenCodeModel(obj.get("model").getAsString());
                } else if (obj.get("model").isJsonObject()) {
                    info.model = normalizeOpenCodeModelFromMessage(obj.getAsJsonObject("model"));
                }
            }
            info.fileSize = Files.size(file);

            JsonObject time = obj.has("time") && obj.get("time").isJsonObject()
                    ? obj.getAsJsonObject("time")
                    : null;
            if (time != null) {
                info.firstTimestamp = longField(time, "created");
                info.lastTimestamp = longField(time, "updated");
            }
            if (info.lastTimestamp <= 0) {
                info.lastTimestamp = fileMtime(file);
            }
            if (info.firstTimestamp <= 0) {
                info.firstTimestamp = info.lastTimestamp;
            }

            Path msgDir = storageRoot.resolve("message").resolve(id);
            info.messageCount = countMessages(msgDir);
            if (info.title == null || info.title.isBlank()) {
                String firstUser = firstUserTitle(msgDir);
                info.title = firstUser != null
                        ? truncate(firstUser, MAX_TITLE_CHARS)
                        : "OpenCode session " + shortId(id);
            }
            return info;
        } catch (Exception e) {
            LOG.debug("[OpenCodeHistoryReader] Failed to read " + file + ": " + e.getMessage());
            return null;
        }
    }

    private int countMessages(Path msgDir) {
        if (!Files.isDirectory(msgDir)) {
            return 0;
        }
        int count = 0;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(msgDir, "*.json")) {
            for (Path ignored : stream) {
                count++;
            }
        } catch (IOException e) {
            return 0;
        }
        return count;
    }

    private String firstUserTitle(Path msgDir) {
        if (!Files.isDirectory(msgDir)) {
            return null;
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(msgDir, "*.json")) {
            List<Path> files = new ArrayList<>();
            for (Path p : stream) {
                files.add(p);
            }
            files.sort(Comparator.comparing(Path::getFileName));
            for (Path file : files) {
                try {
                    JsonObject msg = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8))
                            .getAsJsonObject();
                    if (!"user".equals(text(msg, "role"))) {
                        continue;
                    }
                    if (msg.has("summary") && msg.get("summary").isJsonObject()) {
                        String t = text(msg.getAsJsonObject("summary"), "title");
                        if (t != null && !t.isBlank()) {
                            return t;
                        }
                    }
                    String fromParts = extractMessageText(text(msg, "id"));
                    if (fromParts != null && !fromParts.isBlank()) {
                        return fromParts;
                    }
                } catch (Exception ignored) {
                }
            }
        } catch (IOException ignored) {
        }
        return null;
    }

    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            return List.of();
        }
        // Prefer SQLite rows (OpenCode 1.x). Fall back to legacy JSON tree.
        List<JsonObject> fromDb = getSessionMessagesFromDatabase(sessionId);
        if (!fromDb.isEmpty()) {
            return fromDb;
        }
        return getSessionMessagesFromJsonStorage(sessionId);
    }

    private List<JsonObject> getSessionMessagesFromJsonStorage(String sessionId) throws IOException {
        Path msgDir = storageRoot.resolve("message").resolve(sessionId.trim());
        if (!Files.isDirectory(msgDir)) {
            LOG.warn("[OpenCodeHistoryReader] Message dir missing for " + sessionId);
            return List.of();
        }

        List<Path> files = new ArrayList<>();
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(msgDir, "*.json")) {
            for (Path p : stream) {
                files.add(p);
            }
        }
        files.sort(Comparator
                .comparingLong(this::messageCreated)
                .thenComparing(p -> p.getFileName().toString()));

        List<JsonObject> out = new ArrayList<>();
        int counter = 0;
        for (Path file : files) {
            JsonObject msg;
            try {
                msg = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            } catch (Exception e) {
                continue;
            }
            String role = text(msg, "role");
            String messageId = text(msg, "id");
            if ("user".equals(role)) {
                String body = extractMessageText(messageId);
                if (body == null || body.isBlank()) {
                    if (msg.has("summary") && msg.get("summary").isJsonObject()) {
                        body = text(msg.getAsJsonObject("summary"), "title");
                    }
                }
                if (body == null || body.isBlank()) {
                    continue;
                }
                counter++;
                out.add(buildUserTextMessage(body, messageId != null ? messageId : "oc-user-" + counter));
            } else if ("assistant".equals(role)) {
                List<JsonObject> converted = convertAssistantParts(messageId, counter, loadPartsFromJson(messageId));
                counter += converted.size();
                out.addAll(converted);
            }
        }
        return out;
    }

    private long messageCreated(Path file) {
        try {
            JsonObject msg = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
            if (msg.has("time") && msg.get("time").isJsonObject()) {
                long created = longField(msg.getAsJsonObject("time"), "created");
                if (created > 0) {
                    return created;
                }
            }
        } catch (Exception ignored) {
        }
        return fileMtime(file);
    }

    private String extractMessageText(String messageId) {
        return extractMessageTextFromParts(loadPartsFromJson(messageId));
    }

    private String extractMessageTextFromParts(List<JsonObject> parts) {
        if (parts == null || parts.isEmpty()) {
            return null;
        }
        StringBuilder sb = new StringBuilder();
        for (JsonObject part : parts) {
            if ("text".equals(text(part, "type"))) {
                String t = text(part, "text");
                if (t != null && !t.isEmpty()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(t);
                }
            }
        }
        return sb.length() > 0 ? sb.toString() : null;
    }

    private List<JsonObject> loadPartsFromJson(String messageId) {
        List<JsonObject> parts = new ArrayList<>();
        if (messageId == null || messageId.isBlank()) {
            return parts;
        }
        Path partDir = storageRoot.resolve("part").resolve(messageId);
        if (!Files.isDirectory(partDir)) {
            return parts;
        }
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(partDir, "*.json")) {
            List<Path> files = new ArrayList<>();
            for (Path p : stream) {
                files.add(p);
            }
            files.sort(Comparator.comparing(p -> p.getFileName().toString()));
            for (Path partFile : files) {
                try {
                    JsonObject part = JsonParser.parseString(Files.readString(partFile, StandardCharsets.UTF_8))
                            .getAsJsonObject();
                    parts.add(part);
                } catch (Exception ignored) {
                }
            }
        } catch (IOException ignored) {
        }
        return parts;
    }

    private List<JsonObject> convertAssistantParts(String messageId, int counterBase, List<JsonObject> parts) {
        List<JsonObject> out = new ArrayList<>();
        if (parts == null || parts.isEmpty()) {
            return out;
        }
        String safeMessageId = messageId != null && !messageId.isBlank() ? messageId : "asst";

        int n = counterBase;
        StringBuilder textBuf = new StringBuilder();
        StringBuilder thinkBuf = new StringBuilder();
        for (JsonObject part : parts) {
            String type = text(part, "type");
            if ("text".equals(type)) {
                String t = text(part, "text");
                if (t != null && !t.isEmpty()) {
                    if (textBuf.length() > 0) {
                        textBuf.append('\n');
                    }
                    textBuf.append(t);
                }
            } else if ("reasoning".equals(type)) {
                String t = text(part, "text");
                if (t != null && !t.isEmpty()) {
                    if (thinkBuf.length() > 0) {
                        thinkBuf.append('\n');
                    }
                    thinkBuf.append(t);
                }
            } else if ("tool".equals(type)) {
                if (thinkBuf.length() > 0) {
                    n++;
                    out.add(buildAssistantThinkingMessage(thinkBuf.toString(), safeMessageId + "-think-" + n));
                    thinkBuf.setLength(0);
                }
                if (textBuf.length() > 0) {
                    n++;
                    out.add(buildAssistantTextMessage(textBuf.toString(), safeMessageId + "-text-" + n));
                    textBuf.setLength(0);
                }
                String callId = text(part, "callID");
                if (callId == null || callId.isBlank()) {
                    callId = text(part, "id");
                }
                if (callId == null || callId.isBlank()) {
                    callId = "oc-tool-" + (++n);
                }
                String toolName = text(part, "tool");
                if (toolName == null || toolName.isBlank()) {
                    toolName = "tool";
                }
                JsonObject input = new JsonObject();
                String resultText = "";
                boolean isError = false;
                if (part.has("state") && part.get("state").isJsonObject()) {
                    JsonObject state = part.getAsJsonObject("state");
                    if (state.has("input") && state.get("input").isJsonObject()) {
                        input = state.getAsJsonObject("input");
                    }
                    String status = text(state, "status");
                    isError = "error".equals(status) || "failed".equals(status);
                    if (state.has("output") && !state.get("output").isJsonNull()) {
                        resultText = stringify(state.get("output"));
                    } else if (state.has("error") && !state.get("error").isJsonNull()) {
                        resultText = stringify(state.get("error"));
                        isError = true;
                    }
                }
                out.add(buildToolUseMessage(callId, toolName, input));
                if (resultText != null && !resultText.isBlank()) {
                    out.add(buildToolResultMessage(callId, truncate(resultText, MAX_TOOL_RESULT_CHARS), isError));
                }
            }
        }
        if (thinkBuf.length() > 0) {
            n++;
            out.add(buildAssistantThinkingMessage(thinkBuf.toString(), safeMessageId + "-think-" + n));
        }
        if (textBuf.length() > 0) {
            n++;
            out.add(buildAssistantTextMessage(textBuf.toString(), safeMessageId + "-text-" + n));
        }
        return out;
    }

    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            return false;
        }
        String id = sessionId.trim();
        boolean deleted = deleteSessionFromDatabase(id);
        deleted = deleteSessionFromJsonStorage(id) || deleted;
        return deleted;
    }

    private boolean deleteSessionFromJsonStorage(String id) throws IOException {
        boolean deleted = false;
        Path sessionRoot = storageRoot.resolve("session");
        if (Files.isDirectory(sessionRoot)) {
            try (Stream<Path> files = Files.walk(sessionRoot, 2)) {
                List<Path> matches = files
                        .filter(p -> Files.isRegularFile(p) && p.getFileName().toString().equals(id + ".json"))
                        .toList();
                for (Path match : matches) {
                    Files.deleteIfExists(match);
                    deleted = true;
                }
            }
        }
        Path msgDir = storageRoot.resolve("message").resolve(id);
        if (Files.isDirectory(msgDir)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(msgDir, "*.json")) {
                for (Path msgFile : stream) {
                    try {
                        JsonObject msg = JsonParser.parseString(Files.readString(msgFile, StandardCharsets.UTF_8))
                                .getAsJsonObject();
                        String messageId = text(msg, "id");
                        if (messageId != null && isSafeSessionId(messageId)) {
                            deleteRecursively(storageRoot.resolve("part").resolve(messageId));
                        }
                    } catch (Exception ignored) {
                    }
                    Files.deleteIfExists(msgFile);
                    deleted = true;
                }
            }
            try {
                Files.deleteIfExists(msgDir);
            } catch (Exception ignored) {
            }
        }
        return deleted;
    }

    private static void deleteRecursively(Path root) throws IOException {
        if (root == null || !Files.exists(root)) {
            return;
        }
        if (Files.isDirectory(root)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(root)) {
                for (Path child : stream) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(root);
    }

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
        String id = sessionId.trim();
        if (id.contains("/") || id.contains("\\") || id.contains("..")) {
            return false;
        }
        return id.matches("^[A-Za-z0-9._-]+$");
    }

    private static String text(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return null;
        }
        try {
            return obj.get(field).getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    private static long longField(JsonObject obj, String field) {
        if (obj == null || !obj.has(field) || obj.get(field).isJsonNull()) {
            return 0L;
        }
        try {
            return obj.get(field).getAsLong();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static long fileMtime(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private static String stringify(JsonElement el) {
        if (el == null || el.isJsonNull()) {
            return "";
        }
        if (el.isJsonPrimitive()) {
            return el.getAsString();
        }
        return el.toString();
    }

    private static String truncate(String text, int max) {
        if (text == null) {
            return "";
        }
        String t = text.trim().replaceAll("\\s+", " ");
        if (t.length() <= max) {
            return t;
        }
        return t.substring(0, max - 1) + "…";
    }

    private static String shortId(String id) {
        if (id == null) {
            return "";
        }
        return id.length() <= 10 ? id : id.substring(0, 10);
    }
}
