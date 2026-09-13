package com.github.claudecodegui.provider.omp;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.provider.common.HistoryPathMatcher;
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
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads OMP CLI session history from {@code ~/.omp/agent/sessions/}.
 *
 * <p>Layout (cross-platform, including Windows):
 * <pre>
 *   ~/.omp/agent/sessions/&lt;encoded-cwd&gt;/&lt;timestamp&gt;_&lt;sessionId&gt;.jsonl
 * </pre>
 * OMP session files may begin with a {@code type=title} line; the {@code type=session}
 * header with {@code id} + {@code cwd} follows (not necessarily on line 1).
 * Message lines use {@code type=message} with roles {@code user}/{@code assistant}/{@code toolResult}.
 *
 * <p>Path matching is case-insensitive and normalizes {@code \} → {@code /} so Windows
 * project paths match sessions written by the OMP CLI.
 */
public class OmpHistoryReader {

    private static final Logger LOG = Logger.getInstance(OmpHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;
    /** OMP files lead with a {@code type=title} line; scan a bounded prefix for the session header. */
    private static final int MAX_HEADER_SCAN_LINES = 20;

    private final Gson gson;
    private final Path sessionsRoot;

    public OmpHistoryReader() {
        this(defaultSessionsRoot(), new Gson());
    }

    OmpHistoryReader(Path sessionsRoot, Gson gson) {
        this.sessionsRoot = sessionsRoot;
        this.gson = gson;
    }

    private static Path defaultSessionsRoot() {
        String home = NodeDetector.resolveHomeForFileOps();
        // omp honors the PI-prefixed env overrides (fork lineage).
        String override = System.getenv("PI_CODING_AGENT_SESSION_DIR");
        if (override != null && !override.trim().isEmpty()) {
            return Paths.get(override.trim());
        }
        String agentDir = System.getenv("PI_CODING_AGENT_DIR");
        if (agentDir != null && !agentDir.trim().isEmpty()) {
            return Paths.get(agentDir.trim(), "sessions");
        }
        return Paths.get(home, ".omp", "agent", "sessions");
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "omp";
    }

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("sessionCount", sessions.size());
            result.put("provider", "omp");
            int totalMessages = sessions.stream().mapToInt(s -> s.messageCount).sum();
            result.put("total", totalMessages);
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[OmpHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read OMP sessions: " + e.getMessage());
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
            if (session.cwd == null) {
                continue;
            }
            if (pathsMatch(session.cwd, projectPath)) {
                filtered.add(session);
            }
        }
        filtered.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return filtered;
    }

    public List<SessionInfo> listAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();
        if (!Files.isDirectory(sessionsRoot)) {
            LOG.info("[OmpHistoryReader] Sessions root missing: " + sessionsRoot);
            return sessions;
        }
        try (DirectoryStream<Path> cwdDirs = Files.newDirectoryStream(sessionsRoot)) {
            for (Path cwdDir : cwdDirs) {
                if (!Files.isDirectory(cwdDir)) {
                    continue;
                }
                String name = cwdDir.getFileName().toString();
                if (name.startsWith(".")) {
                    continue;
                }
                try (DirectoryStream<Path> files = Files.newDirectoryStream(cwdDir, "*.jsonl")) {
                    for (Path file : files) {
                        if (!Files.isRegularFile(file)) {
                            continue;
                        }
                        SessionInfo info = readSessionSummary(file);
                        if (info != null) {
                            sessions.add(info);
                        }
                    }
                }
            }
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private SessionInfo readSessionSummary(Path file) {
        try {
            SessionHeader header = null;
            String firstUserPrompt = null;
            int messageCount = 0;
            long lastTs = 0L;

            try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty()) {
                        continue;
                    }
                    JsonObject obj;
                    try {
                        obj = JsonParser.parseString(line).getAsJsonObject();
                    } catch (Exception e) {
                        continue;
                    }
                    String type = text(obj, "type");
                    if ("session".equals(type) && header == null) {
                        header = parseHeader(obj, file);
                        continue;
                    }
                    if (!"message".equals(type)) {
                        continue;
                    }
                    JsonObject message = obj.has("message") && obj.get("message").isJsonObject()
                            ? obj.getAsJsonObject("message")
                            : null;
                    if (message == null) {
                        continue;
                    }
                    String role = text(message, "role");
                    long ts = parseTimestamp(obj, message);
                    if (ts > lastTs) {
                        lastTs = ts;
                    }
                    if ("user".equals(role)) {
                        messageCount++;
                        if (firstUserPrompt == null) {
                            String text = extractTextBlocks(message.get("content"));
                            if (!text.isBlank()) {
                                firstUserPrompt = text;
                            }
                        }
                    } else if ("assistant".equals(role)) {
                        messageCount++;
                    }
                }
            }

