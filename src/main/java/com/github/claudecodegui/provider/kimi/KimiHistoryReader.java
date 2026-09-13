package com.github.claudecodegui.provider.kimi;

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
 * Reads Kimi Code CLI session history from {@code ~/.kimi-code/sessions/}.
 *
 * <p>Layout (docs + observed on disk):
 * <pre>
 *   ~/.kimi-code/
 *     session_index.jsonl
 *     sessions/&lt;workDirKey&gt;/&lt;sessionId&gt;/
 *       state.json
 *       agents/main/wire.jsonl
 * </pre>
 *
 * <p>{@code state.json} holds title / workDir / timestamps.
 * {@code wire.jsonl} is an event stream; we reconstruct chat from:
 * <ul>
 *   <li>{@code context.append_message} (user prompts)</li>
 *   <li>{@code context.append_loop_event} with {@code content.part}, {@code tool.call}, {@code tool.result}</li>
 * </ul>
 *
 * <p>Path matching is case-insensitive and normalizes {@code \} → {@code /} for Windows.
 */
public class KimiHistoryReader {

    private static final Logger LOG = Logger.getInstance(KimiHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;

    private final Gson gson;
    private final Path kimiHome;
    private final Path sessionsRoot;

    public KimiHistoryReader() {
        this(defaultKimiHome(), new Gson());
    }

    KimiHistoryReader(Path kimiHome, Gson gson) {
        this.kimiHome = kimiHome;
        this.sessionsRoot = kimiHome.resolve("sessions");
        this.gson = gson;
    }

    private static Path defaultKimiHome() {
        String home = NodeDetector.resolveHomeForFileOps();
        String override = firstNonBlank(
                System.getenv("KIMI_CODE_HOME"),
                System.getenv("KIMI_HOME")
        );
        if (override != null) {
            return Paths.get(override.trim());
        }
        // Current official home; keep legacy fallback if only that exists.
        Path modern = Paths.get(home, ".kimi-code");
        Path legacy = Paths.get(home, ".kimi");
        if (Files.isDirectory(modern)) {
            return modern;
        }
        if (Files.isDirectory(legacy)) {
            return legacy;
        }
        return modern;
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "kimi";
    }

    public String getSessionsForProjectAsJson(String projectPath) {
        try {
            List<SessionInfo> sessions = listSessionsForProject(projectPath);
            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("sessionCount", sessions.size());
            result.put("provider", "kimi");
            int totalMessages = sessions.stream().mapToInt(s -> s.messageCount).sum();
            result.put("total", totalMessages);
            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[KimiHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Kimi sessions: " + e.getMessage());
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
        List<SessionInfo> sessions = new ArrayList<>();
        if (!Files.isDirectory(sessionsRoot)) {
            LOG.info("[KimiHistoryReader] Sessions root missing: " + sessionsRoot);
            return sessions;
        }
        try (DirectoryStream<Path> workDirs = Files.newDirectoryStream(sessionsRoot)) {
            for (Path workDir : workDirs) {
                if (!Files.isDirectory(workDir) || workDir.getFileName().toString().startsWith(".")) {
                    continue;
                }
                try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(workDir)) {
                    for (Path sessionDir : sessionDirs) {
                        if (!Files.isDirectory(sessionDir)) {
                            continue;
                        }
                        SessionInfo info = readSessionSummary(sessionDir);
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

    private SessionInfo readSessionSummary(Path sessionDir) {
        try {
            Path statePath = sessionDir.resolve("state.json");
            if (!Files.isRegularFile(statePath)) {
                return null;
            }
            JsonObject state = JsonParser.parseString(Files.readString(statePath, StandardCharsets.UTF_8))
                    .getAsJsonObject();

            String sessionId = sessionDir.getFileName().toString();
            if (!isSafeSessionId(sessionId)) {
                return null;
            }

            SessionInfo info = new SessionInfo();
            info.sessionId = sessionId;
            info.cwd = text(state, "workDir");
            info.provider = "kimi";
            info.title = text(state, "title");
            if (info.title == null || info.title.isBlank()) {
                info.title = text(state, "lastPrompt");
            }
            if (info.title == null || info.title.isBlank()) {
                info.title = "Kimi session " + shortId(sessionId);
            } else {
                info.title = truncate(info.title, MAX_TITLE_CHARS);
            }

            info.firstTimestamp = parseIsoMillis(text(state, "createdAt"));
            info.lastTimestamp = parseIsoMillis(text(state, "updatedAt"));
            Path wire = sessionDir.resolve("agents").resolve("main").resolve("wire.jsonl");
            long wireMtime = fileMtime(wire);
            long stateMtime = fileMtime(statePath);
            if (info.lastTimestamp <= 0) {
                info.lastTimestamp = wireMtime > 0 ? wireMtime : stateMtime;
            }
            if (info.firstTimestamp <= 0) {
                info.firstTimestamp = info.lastTimestamp;
            }
            info.fileSize = Files.isRegularFile(wire) ? Files.size(wire) : Files.size(statePath);
            info.messageCount = countRenderableMessages(wire);
            return info;
        } catch (Exception e) {
            LOG.debug("[KimiHistoryReader] Failed to read " + sessionDir + ": " + e.getMessage());
            return null;
        }
    }

    private int countRenderableMessages(Path wire) {
        if (wire == null || !Files.isRegularFile(wire)) {
            return 0;
        }
        int count = 0;
        try (BufferedReader reader = Files.newBufferedReader(wire, StandardCharsets.UTF_8)) {
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
                if ("context.append_message".equals(type)) {
                    JsonObject message = obj.has("message") && obj.get("message").isJsonObject()
                            ? obj.getAsJsonObject("message") : null;
                    if (message != null && "user".equals(text(message, "role"))) {
                        count++;
                    }
                } else if ("context.append_loop_event".equals(type)) {
                    JsonObject event = obj.has("event") && obj.get("event").isJsonObject()
                            ? obj.getAsJsonObject("event") : null;
                    if (event == null) {
                        continue;
                    }
                    String et = text(event, "type");
                    if ("content.part".equals(et)) {
                        JsonObject part = event.has("part") && event.get("part").isJsonObject()
                                ? event.getAsJsonObject("part") : null;
                        if (part != null && "text".equals(text(part, "type"))) {
                            String t = text(part, "text");
                            if (t != null && !t.isBlank()) {
                                count++;
                            }
                        }
                    }
                }
            }
        } catch (IOException e) {
            return 0;
        }
        return count;
    }

    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        Path sessionDir = resolveSessionDir(sessionId, cwd);
        if (sessionDir == null) {
            LOG.warn("[KimiHistoryReader] Session dir not found for id=" + sessionId + " cwd=" + cwd);
            return List.of();
        }
        Path wire = sessionDir.resolve("agents").resolve("main").resolve("wire.jsonl");
        if (!Files.isRegularFile(wire)) {
            return List.of();
        }
        return parseWireToMessages(wire);
    }

    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            LOG.warn("[KimiHistoryReader] Refusing to delete session with invalid id: " + sessionId);
            return false;
        }
        Path sessionDir = resolveSessionDir(sessionId, projectPath);
        if (sessionDir == null || !Files.isDirectory(sessionDir)) {
            return false;
        }
        deleteRecursively(sessionDir);
        Path parent = sessionDir.getParent();
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

    private Path resolveSessionDir(String sessionId, String cwd) throws IOException {
        if (!isSafeSessionId(sessionId)) {
            return null;
        }
        String id = sessionId.trim();
        Path fallback = null;
        if (!Files.isDirectory(sessionsRoot)) {
            return null;
        }
        try (DirectoryStream<Path> workDirs = Files.newDirectoryStream(sessionsRoot)) {
            for (Path workDir : workDirs) {
                if (!Files.isDirectory(workDir)) {
                    continue;
                }
                Path candidate = workDir.resolve(id);
                if (!Files.isDirectory(candidate)) {
                    continue;
                }
                if (cwd != null && !cwd.trim().isEmpty()) {
                    Path statePath = candidate.resolve("state.json");
                    if (Files.isRegularFile(statePath)) {
                        try {
                            JsonObject state = JsonParser.parseString(
                                    Files.readString(statePath, StandardCharsets.UTF_8)).getAsJsonObject();
                            String workDirPath = text(state, "workDir");
                            if (workDirPath != null && pathsMatch(workDirPath, cwd)) {
                                return candidate;
                            }
                        } catch (Exception ignored) {
                        }
                    }
                }
                if (fallback == null) {
                    fallback = candidate;
                }
            }
        }
        return fallback;
    }

    List<JsonObject> parseWireToMessages(Path wire) throws IOException {
        List<JsonObject> messages = new ArrayList<>();
        int counter = 0;
        try (BufferedReader reader = Files.newBufferedReader(wire, StandardCharsets.UTF_8)) {
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
                if ("context.append_message".equals(type)) {
                    JsonObject message = obj.has("message") && obj.get("message").isJsonObject()
                            ? obj.getAsJsonObject("message") : null;
                    if (message == null) {
                        continue;
                    }
                    String role = text(message, "role");
                    if (!"user".equals(role)) {
                        // Assistant content is streamed via loop events; skip duplicate/system roles.
                        continue;
                    }
                    String text = extractContentText(message.get("content"));
                    if (text.isBlank()) {
                        continue;
                    }
                    counter++;
                    messages.add(buildUserTextMessage(text, "kimi-user-" + counter));
                } else if ("context.append_loop_event".equals(type)) {
                    JsonObject event = obj.has("event") && obj.get("event").isJsonObject()
                            ? obj.getAsJsonObject("event") : null;
                    if (event == null) {
                        continue;
                    }
                    String et = text(event, "type");
                    if ("content.part".equals(et)) {
                        JsonObject part = event.has("part") && event.get("part").isJsonObject()
                                ? event.getAsJsonObject("part") : null;
                        if (part == null) {
                            continue;
                        }
                        String partType = text(part, "type");
                        if ("think".equals(partType)) {
                            String think = text(part, "think");
                            if (think != null && !think.isBlank()) {
                                counter++;
                                messages.add(buildAssistantThinkingMessage(think, "kimi-think-" + counter));
                            }
                        } else if ("text".equals(partType)) {
                            String body = text(part, "text");
                            if (body != null && !body.isBlank()) {
                                counter++;
                                messages.add(buildAssistantTextMessage(body, "kimi-text-" + counter));
                            }
                        }
                    } else if ("tool.call".equals(et)) {
                        String callId = firstNonBlank(text(event, "toolCallId"), text(event, "uuid"));
                        if (callId == null || callId.isBlank()) {
                            callId = "kimi-tool-" + (++counter);
                        }
                        String name = text(event, "name");
                        if (name == null || name.isBlank()) {
                            name = "tool";
                        }
                        JsonObject input = new JsonObject();
                        if (event.has("args") && event.get("args").isJsonObject()) {
                            input = event.getAsJsonObject("args");
                        }
                        messages.add(buildToolUseMessage(callId, name, input));
                    } else if ("tool.result".equals(et)) {
                        String callId = text(event, "toolCallId");
                        if (callId == null || callId.isBlank()) {
                            callId = "kimi-tool-" + (++counter);
                        }
                        String content = extractToolResultContent(event.get("result"));
                        if (content.isBlank()) {
                            continue;
                        }
                        boolean isError = false;
                        if (event.has("result") && event.get("result").isJsonObject()) {
                            JsonObject result = event.getAsJsonObject("result");
                            if (result.has("error") && !result.get("error").isJsonNull()) {
                                isError = true;
                            }
                        }
                        messages.add(buildToolResultMessage(
                                callId, truncate(content, MAX_TOOL_RESULT_CHARS), isError));
                    }
                } else if ("turn.prompt".equals(type)) {
                    // Fallback user text when append_message is missing (some versions).
                    if (obj.has("input") && obj.get("input").isJsonArray()) {
                        String text = extractContentText(obj.get("input"));
                        if (!text.isBlank()) {
                            // Avoid double-counting if we already have identical latest user text.
                            if (messages.isEmpty()
                                    || !"user".equals(messages.get(messages.size() - 1).get("type").getAsString())) {
                                counter++;
                                messages.add(buildUserTextMessage(text, "kimi-prompt-" + counter));
                            }
                        }
                    }
                }
            }
        }
        return messages;
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

    private static String extractContentText(JsonElement content) {
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

    private static String extractToolResultContent(JsonElement result) {
        if (result == null || result.isJsonNull()) {
            return "";
        }
        if (result.isJsonPrimitive()) {
            return result.getAsString();
        }
        if (result.isJsonObject()) {
            JsonObject obj = result.getAsJsonObject();
            if (obj.has("output") && !obj.get("output").isJsonNull()) {
                JsonElement output = obj.get("output");
                if (output.isJsonPrimitive()) {
                    return output.getAsString();
                }
                return output.toString();
            }
            if (obj.has("error") && !obj.get("error").isJsonNull()) {
                JsonElement err = obj.get("error");
                if (err.isJsonPrimitive()) {
                    return err.getAsString();
                }
                return err.toString();
            }
            return obj.toString();
        }
        return result.toString();
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
        // session_uuid or bare uuid
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

    private static String firstNonBlank(String... values) {
        if (values == null) {
            return null;
        }
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return null;
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
            if (path != null && Files.isRegularFile(path)) {
                return Files.getLastModifiedTime(path).toMillis();
            }
        } catch (IOException ignored) {
        }
        return 0L;
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
        // Prefer trailing uuid segment: session_xxxx
        int underscore = id.lastIndexOf('_');
        String tail = underscore >= 0 && underscore < id.length() - 1 ? id.substring(underscore + 1) : id;
        return tail.length() <= 8 ? tail : tail.substring(0, 8);
    }
}
