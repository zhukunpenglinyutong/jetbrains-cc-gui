package com.github.claudecodegui.provider.grok;

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
import java.net.URLDecoder;
import java.net.URLEncoder;
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
 * Reads Grok CLI session history from
 * {@code $GROK_HOME/sessions/<url-encoded-cwd>/<sessionId>/{summary.json,chat_history.jsonl}}
 * (default home {@code ~/.grok}; often {@code ~/.antig-grok} when {@code GROK_HOME} is set).
 */
public class GrokHistoryReader {

    private static final Logger LOG = Logger.getInstance(GrokHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;

    private final Gson gson;
    /** Ordered session roots (primary GROK_HOME first, then fallbacks). */
    private final List<Path> sessionsRoots;

    public GrokHistoryReader() {
        this(defaultSessionsRoots(), new Gson());
    }

    GrokHistoryReader(Path sessionsRoot, Gson gson) {
        this(sessionsRoot != null ? List.of(sessionsRoot) : List.of(), gson);
    }

    GrokHistoryReader(List<Path> sessionsRoots, Gson gson) {
        this.sessionsRoots = sessionsRoots != null ? List.copyOf(sessionsRoots) : List.of();
        this.gson = gson;
    }

    private static List<Path> defaultSessionsRoots() {
        List<Path> roots = new ArrayList<>();
        for (Path home : GrokLocalAuthResolver.resolveGrokHomeCandidates()) {
            if (home != null) {
                roots.add(home.resolve("sessions"));
            }
        }
        // Last-resort default if PlatformUtils home resolution failed above.
        if (roots.isEmpty()) {
            String home = NodeDetector.resolveHomeForFileOps();
            if (home != null && !home.isEmpty()) {
                roots.add(Paths.get(home, ".grok", "sessions"));
            }
        }
        LOG.info("[GrokHistoryReader] Session roots: " + roots);
        return roots;
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "grok";
        /** Model id used by this session when known (e.g. grok-4.6). */
        public String model;
    }

    /**
     * List sessions for a project path as JSON expected by HistoryView.
     */
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
            LOG.error("[GrokHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Grok sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    public List<SessionInfo> listSessionsForProject(String projectPath) throws IOException {
        List<SessionInfo> all = listAllSessions();
        if (projectPath == null || projectPath.trim().isEmpty()) {
            return all;
        }
        String normalizedProject = normalizePath(projectPath);
        List<SessionInfo> filtered = new ArrayList<>();
        for (SessionInfo session : all) {
            if (session.cwd == null) {
                continue;
            }
            String sessionCwd = normalizePath(session.cwd);
            if (pathsMatch(sessionCwd, normalizedProject)) {
                filtered.add(session);
            }
        }
        filtered.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return filtered;
    }

    public List<SessionInfo> listAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();
        // Prefer the first root that owns a given sessionId when the same id
        // appears in multiple homes (should be rare).
        Map<String, SessionInfo> byId = new HashMap<>();
        boolean anyRoot = false;
        for (Path sessionsRoot : sessionsRoots) {
            if (!Files.isDirectory(sessionsRoot)) {
                LOG.info("[GrokHistoryReader] Sessions root missing: " + sessionsRoot);
                continue;
            }
            anyRoot = true;
            try (DirectoryStream<Path> cwdDirs = Files.newDirectoryStream(sessionsRoot)) {
                for (Path cwdDir : cwdDirs) {
                    if (!Files.isDirectory(cwdDir)) {
                        continue;
                    }
                    String name = cwdDir.getFileName().toString();
                    if (name.startsWith(".") || name.endsWith(".sqlite") || name.endsWith(".db")) {
                        continue;
                    }
                    String cwd = decodeCwdDirName(name);
                    try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(cwdDir)) {
                        for (Path sessionDir : sessionDirs) {
                            if (!Files.isDirectory(sessionDir)) {
                                continue;
                            }
                            SessionInfo info = readSessionSummary(sessionDir, cwd);
                            if (info != null && info.sessionId != null) {
                                byId.putIfAbsent(info.sessionId, info);
                            }
                        }
                    }
                }
            }
        }
        if (!anyRoot) {
            LOG.info("[GrokHistoryReader] No sessions roots available: " + sessionsRoots);
        }
        sessions.addAll(byId.values());
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private SessionInfo readSessionSummary(Path sessionDir, String cwd) {
        String sessionId = sessionDir.getFileName().toString();
        if (sessionId.isEmpty() || sessionId.contains("..")) {
            return null;
        }
        Path summaryPath = sessionDir.resolve("summary.json");
        Path chatPath = sessionDir.resolve("chat_history.jsonl");
        if (!Files.isRegularFile(chatPath) && !Files.isRegularFile(summaryPath)) {
            return null;
        }

        SessionInfo info = new SessionInfo();
        info.sessionId = sessionId;
        info.cwd = cwd;
        info.provider = "grok";

        long chatMtime = fileMtimeMillis(chatPath);
        long summaryMtime = fileMtimeMillis(summaryPath);
        long created = 0L;
        long updatedFromSummary = 0L;
        String generatedTitle = null;
        String sessionSummary = null;
        int messageCount = 0;

        if (Files.isRegularFile(summaryPath)) {
            try {
                String raw = Files.readString(summaryPath, StandardCharsets.UTF_8);
                JsonObject summary = JsonParser.parseString(raw).getAsJsonObject();
                if (summary.has("generated_title") && !summary.get("generated_title").isJsonNull()) {
                    generatedTitle = summary.get("generated_title").getAsString();
                }
                if (summary.has("session_summary") && !summary.get("session_summary").isJsonNull()) {
                    sessionSummary = summary.get("session_summary").getAsString();
                }
                if (summary.has("num_chat_messages") && summary.get("num_chat_messages").isJsonPrimitive()) {
                    messageCount = summary.get("num_chat_messages").getAsInt();
                } else if (summary.has("num_messages") && summary.get("num_messages").isJsonPrimitive()) {
                    messageCount = summary.get("num_messages").getAsInt();
                }
                created = parseRfc3339Millis(summary, "created_at");
                updatedFromSummary = parseRfc3339Millis(summary, "updated_at");
                if (summary.has("current_model_id") && !summary.get("current_model_id").isJsonNull()) {
                    String modelId = summary.get("current_model_id").getAsString();
                    if (modelId != null && !modelId.isBlank()) {
                        info.model = modelId.trim();
                    }
                }
                if (summary.has("info") && summary.get("info").isJsonObject()) {
                    JsonObject sessionInfo = summary.getAsJsonObject("info");
                    if (sessionInfo.has("cwd") && !sessionInfo.get("cwd").isJsonNull()) {
                        info.cwd = sessionInfo.get("cwd").getAsString();
                    }
                    if (sessionInfo.has("id") && !sessionInfo.get("id").isJsonNull()) {
                        info.sessionId = sessionInfo.get("id").getAsString();
                    }
                }
            } catch (Exception e) {
                LOG.debug("[GrokHistoryReader] Failed to parse summary for " + sessionDir + ": " + e.getMessage());
            }
        }

        String firstUserPrompt = null;
        if (Files.isRegularFile(chatPath)) {
            try {
                info.fileSize = Files.size(chatPath);
                // Always capture first user prompt when possible: Grok CLI's generated_title
                // is frequently an English paraphrase of a non-English user message.
                ChatHistoryMeta meta = scanChatHistoryMeta(chatPath, true);
                if (messageCount <= 0) {
                    messageCount = meta.nonEmptyLines;
                }
                firstUserPrompt = meta.firstUserPrompt;
            } catch (Exception e) {
                LOG.debug("[GrokHistoryReader] Failed to read chat history meta for " + sessionDir + ": " + e.getMessage());
            }
        }

        info.title = resolveSessionTitle(firstUserPrompt, generatedTitle, sessionSummary, sessionId);
        info.messageCount = Math.max(messageCount, 0);
        info.firstTimestamp = created > 0 ? created : (summaryMtime > 0 ? summaryMtime : chatMtime);
        // Prefer chat file mtime so bulk summary rewrites don't collapse all rows to "just now".
        long activity = chatMtime > 0 ? chatMtime
                : (updatedFromSummary > 0 ? updatedFromSummary
                : (summaryMtime > 0 ? summaryMtime : info.firstTimestamp));
        info.lastTimestamp = activity > 0 ? activity : System.currentTimeMillis();
        if (info.firstTimestamp <= 0) {
            info.firstTimestamp = info.lastTimestamp;
        }
        return info;
    }

