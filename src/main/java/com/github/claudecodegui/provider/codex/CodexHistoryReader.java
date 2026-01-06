package com.github.claudecodegui.provider.codex;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Codex local history reader.
 * Reads Codex CLI session history from ~/.codex/sessions directory.
 */
public class CodexHistoryReader {

    private static final Logger LOG = Logger.getInstance(CodexHistoryReader.class);

    private static final String HOME_DIR = System.getProperty("user.home");
    private static final Path CODEX_SESSIONS_DIR = Paths.get(HOME_DIR, ".codex", "sessions");

    private final Gson gson = new Gson();

    /**
     * Session info.
     */
    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
    }

    /**
     * Codex message format.
     */
    public static class CodexMessage {
        public String timestamp;
        public String type;
        public JsonObject payload;
    }

    /**
     * Read all Codex sessions.
     * Returns all sessions regardless of project.
     */
    public List<SessionInfo> readAllSessions() throws IOException {
        List<SessionInfo> sessions = new ArrayList<>();

        if (!Files.exists(CODEX_SESSIONS_DIR) || !Files.isDirectory(CODEX_SESSIONS_DIR)) {
            LOG.info("[CodexHistoryReader] Codex sessions directory not found: " + CODEX_SESSIONS_DIR);
            return sessions;
        }

        try (Stream<Path> paths = Files.walk(CODEX_SESSIONS_DIR)) {
            List<Path> jsonlFiles = paths
                .filter(Files::isRegularFile)
                .filter(path -> path.toString().endsWith(".jsonl"))
                .filter(path -> {
                    try {
                        return Files.size(path) > 0;
                    } catch (IOException e) {
                        return false;
                    }
                })
                .collect(Collectors.toList());

            LOG.info("[CodexHistoryReader] Found " + jsonlFiles.size() + " Codex session files");

            for (Path sessionFile : jsonlFiles) {
                try {
                    SessionInfo session = parseSessionFile(sessionFile);
                    if (session != null && isValidSession(session)) {
                        sessions.add(session);
                    }
                } catch (Exception e) {
                    LOG.warn("[CodexHistoryReader] Failed to parse session file: " + sessionFile + " - " + e.getMessage());
                }
            }
        }

        sessions.sort((a, b) -> Long.compare(b.lastTimestamp, a.lastTimestamp));

        LOG.info("[CodexHistoryReader] Successfully loaded " + sessions.size() + " valid Codex sessions");
        return sessions;
    }

    /**
     * Parse a single session file.
     */
    private SessionInfo parseSessionFile(Path sessionFile) throws IOException {
        SessionInfo session = new SessionInfo();

        String fileName = sessionFile.getFileName().toString();
        session.sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));

        List<CodexMessage> messages = new ArrayList<>();
        String sessionMeta = null;
        int messageCount = 0;

        try (BufferedReader reader = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;

                try {
                    CodexMessage msg = gson.fromJson(line, CodexMessage.class);
                    if (msg != null) {
                        messages.add(msg);

                        if ("session_meta".equals(msg.type) && msg.payload != null) {
                            sessionMeta = msg.payload.toString();

                            if (msg.payload.has("cwd")) {
                                session.cwd = msg.payload.get("cwd").getAsString();
                            }

                            if (msg.payload.has("timestamp")) {
                                try {
                                    String ts = msg.payload.get("timestamp").getAsString();
                                    session.firstTimestamp = parseTimestamp(ts);
                                    session.lastTimestamp = session.firstTimestamp;
                                } catch (Exception e) {
                                    // Ignore timestamp parse error
                                }
                            }
                        }

                        if ("response_item".equals(msg.type)) {
                            messageCount++;
                        }

                        if (msg.timestamp != null) {
                            try {
                                long ts = parseTimestamp(msg.timestamp);
                                if (ts > session.lastTimestamp) {
                                    session.lastTimestamp = ts;
                                }
                            } catch (Exception e) {
                                // Ignore timestamp parse error
                            }
                        }
                    }
                } catch (Exception e) {
                    LOG.debug("[CodexHistoryReader] Failed to parse line: " + e.getMessage());
                }
            }
        }

        session.messageCount = messageCount;
        session.title = generateTitle(messages);

        return session;
    }

    /**
     * Generate session title.
     * Extracts content from the first user_message event_msg.
     */
    private String generateTitle(List<CodexMessage> messages) {
        for (CodexMessage msg : messages) {
            if ("event_msg".equals(msg.type) && msg.payload != null) {
                JsonObject payload = msg.payload;

                if (payload.has("type") && "user_message".equals(payload.get("type").getAsString())) {
                    if (payload.has("message")) {
                        String text = payload.get("message").getAsString();
                        if (text != null && !text.isEmpty()) {
                            text = text.replace("\n", " ").trim();
                            if (text.length() > 45) {
                                text = text.substring(0, 45) + "...";
                            }
                            return text;
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * Extract text from content.
     */
    private String extractTextFromContent(JsonElement contentElem) {
        if (contentElem == null) {
            return null;
        }

        if (contentElem.isJsonPrimitive()) {
            return contentElem.getAsString();
        }

        if (contentElem.isJsonArray()) {
            JsonArray contentArray = contentElem.getAsJsonArray();
            StringBuilder sb = new StringBuilder();

            for (JsonElement item : contentArray) {
                if (item.isJsonObject()) {
                    JsonObject itemObj = item.getAsJsonObject();

                    if (itemObj.has("type") && "text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append(" ");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    } else if (itemObj.has("type") && "input_text".equals(itemObj.get("type").getAsString())) {
                        if (itemObj.has("text")) {
                            if (sb.length() > 0) {
                                sb.append(" ");
                            }
                            sb.append(itemObj.get("text").getAsString());
                        }
                    }
                }
            }

            String result = sb.toString().trim();
            return result.isEmpty() ? null : result;
        }

        return null;
    }

    /**
     * Check if session is valid.
     */
    private boolean isValidSession(SessionInfo session) {
        if (session.title == null || session.title.isEmpty()) {
            return false;
        }

        if (session.messageCount < 1) {
            return false;
        }

        return true;
    }

    /**
     * Parse timestamp (ISO 8601 format).
     */
    private long parseTimestamp(String timestamp) {
        try {
            java.time.Instant instant = java.time.Instant.parse(timestamp);
            return instant.toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Get all sessions as JSON string.
     */
    public String getAllSessionsAsJson() {
        try {
            List<SessionInfo> sessions = readAllSessions();

            int totalMessages = sessions.stream()
                .mapToInt(s -> s.messageCount)
                .sum();

            Map<String, Object> result = new HashMap<>();
            result.put("success", true);
            result.put("sessions", sessions);
            result.put("total", totalMessages);
            result.put("sessionCount", sessions.size());

            return gson.toJson(result);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Codex sessions: " + e.getMessage());
            return gson.toJson(error);
        }
    }

    /**
     * Check if command is a file/directory viewing operation.
     */
    private boolean isFileViewingCommand(String command) {
        if (command == null || command.isEmpty()) {
            return false;
        }
        String trimmed = command.trim();
        return trimmed.matches("^(pwd|ls|cat|head|tail|tree|file|stat)\\b.*") ||
               trimmed.matches("^sed\\s+-n\\s+.*");
    }

    /**
     * Transform Codex function_call to Claude compatible format.
     * Converts file viewing shell_command to read tool.
     */
    private CodexMessage transformFunctionCall(CodexMessage msg) {
        if (msg == null || !"response_item".equals(msg.type) || msg.payload == null) {
            return msg;
        }

        JsonObject payload = msg.payload;

        if (!payload.has("type") || !"function_call".equals(payload.get("type").getAsString())) {
            return msg;
        }

        if (!payload.has("name") || !"shell_command".equals(payload.get("name").getAsString())) {
            return msg;
        }

        if (!payload.has("arguments")) {
            return msg;
        }

        try {
            String argumentsStr = payload.get("arguments").getAsString();
            JsonObject arguments = gson.fromJson(argumentsStr, JsonObject.class);

            if (arguments != null && arguments.has("command")) {
                String command = arguments.get("command").getAsString();

                if (isFileViewingCommand(command)) {
                    payload.addProperty("name", "read");
                    LOG.debug("[CodexHistoryReader] Transformed shell_command to read for: " + command);
                }
            }
        } catch (Exception e) {
            LOG.debug("[CodexHistoryReader] Failed to parse arguments: " + e.getMessage());
        }

        return msg;
    }

    /**
     * Read a single session's messages.
     */
    public String getSessionMessagesAsJson(String sessionId) {
        try {
            Path sessionFile = findSessionFile(sessionId);
            if (sessionFile == null) {
                LOG.warn("[CodexHistoryReader] Session file not found for: " + sessionId);
                return gson.toJson(new ArrayList<>());
            }

            List<CodexMessage> messages = new ArrayList<>();

            try (BufferedReader reader = Files.newBufferedReader(sessionFile, java.nio.charset.StandardCharsets.UTF_8)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.trim().isEmpty()) continue;

                    try {
                        CodexMessage msg = gson.fromJson(line, CodexMessage.class);
                        if (msg != null) {
                            msg = transformFunctionCall(msg);
                            messages.add(msg);
                        }
                    } catch (Exception e) {
                        LOG.debug("[CodexHistoryReader] Failed to parse message: " + e.getMessage());
                    }
                }
            }

            return gson.toJson(messages);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read session messages: " + e.getMessage(), e);
            return gson.toJson(new ArrayList<>());
        }
    }

    /**
     * Find session file.
     */
    private Path findSessionFile(String sessionId) throws IOException {
        if (!Files.exists(CODEX_SESSIONS_DIR)) {
            return null;
        }

        try (Stream<Path> paths = Files.walk(CODEX_SESSIONS_DIR)) {
            return paths
                .filter(Files::isRegularFile)
                .filter(path -> path.getFileName().toString().startsWith(sessionId))
                .filter(path -> path.toString().endsWith(".jsonl"))
                .findFirst()
                .orElse(null);
        }
    }
}
