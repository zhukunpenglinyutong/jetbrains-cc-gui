package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.github.claudecodegui.util.TagExtractor;
import com.github.claudecodegui.util.TextSanitizer;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * Parses Codex history session files into DTOs used by the facade and collaborators.
 */
class CodexHistoryParser {

    private static final Logger LOG = Logger.getInstance(CodexHistoryParser.class);

    private final Gson gson;

    CodexHistoryParser() {
        this(new Gson());
    }

    CodexHistoryParser(Gson gson) {
        this.gson = gson;
    }

    CodexHistoryReader.SessionInfo parseSessionFile(Path sessionFile) throws IOException {
        CodexHistoryReader.SessionInfo session = new CodexHistoryReader.SessionInfo();

        // Default: derive sessionId from filename; prefer session_meta.id when available
        // to match the thread ID the Codex SDK sends to the frontend via setSessionId.
        String fileName = sessionFile.getFileName().toString();
        session.sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));

        List<CodexHistoryReader.CodexMessage> messages = new ArrayList<>();
        int messageCount = 0;

        try (BufferedReader reader = Files.newBufferedReader(sessionFile, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }

                try {
                    CodexHistoryReader.CodexMessage msg = this.gson.fromJson(line, CodexHistoryReader.CodexMessage.class);
                    if (msg == null) {
                        continue;
                    }

                    messages.add(msg);

                    if ("session_meta".equals(msg.type) && msg.payload != null) {
                        if (CodexSessionMetadata.isSubagent(msg.payload)) {
                            return null;
                        }
                        // Use session_meta.id as the canonical session ID.
                        // This matches the thread_id the Codex SDK returns via [THREAD_ID],
                        // ensuring custom titles saved under this ID are found when loading history.
                        if (msg.payload.has("id") && !msg.payload.get("id").isJsonNull()) {
                            String metaId = msg.payload.get("id").getAsString();
                            if (metaId != null && !metaId.isEmpty()) {
                                session.sessionId = metaId;
                            }
                        }

                        if (msg.payload.has("cwd")) {
                            session.cwd = TextSanitizer.sanitizeInvalidSurrogates(msg.payload.get("cwd").getAsString());
                        }

                        if (msg.payload.has("timestamp")) {
                            String ts = msg.payload.get("timestamp").getAsString();
                            session.firstTimestamp = parseTimestamp(ts);
                            session.lastTimestamp = session.firstTimestamp;
                        }
                    }

                    if ("response_item".equals(msg.type)) {
                        messageCount++;
                    }

                    if (msg.timestamp != null) {
                        long ts = parseTimestamp(msg.timestamp);
                        if (ts > session.lastTimestamp) {
                            session.lastTimestamp = ts;
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

    String generateTitle(List<CodexHistoryReader.CodexMessage> messages) {
        for (CodexHistoryReader.CodexMessage msg : messages) {
            String title = extractVisibleUserTitle(msg);
            if (title != null) {
                return title;
            }
        }
        return null;
    }

    /**
     * Title from a user-visible prompt. Codex 0.148+ CLI rollouts often persist the
     * prompt only as {@code response_item}/{@code role=user}; older files still use
     * {@code event_msg}/{@code user_message}. Instruction dumps are skipped.
     */
    String extractVisibleUserTitle(CodexHistoryReader.CodexMessage msg) {
        if (msg == null || msg.payload == null || msg.type == null) {
            return null;
        }
        String text;
        if ("event_msg".equals(msg.type)) {
            text = extractEventMsgUserText(msg.payload);
        } else if ("response_item".equals(msg.type)) {
            text = extractResponseItemUserText(msg.payload);
        } else {
            return null;
        }
        return toTitle(text);
    }

    boolean isValidSession(CodexHistoryReader.SessionInfo session) {
        if (session.title == null || session.title.isEmpty()) {
            return false;
        }

        return session.messageCount >= 1;
    }

    private String extractEventMsgUserText(JsonObject payload) {
        if (payload == null || !payload.has("type") || payload.get("type").isJsonNull()) {
            return null;
        }
        if (!"user_message".equals(payload.get("type").getAsString())) {
            return null;
        }
        if (!payload.has("message") || payload.get("message").isJsonNull()) {
            return null;
        }
        return payload.get("message").getAsString();
    }

    private String extractResponseItemUserText(JsonObject payload) {
        if (payload == null || !payload.has("type") || payload.get("type").isJsonNull()) {
            return null;
        }
        if (!"message".equals(payload.get("type").getAsString())) {
            return null;
        }
        if (!payload.has("role") || payload.get("role").isJsonNull()
                || !"user".equals(payload.get("role").getAsString())) {
            return null;
        }
        if (!payload.has("content")) {
            return null;
        }
        return flattenUserContent(payload.get("content"));
    }

    private String flattenUserContent(JsonElement content) {
        if (content == null || content.isJsonNull()) {
            return null;
        }
        if (content.isJsonPrimitive()) {
            return content.getAsString();
        }
        if (!content.isJsonArray()) {
            return null;
        }
        JsonArray items = content.getAsJsonArray();
        StringBuilder text = new StringBuilder();
        for (JsonElement item : items) {
            if (item == null || !item.isJsonObject()) {
                continue;
            }
            JsonObject block = item.getAsJsonObject();
            if (!block.has("type") || block.get("type").isJsonNull() || !block.has("text")) {
                continue;
            }
            String type = block.get("type").getAsString();
            if (!"input_text".equals(type) && !"text".equals(type)) {
                continue;
            }
            if (block.get("text").isJsonNull()) {
                continue;
            }
            if (text.length() > 0) {
                text.append('\n');
            }
            text.append(block.get("text").getAsString());
        }
        return text.length() == 0 ? null : text.toString();
    }

    private String toTitle(String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        // Strip system/instruction tags that Codex prepends to user messages.
        // These contain AGENTS.md / skill dumps and should not appear in titles.
        text = CodexMessageConverter.stripSystemTags(text);
        if (text == null || text.isEmpty()) {
            return null;
        }
        if (CodexMessageConverter.isSystemMessage(text)) {
            return null;
        }
        text = TagExtractor.extractCommandMessageContent(text);
        String title = TextSanitizer.sanitizeAndTruncateSingleLine(text, 45);
        if (title == null || title.isEmpty()) {
            return null;
        }
        return title;
    }

    long parseTimestamp(String timestamp) {
        try {
            return Instant.parse(timestamp).toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Check if a file is non-empty. Shared across index and aggregation services.
     */
    static boolean isNonEmptyFile(Path path) {
        try {
            return Files.size(path) > 0;
        } catch (IOException e) {
            return false;
        }
    }
}