    /**
     * Load session transcript as Claude-compatible message envelopes for
     * {@link com.github.claudecodegui.session.MessageParser}.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        Path sessionDir = resolveSessionDir(sessionId, cwd);
        if (sessionDir == null) {
            LOG.warn("[GrokHistoryReader] Session dir not found for id=" + sessionId + " cwd=" + cwd);
            return List.of();
        }
        Path chatPath = sessionDir.resolve("chat_history.jsonl");
        if (!Files.isRegularFile(chatPath)) {
            return List.of();
        }
        return parseChatHistoryToMessages(chatPath);
    }

    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        if (sessionId == null || sessionId.trim().isEmpty()
                || sessionId.contains("/") || sessionId.contains("\\") || sessionId.contains("..")) {
            LOG.warn("[GrokHistoryReader] Refusing to delete session with invalid id: " + sessionId);
            return false;
        }
        Path sessionDir = resolveSessionDir(sessionId, projectPath);
        if (sessionDir == null || !Files.isDirectory(sessionDir)) {
            // Fallback: scan all cwd dirs for this id
            sessionDir = findSessionDirById(sessionId);
        }
        if (sessionDir == null || !Files.isDirectory(sessionDir)) {
            return false;
        }
        deleteRecursively(sessionDir);
        // Remove empty cwd parent
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

    private Path resolveSessionDir(String sessionId, String cwd) {
        if (sessionId == null || sessionId.trim().isEmpty()) {
            return null;
        }
        String id = sessionId.trim();
        if (id.contains("/") || id.contains("\\") || id.contains("..")) {
            return null;
        }
        if (cwd != null && !cwd.trim().isEmpty()) {
            String encoded = encodeCwd(cwd);
            String encodedCanon = encodeCwd(canonicalizePath(cwd));
            for (Path sessionsRoot : sessionsRoots) {
                Path direct = sessionsRoot.resolve(encoded).resolve(id);
                if (Files.isDirectory(direct)) {
                    return direct;
                }
                // macOS may canonicalize /var → /private/var etc.
                Path canon = sessionsRoot.resolve(encodedCanon).resolve(id);
                if (Files.isDirectory(canon)) {
                    return canon;
                }
            }
        }
        return findSessionDirById(id);
    }

    private Path findSessionDirById(String sessionId) {
        for (Path sessionsRoot : sessionsRoots) {
            if (!Files.isDirectory(sessionsRoot)) {
                continue;
            }
            try (DirectoryStream<Path> cwdDirs = Files.newDirectoryStream(sessionsRoot)) {
                for (Path cwdDir : cwdDirs) {
                    if (!Files.isDirectory(cwdDir)) {
                        continue;
                    }
                    Path candidate = cwdDir.resolve(sessionId);
                    if (Files.isDirectory(candidate)) {
                        return candidate;
                    }
                }
            } catch (IOException e) {
                LOG.warn("[GrokHistoryReader] Scan for session id failed under "
                        + sessionsRoot + ": " + e.getMessage());
            }
        }
        return null;
    }

    List<JsonObject> parseChatHistoryToMessages(Path chatPath) throws IOException {
        List<JsonObject> messages = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(chatPath, StandardCharsets.UTF_8)) {
            String line;
            int counter = 0;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || !line.contains("\"type\"")) {
                    continue;
                }
                JsonObject value;
                try {
                    value = JsonParser.parseString(line).getAsJsonObject();
                } catch (Exception e) {
                    continue;
                }
                String type = value.has("type") && !value.get("type").isJsonNull()
                        ? value.get("type").getAsString()
                        : "";
                switch (type) {
                    case "user" -> {
                        if (value.has("synthetic_reason")) {
                            continue;
                        }
                        String rawText = extractContentText(value.get("content"));
                        if (isRuntimeContextUserText(rawText)) {
                            continue;
                        }
                        String display = stripUserQueryWrapper(rawText);
                        if (display.isEmpty()) {
                            continue;
                        }
                        counter++;
                        messages.add(buildUserTextMessage(display, "grok-user-" + counter));
                    }
                    case "reasoning" -> {
                        String text = extractReasoningSummary(value.get("summary"));
                        if (text.isBlank()) {
                            continue;
                        }
                        counter++;
                        messages.add(buildAssistantThinkingMessage(text, "grok-reasoning-" + counter));
                    }
                    case "assistant" -> {
                        String text = extractContentText(value.get("content"));
                        if (!text.isBlank()) {
                            counter++;
                            messages.add(buildAssistantTextMessage(text, "grok-assistant-" + counter));
                        }
                        if (value.has("tool_calls") && value.get("tool_calls").isJsonArray()) {
                            JsonArray toolCalls = value.getAsJsonArray("tool_calls");
                            for (JsonElement el : toolCalls) {
                                if (!el.isJsonObject()) {
                                    continue;
                                }
                                JsonObject call = el.getAsJsonObject();
                                String toolName = resolveToolName(call);
                                String callId = call.has("id") && !call.get("id").isJsonNull()
                                        ? call.get("id").getAsString()
                                        : ("grok-tool-" + (++counter));
                                JsonObject input = resolveToolArguments(call);
                                messages.add(buildToolUseMessage(callId, toolName, input));
                            }
                        }
                    }
                    case "tool_result" -> {
                        String callId = value.has("tool_call_id") && !value.get("tool_call_id").isJsonNull()
                                ? value.get("tool_call_id").getAsString()
                                : ("grok-tool-" + (++counter));
                        String content = truncate(stringifyContent(value.get("content")), MAX_TOOL_RESULT_CHARS);
                        if (content.isBlank()) {
                            continue;
                        }
                        messages.add(buildToolResultMessage(callId, content));
                    }
                    default -> {
                        // skip system / unknown
                    }
                }
            }
        }
        return messages;
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
        block.addProperty("content", contentText);
        content.add(block);
        message.add("content", content);
        root.add("message", message);
        return root;
    }

    private static String resolveToolName(JsonObject call) {
        if (call.has("name") && !call.get("name").isJsonNull()) {
            String name = call.get("name").getAsString();
            if (!name.isBlank()) {
                return name.trim();
            }
        }
        if (call.has("function") && call.get("function").isJsonObject()) {
            JsonObject fn = call.getAsJsonObject("function");
            if (fn.has("name") && !fn.get("name").isJsonNull()) {
                return fn.get("name").getAsString();
            }
        }
        return "tool";
    }

    private static JsonObject resolveToolArguments(JsonObject call) {
        JsonElement args = null;
        if (call.has("arguments")) {
            args = call.get("arguments");
        } else if (call.has("function") && call.get("function").isJsonObject()) {
            JsonObject fn = call.getAsJsonObject("function");
            if (fn.has("arguments")) {
                args = fn.get("arguments");
            }
        }
        return parseArguments(args);
    }

    private static JsonObject parseArguments(JsonElement args) {
        if (args == null || args.isJsonNull()) {
            return new JsonObject();
        }
        if (args.isJsonObject()) {
            return args.getAsJsonObject();
        }
        if (args.isJsonPrimitive()) {
            String raw = args.getAsString();
            if (raw == null || raw.isBlank()) {
                return new JsonObject();
            }
            try {
                JsonElement parsed = JsonParser.parseString(raw);
                if (parsed.isJsonObject()) {
                    return parsed.getAsJsonObject();
                }
                JsonObject wrap = new JsonObject();
                wrap.add("value", parsed);
                return wrap;
            } catch (Exception e) {
                JsonObject wrap = new JsonObject();
                wrap.addProperty("raw", raw);
                return wrap;
            }
        }
        JsonObject wrap = new JsonObject();
        wrap.add("value", args);
        return wrap;
    }

    private static String extractContentText(JsonElement content) {
        if (content == null || content.isJsonNull()) {
            return "";
        }
        if (content.isJsonPrimitive()) {
            return content.getAsString();
        }
        if (content.isJsonArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonElement el : content.getAsJsonArray()) {
                if (!el.isJsonObject()) {
                    continue;
                }
                JsonObject block = el.getAsJsonObject();
                if (block.has("text") && !block.get("text").isJsonNull()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(block.get("text").getAsString());
                }
            }
            return sb.toString();
        }
        return "";
    }

    private static String extractReasoningSummary(JsonElement summary) {
        if (summary == null || summary.isJsonNull()) {
            return "";
        }
        if (summary.isJsonPrimitive()) {
            return summary.getAsString();
        }
        if (summary.isJsonArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonElement el : summary.getAsJsonArray()) {
                if (el.isJsonPrimitive()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(el.getAsString());
                } else if (el.isJsonObject()) {
                    JsonObject part = el.getAsJsonObject();
                    if (part.has("text") && !part.get("text").isJsonNull()) {
                        if (sb.length() > 0) {
                            sb.append('\n');
                        }
                        sb.append(part.get("text").getAsString());
                    }
                }
            }
            return sb.toString();
        }
        return "";
    }

    private static String stringifyContent(JsonElement content) {
        if (content == null || content.isJsonNull()) {
            return "";
        }
        if (content.isJsonPrimitive()) {
            return content.getAsString();
        }
        return content.toString();
    }

    /**
     * History list / reopen title priority:
     * <ol>
     *   <li>First real user prompt (preserves the user's language; matches Codex)</li>
     *   <li>Grok CLI {@code generated_title}</li>
     *   <li>{@code session_summary}</li>
     *   <li>Short session-id fallback</li>
     * </ol>
     * Preferring the user prompt avoids English auto-titles for Chinese (etc.) prompts.
     */
    static String resolveSessionTitle(
            String firstUserPrompt,
            String generatedTitle,
            String sessionSummary,
            String sessionId
    ) {
        if (firstUserPrompt != null && !firstUserPrompt.trim().isEmpty()) {
            return truncate(firstUserPrompt.trim(), MAX_TITLE_CHARS);
        }
        if (generatedTitle != null && !generatedTitle.trim().isEmpty()) {
            return generatedTitle.trim();
        }
        if (sessionSummary != null && !sessionSummary.trim().isEmpty()) {
            return truncate(sessionSummary.trim(), MAX_TITLE_CHARS);
        }
        String id = sessionId != null ? sessionId : "";
        return "Grok session " + id.substring(0, Math.min(8, id.length()));
    }

