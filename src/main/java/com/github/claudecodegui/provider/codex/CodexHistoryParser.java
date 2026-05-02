package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.util.TagExtractor;
import com.github.claudecodegui.util.TextSanitizer;
import com.google.gson.Gson;
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
import java.util.Locale;

/**
 * Parses Codex history session files into DTOs used by the facade and collaborators.
 */
class CodexHistoryParser {

    private static final Logger LOG = Logger.getInstance(CodexHistoryParser.class);

    private final Gson gson;
    private static final String AGENT_ROLE_SECTION_MARKER = "## Agent Role and Instructions";
    private static final int MIN_MEANINGFUL_INPUT_CHARS = 8;

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
        String fallback = null;
        for (int i = messages.size() - 1; i >= 0; i--) {
            CodexHistoryReader.CodexMessage msg = messages.get(i);
            if (!"event_msg".equals(msg.type) || msg.payload == null) {
                continue;
            }
            String title = extractUserMessageTitle(msg.payload);
            if (title != null) {
                if (fallback == null) {
                    fallback = title;
                }
                if (isMeaningfulTitle(title)) {
                    return title;
                }
            }
        }
        return fallback;
    }

    boolean isValidSession(CodexHistoryReader.SessionInfo session) {
        if (session.title == null || session.title.isEmpty()) {
            return false;
        }

        return session.messageCount >= 1;
    }

    /**
     * Extract the first user message title from a single message payload.
     * Returns the truncated title or null if payload is not a user_message.
     */
    String extractUserMessageTitle(JsonObject payload) {
        if (payload == null) {
            return null;
        }
        if (!payload.has("type") || !"user_message".equals(payload.get("type").getAsString())) {
            return null;
        }
        if (!payload.has("message")) {
            return null;
        }
        String text = payload.get("message").getAsString();
        if (text == null || text.isEmpty()) {
            return null;
        }
        // Strip system/instruction tags that the Codex SDK prepends to user messages.
        // These contain AGENTS.md content and should not appear in titles.
        text = stripSystemTags(text);
        text = TagExtractor.extractCommandMessageContent(text);
        return TextSanitizer.sanitizeAndTruncateSingleLine(text, 45);
    }

    private boolean isMeaningfulTitle(String title) {
        String normalized = normalizeShortInput(title);
        if (normalized.isEmpty()) {
            return false;
        }
        if (isContinuationLikeInput(normalized)) {
            return false;
        }
        return normalized.codePointCount(0, normalized.length()) >= MIN_MEANINGFUL_INPUT_CHARS;
    }

    private boolean isContinuationLikeInput(String normalized) {
        if (normalized.isEmpty()) {
            return false;
        }
        return "continue".equals(normalized)
                || "goon".equals(normalized)
                || "/continue".equals(normalized)
                || normalized.startsWith("继续")
                || normalized.startsWith("接着")
                || normalized.startsWith("然后")
                || normalized.startsWith("下一步");
    }

    private String normalizeShortInput(String input) {
        return input
                .toLowerCase(Locale.ROOT)
                .replaceAll("[\\s\\p{Punct}，。！？；：、“”‘’（）【】《》…]+", "")
                .trim();
    }

    /**
     * Remove known system/instruction XML tag blocks from text.
     * Codex prepends &lt;agents-instructions&gt; blocks to user messages containing
     * AGENTS.md content; these should be stripped before title extraction.
     */
    static String stripSystemTags(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }
        String[] systemTags = {"agents-instructions", "system-reminder", "system-prompt"};
        String result = text;
        for (String tag : systemTags) {
            result = removeTagBlock(result, tag);
        }
        int markerIndex = result.indexOf(AGENT_ROLE_SECTION_MARKER);
        if (markerIndex >= 0) {
            result = result.substring(0, markerIndex);
        }
        return result.trim();
    }

    /**
     * Remove a complete XML tag block (opening tag through closing tag) from text.
     */
    private static String removeTagBlock(String text, String tagName) {
        String openTag = "<" + tagName + ">";
        String closeTag = "</" + tagName + ">";
        int start = text.indexOf(openTag);
        if (start == -1) {
            return text;
        }
        int end = text.indexOf(closeTag, start);
        if (end == -1) {
            return text;
        }
        return text.substring(0, start) + text.substring(end + closeTag.length());
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
