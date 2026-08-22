package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.Gson;
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
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reads Gemini CLI (Antigravity CLI) session history from
 * {@code ~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl}
 * and {@code ~/.gemini/antigravity-cli/history.jsonl}.
 */
public class GeminiHistoryReader {

    private static final Logger LOG = Logger.getInstance(GeminiHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final Pattern USER_REQUEST_PATTERN = Pattern.compile("<USER_REQUEST>\\s*(.*?)\\s*</USER_REQUEST>", Pattern.DOTALL);

    private final Gson gson;
    private final Path brainRoot;
    private final Path historyFile;

    public GeminiHistoryReader() {
        this(defaultBrainRoot(), defaultHistoryFile(), new Gson());
    }

    public GeminiHistoryReader(Path brainRoot, Path historyFile, Gson gson) {
        this.brainRoot = brainRoot;
        this.historyFile = historyFile;
        this.gson = gson;
    }

    private static Path defaultBrainRoot() {
        String home = NodeDetector.resolveHomeForFileOps();
        String geminiHome = System.getenv("GEMINI_CLI_HOME");
        if (geminiHome == null || geminiHome.trim().isEmpty()) {
            geminiHome = System.getenv("ANTIGRAVITY_HOME");
        }
        if (geminiHome != null && !geminiHome.trim().isEmpty()) {
            return Paths.get(geminiHome.trim(), "brain");
        }
        return Paths.get(home, ".gemini", "antigravity-cli", "brain");
    }

    private static Path defaultHistoryFile() {
        String home = NodeDetector.resolveHomeForFileOps();
        String geminiHome = System.getenv("GEMINI_CLI_HOME");
        if (geminiHome == null || geminiHome.trim().isEmpty()) {
            geminiHome = System.getenv("ANTIGRAVITY_HOME");
        }
        if (geminiHome != null && !geminiHome.trim().isEmpty()) {
            return Paths.get(geminiHome.trim(), "history.jsonl");
        }
        return Paths.get(home, ".gemini", "antigravity-cli", "history.jsonl");
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "gemini";
    }

    /**
     * List sessions for a project path as JSON expected by HistoryView frontend.
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
        List<SessionInfo> filtered = new ArrayList<>();
        for (SessionInfo session : all) {
            if (session.cwd == null) {
                // Include session if workspace path is unknown/not recorded to avoid hiding session
                filtered.add(session);
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
        if (!Files.isDirectory(brainRoot)) {
            LOG.info("[GeminiHistoryReader] Brain root missing: " + brainRoot);
            return sessions;
        }

        Map<String, String> workspaceMap = readHistoryWorkspaceMap();

        try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(brainRoot)) {
            for (Path sessionDir : sessionDirs) {
                if (!Files.isDirectory(sessionDir)) {
                    continue;
                }
                String name = sessionDir.getFileName().toString();
                if (name.startsWith(".") || name.contains("..")) {
                    continue;
                }
                SessionInfo info = readSessionSummary(sessionDir, workspaceMap.get(name));
                if (info != null) {
                    sessions.add(info);
                }
            }
        }
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private Map<String, String> readHistoryWorkspaceMap() {
        Map<String, String> map = new HashMap<>();
        if (historyFile == null || !Files.isRegularFile(historyFile)) {
            return map;
        }
        try (BufferedReader reader = Files.newBufferedReader(historyFile, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || !line.startsWith("{")) {
                    continue;
                }
                try {
                    JsonObject obj = JsonParser.parseString(line).getAsJsonObject();
                    if (obj.has("conversationId") && !obj.get("conversationId").isJsonNull()
                            && obj.has("workspace") && !obj.get("workspace").isJsonNull()) {
                        String cid = obj.get("conversationId").getAsString().trim();
                        String ws = obj.get("workspace").getAsString().trim();
                        if (!cid.isEmpty() && !ws.isEmpty()) {
                            map.put(cid, ws);
                        }
                    }
                } catch (Exception ignored) {
                }
            }
        } catch (Exception e) {
            LOG.debug("[GeminiHistoryReader] Error reading history.jsonl: " + e.getMessage());
        }
        return map;
    }

    private SessionInfo readSessionSummary(Path sessionDir, String historyCwd) {
        String sessionId = sessionDir.getFileName().toString();
        Path transcriptPath = sessionDir.resolve(".system_generated").resolve("logs").resolve("transcript.jsonl");
        if (!Files.isRegularFile(transcriptPath)) {
            transcriptPath = sessionDir.resolve(".system_generated").resolve("logs").resolve("transcript_full.jsonl");
        }
        if (!Files.isRegularFile(transcriptPath)) {
            return null;
        }

        SessionInfo info = new SessionInfo();
        info.sessionId = sessionId;
        info.cwd = historyCwd;
        info.provider = "gemini";

        long mtime = fileMtimeMillis(transcriptPath);
        String title = null;
        int messageCount = 0;
        long firstTime = 0L;

        try {
            info.fileSize = Files.size(transcriptPath);
            try (BufferedReader reader = Files.newBufferedReader(transcriptPath, StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty() || !line.startsWith("{")) {
                        continue;
                    }
                    try {
                        JsonObject obj = JsonParser.parseString(line).getAsJsonObject();
                        String type = obj.has("type") && !obj.get("type").isJsonNull() ? obj.get("type").getAsString() : "";
                        String content = obj.has("content") && !obj.get("content").isJsonNull() ? obj.get("content").getAsString() : "";

                        if ("USER_INPUT".equals(type) || "PLANNER_RESPONSE".equals(type)) {
                            messageCount++;
                        }

                        if (firstTime == 0L && obj.has("created_at") && !obj.get("created_at").isJsonNull()) {
                            firstTime = parseIso8601Millis(obj.get("created_at").getAsString());
                        }

                        if (title == null && "USER_INPUT".equals(type) && !content.trim().isEmpty()) {
                            title = extractTitleFromContent(content);
                        }

                        if (info.cwd == null && !content.isEmpty()) {
                            info.cwd = extractCwdFromContent(content);
                        }
                    } catch (Exception ignored) {
                    }
                }
            }
        } catch (Exception e) {
            LOG.debug("[GeminiHistoryReader] Error reading transcript for " + sessionId + ": " + e.getMessage());
        }

        if (title == null || title.trim().isEmpty()) {
            title = "Gemini session " + sessionId.substring(0, Math.min(8, sessionId.length()));
        }

        info.title = truncate(title.trim(), MAX_TITLE_CHARS);
        info.messageCount = Math.max(messageCount, 0);
        info.firstTimestamp = firstTime > 0 ? firstTime : mtime;
        info.lastTimestamp = mtime > 0 ? mtime : (firstTime > 0 ? firstTime : System.currentTimeMillis());

        return info;
    }

    private String extractTitleFromContent(String content) {
        Matcher matcher = USER_REQUEST_PATTERN.matcher(content);
        if (matcher.find()) {
            String req = matcher.group(1).trim();
            if (!req.isEmpty()) {
                return req;
            }
        }
        // Remove XML-like tags if user request tag is not matched
        String clean = content.replaceAll("<[^>]+>", "").trim();
        return clean.isEmpty() ? content.trim() : clean;
    }

    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        Path sessionDir = brainRoot.resolve(sessionId);
        if (!Files.isDirectory(sessionDir)) {
            LOG.warn("[GeminiHistoryReader] Session dir not found for id=" + sessionId);
            return List.of();
        }
        Path transcriptPath = sessionDir.resolve(".system_generated").resolve("logs").resolve("transcript.jsonl");
        if (!Files.isRegularFile(transcriptPath)) {
            transcriptPath = sessionDir.resolve(".system_generated").resolve("logs").resolve("transcript_full.jsonl");
        }
        if (!Files.isRegularFile(transcriptPath)) {
            return List.of();
        }
        return parseTranscriptToMessages(transcriptPath);
    }

    public String getSessionMessagesAsJson(String sessionId) {
        try {
            List<JsonObject> messages = getSessionMessages(sessionId, null);
            return gson.toJson(messages);
        } catch (Exception e) {
            LOG.error("[GeminiHistoryReader] Failed to get session messages as JSON: " + e.getMessage(), e);
            return "[]";
        }
    }

    List<JsonObject> parseTranscriptToMessages(Path transcriptPath) throws IOException {
        List<JsonObject> messages = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(transcriptPath, StandardCharsets.UTF_8)) {
            String line;
            int counter = 0;
            String lastToolCallId = null;

            while ((line = reader.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty() || !line.startsWith("{")) {
                    continue;
                }
                JsonObject obj;
                try {
                    obj = JsonParser.parseString(line).getAsJsonObject();
                } catch (Exception e) {
                    continue;
                }
                String type = obj.has("type") && !obj.get("type").isJsonNull() ? obj.get("type").getAsString() : "";
                int stepIndex = obj.has("step_index") && obj.get("step_index").isJsonPrimitive() ? obj.get("step_index").getAsInt() : (++counter);

                if ("USER_INPUT".equals(type)) {
                    String rawContent = obj.has("content") && !obj.get("content").isJsonNull() ? obj.get("content").getAsString() : "";
                    String userText = extractTitleFromContent(rawContent);
                    if (!userText.isBlank()) {
                        messages.add(buildUserTextMessage(userText, "gemini-user-" + stepIndex));
                    }
                } else if ("PLANNER_RESPONSE".equals(type)) {
                    if (obj.has("content") && !obj.get("content").isJsonNull()) {
                        String assistantText = obj.get("content").getAsString();
                        if (!assistantText.isBlank()) {
                            messages.add(buildAssistantTextMessage(assistantText, "gemini-assistant-" + stepIndex));
                        }
                    }
                    if (obj.has("tool_calls") && obj.get("tool_calls").isJsonArray()) {
                        com.google.gson.JsonArray toolCalls = obj.getAsJsonArray("tool_calls");
                        for (int i = 0; i < toolCalls.size(); i++) {
                            com.google.gson.JsonElement el = toolCalls.get(i);
                            if (!el.isJsonObject()) {
                                continue;
                            }
                            JsonObject call = el.getAsJsonObject();
                            String toolName = call.has("name") && !call.get("name").isJsonNull() ? call.get("name").getAsString() : "tool";
                            JsonObject input = call.has("args") && call.get("args").isJsonObject() ? call.getAsJsonObject("args") : new JsonObject();
                            String callId = "gemini-tool-" + stepIndex + "-" + i;
                            lastToolCallId = callId;
                            messages.add(buildToolUseMessage(callId, toolName, input));
                        }
                    }
                } else if (!"USER_INPUT".equals(type) && !"PLANNER_RESPONSE".equals(type) && !"CHECKPOINT".equals(type) && !"CONVERSATION_HISTORY".equals(type)) {
                    // Tool output or system event
                    if (obj.has("content") && !obj.get("content").isJsonNull()) {
                        String toolOutput = obj.get("content").getAsString();
                        if (!toolOutput.isBlank()) {
                            String callId = lastToolCallId != null ? lastToolCallId : "gemini-tool-" + stepIndex;
                            messages.add(buildToolResultMessage(callId, truncate(toolOutput, 20_000)));
                        }
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
        com.google.gson.JsonArray content = new com.google.gson.JsonArray();
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
        com.google.gson.JsonArray content = new com.google.gson.JsonArray();
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
        com.google.gson.JsonArray content = new com.google.gson.JsonArray();
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
        com.google.gson.JsonArray content = new com.google.gson.JsonArray();
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

    private String extractCwdFromContent(String content) {
        if (!content.contains("<user_information>") && !content.contains("active workspaces")) {
            return null;
        }
        String[] lines = content.split("\n");
        for (String l : lines) {
            if (l.contains(" -> ") && l.trim().startsWith("/")) {
                String candidate = l.split(" -> ")[0].trim();
                if (candidate.startsWith("/")) {
                    return candidate;
                }
            }
        }
        return null;
    }

    public boolean deleteSession(String sessionId) throws IOException {
        if (sessionId == null || sessionId.trim().isEmpty() || sessionId.contains("..") || sessionId.contains("/") || sessionId.contains("\\")) {
            return false;
        }
        Path targetDir = brainRoot.resolve(sessionId);
        if (!Files.isDirectory(targetDir)) {
            return false;
        }
        deleteRecursively(targetDir);
        return !Files.exists(targetDir);
    }

    private void deleteRecursively(Path path) throws IOException {
        if (Files.isDirectory(path)) {
            try (DirectoryStream<Path> entries = Files.newDirectoryStream(path)) {
                for (Path entry : entries) {
                    deleteRecursively(entry);
                }
            }
        }
        Files.deleteIfExists(path);
    }

    private static long fileMtimeMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private static long parseIso8601Millis(String str) {
        try {
            return java.time.Instant.parse(str).toEpochMilli();
        } catch (Exception e) {
            return 0L;
        }
    }

    private static String truncate(String str, int maxLen) {
        if (str == null) {
            return "";
        }
        if (str.length() <= maxLen) {
            return str;
        }
        return str.substring(0, maxLen) + "...";
    }

    private static String normalizePath(String path) {
        if (path == null) {
            return "";
        }
        String p = path.replace('\\', '/').trim();
        while (p.endsWith("/") && p.length() > 1) {
            p = p.substring(0, p.length() - 1);
        }
        return p.toLowerCase(Locale.ROOT);
    }

    private static boolean pathsMatch(String p1, String p2) {
        return p1.equals(p2) || p1.startsWith(p2 + "/") || p2.startsWith(p1 + "/");
    }
}