    private static String stripUserQueryWrapper(String raw) {
        if (raw == null) {
            return "";
        }
        String text = raw.trim();
        // Prefer <user_query> body when present
        int start = text.indexOf("<user_query>");
        int end = text.indexOf("</user_query>");
        if (start >= 0 && end > start) {
            return text.substring(start + "<user_query>".length(), end).trim();
        }
        return text;
    }

    private static boolean isRuntimeContextUserText(String raw) {
        if (raw == null) {
            return true;
        }
        String t = raw.trim();
        if (t.isEmpty()) {
            return true;
        }
        return t.startsWith("<user_info>")
                || t.startsWith("<git_status>")
                || t.startsWith("<system-reminder>")
                || t.contains("<system-reminder>");
    }

    /**
     * Single-pass scan of chat_history.jsonl: counts non-empty lines and (when
     * {@code captureFirstUserPrompt}) captures the first real user prompt.
     */
    private static ChatHistoryMeta scanChatHistoryMeta(Path chatPath, boolean captureFirstUserPrompt) throws IOException {
        ChatHistoryMeta meta = new ChatHistoryMeta();
        try (BufferedReader reader = Files.newBufferedReader(chatPath, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }
                meta.nonEmptyLines++;
                if (!captureFirstUserPrompt || meta.firstUserPrompt != null) {
                    continue;
                }
                if (!line.contains("\"type\":\"user\"") && !line.contains("\"type\": \"user\"")) {
                    continue;
                }
                try {
                    JsonObject value = JsonParser.parseString(line).getAsJsonObject();
                    if (value.has("synthetic_reason")) {
                        continue;
                    }
                    String raw = extractContentText(value.get("content"));
                    if (isRuntimeContextUserText(raw)) {
                        continue;
                    }
                    String display = stripUserQueryWrapper(raw);
                    if (!display.isEmpty()) {
                        meta.firstUserPrompt = display;
                    }
                } catch (Exception ignored) {
                }
            }
        }
        return meta;
    }

    private static final class ChatHistoryMeta {
        int nonEmptyLines;
        String firstUserPrompt;
    }

    private static long fileMtimeMillis(Path path) {
        try {
            if (path != null && Files.isRegularFile(path)) {
                return Files.getLastModifiedTime(path).toMillis();
            }
        } catch (IOException ignored) {
        }
        return 0L;
    }

    private static long parseRfc3339Millis(JsonObject obj, String field) {
        if (!obj.has(field) || obj.get(field).isJsonNull()) {
            return 0L;
        }
        try {
            return Instant.parse(obj.get(field).getAsString()).toEpochMilli();
        } catch (Exception e) {
            return 0L;
        }
    }

    static String encodeCwd(String cwd) {
        String normalized = normalizePath(cwd);
        return URLEncoder.encode(normalized, StandardCharsets.UTF_8);
    }

    static String decodeCwdDirName(String name) {
        try {
            return URLDecoder.decode(name, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return name;
        }
    }

    static String normalizePath(String path) {
        return HistoryPathMatcher.normalize(path);
    }

    private static String canonicalizePath(String path) {
        try {
            return Paths.get(path).toRealPath().toString();
        } catch (Exception e) {
            return path;
        }
    }

    static boolean pathsMatch(String sessionCwd, String projectPath) {
        return HistoryPathMatcher.matches(sessionCwd, projectPath);
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

    private static void deleteRecursively(Path path) throws IOException {
        if (!Files.exists(path)) {
            return;
        }
        if (Files.isDirectory(path)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(path)) {
                for (Path child : stream) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(path);
    }
}