            if (header == null) {
                header = headerFromFileName(file);
            }
            if (header == null || header.sessionId == null || header.sessionId.isBlank()) {
                return null;
            }

            SessionInfo info = new SessionInfo();
            info.sessionId = header.sessionId;
            info.cwd = header.cwd;
            info.provider = "omp";
            info.messageCount = messageCount;
            info.fileSize = Files.size(file);
            info.firstTimestamp = header.timestamp > 0 ? header.timestamp : fileMtime(file);
            info.lastTimestamp = lastTs > 0 ? lastTs : fileMtime(file);
            if (info.firstTimestamp <= 0) {
                info.firstTimestamp = info.lastTimestamp;
            }
            if (firstUserPrompt != null && !firstUserPrompt.isBlank()) {
                info.title = truncate(firstUserPrompt, MAX_TITLE_CHARS);
            } else {
                info.title = "OMP session " + shortId(info.sessionId);
            }
            return info;
        } catch (Exception e) {
            LOG.debug("[OmpHistoryReader] Failed to read " + file + ": " + e.getMessage());
            return null;
        }
    }

    private static SessionHeader parseHeader(JsonObject obj, Path file) {
        SessionHeader header = new SessionHeader();
        header.sessionId = text(obj, "id");
        header.cwd = text(obj, "cwd");
        header.timestamp = parseIsoMillis(text(obj, "timestamp"));
        if (header.sessionId == null || header.sessionId.isBlank()) {
            SessionHeader fromName = headerFromFileName(file);
            if (fromName != null) {
                header.sessionId = fromName.sessionId;
            }
        }
        return header;
    }

    private static SessionHeader headerFromFileName(Path file) {
        String name = file.getFileName().toString();
        if (!name.endsWith(".jsonl")) {
            return null;
        }
        String stem = name.substring(0, name.length() - ".jsonl".length());
        int underscore = stem.lastIndexOf('_');
        if (underscore <= 0 || underscore >= stem.length() - 1) {
            return null;
        }
        SessionHeader header = new SessionHeader();
        header.sessionId = stem.substring(underscore + 1);
        return header;
    }

    /**
     * Load session transcript as Claude-compatible message envelopes for MessageParser.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        Path file = resolveSessionFile(sessionId, cwd);
        if (file == null || !Files.isRegularFile(file)) {
            LOG.warn("[OmpHistoryReader] Session file not found for id=" + sessionId + " cwd=" + cwd);
            return List.of();
        }
        return parseMessages(file);
    }

    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            LOG.warn("[OmpHistoryReader] Refusing to delete session with invalid id: " + sessionId);
            return false;
        }
        Path file = resolveSessionFile(sessionId, projectPath);
        if (file == null || !Files.isRegularFile(file)) {
            return false;
        }
        Files.deleteIfExists(file);
        Path parent = file.getParent();
        if (parent != null && Files.isDirectory(parent)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(parent)) {
                if (!stream.iterator().hasNext()) {
                    Files.deleteIfExists(parent);
                }
            } catch (Exception ignored) {
            }
        }
        return true;
    }

    private Path resolveSessionFile(String sessionId, String cwd) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            return null;
        }
        String id = sessionId.trim();
        // Prefer exact match under any cwd dir; filter by cwd when multiple.
        Path fallback = null;
        if (!Files.isDirectory(sessionsRoot)) {
            return null;
        }
        try (DirectoryStream<Path> cwdDirs = Files.newDirectoryStream(sessionsRoot)) {
            for (Path cwdDir : cwdDirs) {
                if (!Files.isDirectory(cwdDir)) {
                    continue;
                }
                try (DirectoryStream<Path> files = Files.newDirectoryStream(cwdDir, "*.jsonl")) {
                    for (Path file : files) {
                        SessionHeader header = readSessionHeader(file);
                        if (header == null) {
                            header = headerFromFileName(file);
                        }
                        if (header == null || !id.equals(header.sessionId)) {
                            continue;
                        }
                        if (cwd != null && !cwd.trim().isEmpty() && header.cwd != null
                                && pathsMatch(header.cwd, cwd)) {
                            return file;
                        }
                        if (fallback == null) {
                            fallback = file;
                        }
                    }
                }
            }
        }
        return fallback;
    }

    /**
     * OMP session files lead with a {@code type=title} line, so the {@code type=session}
     * header is not necessarily line 1 — scan the first {@value #MAX_HEADER_SCAN_LINES}
     * lines and stop at the first session header.
     */
    private static SessionHeader readSessionHeader(Path file) {
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            int scanned = 0;
            while (scanned < MAX_HEADER_SCAN_LINES && (line = reader.readLine()) != null) {
                scanned++;
                line = line.trim();
                if (line.isEmpty()) {
                    continue;
                }
                try {
                    JsonObject obj = JsonParser.parseString(line).getAsJsonObject();
                    if ("session".equals(text(obj, "type"))) {
                        return parseHeader(obj, file);
                    }
                } catch (Exception ignored) {
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    List<JsonObject> parseMessages(Path file) throws IOException {
        List<JsonObject> messages = new ArrayList<>();
        int counter = 0;
        try (BufferedReader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) {
                    continue;
                }
                JsonObject obj;
                try {
                    obj = JsonParser.parseString(line).getAsJsonObject();
                } catch (Exception e) {
                    continue;
                }
                if (!"message".equals(text(obj, "type"))) {
                    continue;
                }
                JsonObject message = obj.has("message") && obj.get("message").isJsonObject()
                        ? obj.getAsJsonObject("message")
                        : null;
                if (message == null) {
                    continue;
                }
                String role = text(message, "role");
                String entryId = text(obj, "id");
                if ("user".equals(role)) {
                    String text = extractTextBlocks(message.get("content"));
                    if (text.isBlank()) {
                        continue;
                    }
                    counter++;
                    messages.add(buildUserTextMessage(text, entryId != null ? entryId : "omp-user-" + counter));
                } else if ("assistant".equals(role)) {
                    List<JsonObject> fromAssistant = convertAssistantMessage(message, entryId, counter);
                    counter += fromAssistant.size();
                    messages.addAll(fromAssistant);
                } else if ("toolResult".equals(role)) {
                    String callId = text(message, "toolCallId");
                    if (callId == null || callId.isBlank()) {
                        callId = "omp-tool-" + (++counter);
                    }
                    String content = truncate(extractTextBlocks(message.get("content")), MAX_TOOL_RESULT_CHARS);
                    boolean isError = message.has("isError") && message.get("isError").getAsBoolean();
                    messages.add(buildToolResultMessage(callId, content, isError));
                }
            }
        }
        return messages;
    }

    private static List<JsonObject> convertAssistantMessage(JsonObject message, String entryId, int counterBase) {
        List<JsonObject> out = new ArrayList<>();
        JsonElement contentEl = message.get("content");
        if (contentEl == null || !contentEl.isJsonArray()) {
            return out;
        }
        int n = counterBase;
        StringBuilder textBuf = new StringBuilder();
        StringBuilder thinkBuf = new StringBuilder();
        for (JsonElement el : contentEl.getAsJsonArray()) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject block = el.getAsJsonObject();
            String type = text(block, "type");
            if ("text".equals(type)) {
                String t = text(block, "text");
                if (t != null && !t.isEmpty()) {
                    if (textBuf.length() > 0) {
                        textBuf.append('\n');
                    }
                    textBuf.append(t);
                }
            } else if ("thinking".equals(type)) {
                String t = text(block, "thinking");
                if (t != null && !t.isEmpty()) {
                    if (thinkBuf.length() > 0) {
                        thinkBuf.append('\n');
                    }
                    thinkBuf.append(t);
                }
            } else if ("toolCall".equals(type)) {
                // Flush pending text/thinking before tool use so order is preserved.
                if (thinkBuf.length() > 0) {
                    n++;
                    out.add(buildAssistantThinkingMessage(thinkBuf.toString(),
                            entryId != null ? entryId + "-think-" + n : "omp-think-" + n));
                    thinkBuf.setLength(0);
                }
                if (textBuf.length() > 0) {
                    n++;
                    out.add(buildAssistantTextMessage(textBuf.toString(),
                            entryId != null ? entryId + "-text-" + n : "omp-text-" + n));
                    textBuf.setLength(0);
                }
                String toolId = text(block, "id");
                if (toolId == null || toolId.isBlank()) {
                    toolId = "omp-tool-" + (++n);
                }
                String name = text(block, "name");
                if (name == null || name.isBlank()) {
                    name = "tool";
                }
                JsonObject input = new JsonObject();
                if (block.has("arguments") && block.get("arguments").isJsonObject()) {
                    input = block.getAsJsonObject("arguments");
                }
                out.add(buildToolUseMessage(toolId, name, input));
            }
        }
        if (thinkBuf.length() > 0) {
            n++;
            out.add(buildAssistantThinkingMessage(thinkBuf.toString(),
                    entryId != null ? entryId + "-think-" + n : "omp-think-" + n));
        }
        if (textBuf.length() > 0) {
            n++;
            out.add(buildAssistantTextMessage(textBuf.toString(),
                    entryId != null ? entryId + "-text-" + n : "omp-text-" + n));
        }
        return out;
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

    private static String extractTextBlocks(JsonElement content) {
        if (content == null || content.isJsonNull()) {
            return "";
        }
        if (content.isJsonPrimitive()) {
            return content.getAsString();
        }
        if (!content.isJsonArray()) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (JsonElement el : content.getAsJsonArray()) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject block = el.getAsJsonObject();
            String type = text(block, "type");
            if ("text".equals(type) || type == null || type.isEmpty()) {
                String t = text(block, "text");
                if (t != null && !t.isEmpty()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(t);
                }
            }
        }
        return sb.toString();
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

    private static long parseTimestamp(JsonObject entry, JsonObject message) {
        long fromEntry = parseIsoMillis(text(entry, "timestamp"));
        if (fromEntry > 0) {
            return fromEntry;
        }
        if (message != null && message.has("timestamp") && message.get("timestamp").isJsonPrimitive()) {
            try {
                return message.get("timestamp").getAsLong();
            } catch (Exception ignored) {
            }
        }
        return 0L;
    }

    private static long parseIsoMillis(String iso) {
        if (iso == null || iso.isBlank()) {
            return 0L;
        }
        try {
            return Instant.parse(iso).toEpochMilli();
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
        return id.length() <= 8 ? id : id.substring(0, 8);
    }

    private static final class SessionHeader {
        String sessionId;
        String cwd;
        long timestamp;
    }
}
