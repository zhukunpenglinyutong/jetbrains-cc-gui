package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.util.TagExtractor;
import com.github.claudecodegui.util.TextSanitizer;
import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.nio.file.NoSuchFileException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;

/**
 * Handles parsing of Claude session JSONL files.
 * Pure parsing logic with no external state dependencies.
 */
class ClaudeHistoryParser {

    private static final Logger LOG = Logger.getInstance(ClaudeHistoryParser.class);

    private final Gson gson = new Gson();
    private final BiConsumer<Path, Exception> scanFailureReporter;

    ClaudeHistoryParser() {
        this(ClaudeHistoryParser::logRecoverableScanFailure);
    }

    ClaudeHistoryParser(BiConsumer<Path, Exception> scanFailureReporter) {
        this.scanFailureReporter = scanFailureReporter;
    }

    /**
     * Scan a single session file and return a SessionInfo.
     */
    ClaudeHistoryReader.SessionInfo scanSingleSession(Path path) {
        try (BufferedReader reader = Files.newBufferedReader(path, java.nio.charset.StandardCharsets.UTF_8)) {
            String fileName = path.getFileName().toString();
            String sessionId = fileName.substring(0, fileName.lastIndexOf(".jsonl"));

            List<ClaudeHistoryReader.ConversationMessage> messages = new ArrayList<>();
            String line;

            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) continue;

                try {
                    ClaudeHistoryReader.ConversationMessage msg = this.gson.fromJson(line, ClaudeHistoryReader.ConversationMessage.class);
                    if (msg != null) {
                        messages.add(msg);
                    }
                } catch (Exception e) {
                    // Skip parse errors
                }
            }

            if (messages.isEmpty()) {
                return null;
            }

            String summary = generateSummary(messages);

            long lastTimestamp = 0;
            for (ClaudeHistoryReader.ConversationMessage msg : messages) {
                if (msg.timestamp != null) {
                    try {
                        long ts = parseTimestamp(msg.timestamp);
                        if (ts > lastTimestamp) {
                            lastTimestamp = ts;
                        }
                    } catch (Exception e) {
                        // Ignore
                    }
                }
            }

            if (!isValidSession(sessionId, summary, messages.size())) {
                return null;
            }

            ClaudeHistoryReader.SessionInfo session = new ClaudeHistoryReader.SessionInfo();
            session.sessionId = sessionId;
            session.title = summary;
            session.messageCount = messages.size();
            session.lastTimestamp = lastTimestamp;
            session.firstTimestamp = lastTimestamp;

            return session;
        } catch (Exception e) {
            this.scanFailureReporter.accept(path, e);
            return null;
        }
    }

    private static void logRecoverableScanFailure(Path path, Exception e) {
        if (e instanceof NoSuchFileException) {
            LOG.debug("[ClaudeHistoryReader] Session disappeared during scan: " + path);
            return;
        }

        LOG.warn("[ClaudeHistoryReader] Skipping unreadable session during scan: " + path + " (" + e.getMessage() + ")");
    }

    /**
     * Generate a summary from conversation messages.
     */
    String generateSummary(List<ClaudeHistoryReader.ConversationMessage> messages) {
        for (ClaudeHistoryReader.ConversationMessage msg : messages) {
            if ("user".equals(msg.type) &&
                        (msg.isMeta == null || !msg.isMeta) &&
                        msg.message != null &&
                        msg.message.content != null) {

                String text = extractTextFromContent(msg.message.content);
                if (text != null && !text.isEmpty()) {
                    text = TagExtractor.extractCommandMessageContent(text);
                    text = TextSanitizer.sanitizeAndTruncateSingleLine(text, 45);
                    return text;
                }
            }
        }
        return null;
    }

    /**
     * Check if a session is valid (not an agent file, not warmup, etc.).
     */
    boolean isValidSession(String sessionId, String summary, int messageCount) {
        if (sessionId != null && sessionId.startsWith("agent-")) {
            return false;
        }

        if (summary == null || summary.isEmpty()) {
            return false;
        }

        String lowerSummary = summary.toLowerCase();
        if (lowerSummary.equals("warmup") ||
                    lowerSummary.equals("no prompt") ||
                    lowerSummary.startsWith("warmup") ||
                    lowerSummary.startsWith("no prompt")) {
            return false;
        }

        return messageCount >= 2;
    }

    /**
     * Extract text from message content (handles String, List, and JsonArray types).
     */
    String extractTextFromContent(Object content) {
        if (content instanceof String) {
            return (String) content;
        } else if (content instanceof List) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> contentList = (List<Map<String, Object>>) content;
            StringBuilder sb = new StringBuilder();

            for (Map<String, Object> item : contentList) {
                String type = (String) item.get("type");

                if ("text".equals(type)) {
                    Object text = item.get("text");
                    if (text instanceof String) {
                        if (sb.length() > 0) {
                            sb.append(" ");
                        }
                        sb.append((String) text);
                    }
                }
            }

            String result = sb.toString().trim();
            return result.isEmpty() ? null : result;
        } else if (content instanceof com.google.gson.JsonArray contentArray) {
            StringBuilder sb = new StringBuilder();

            for (int i = 0; i < contentArray.size(); i++) {
                com.google.gson.JsonElement element = contentArray.get(i);
                if (element.isJsonObject()) {
                    com.google.gson.JsonObject item = element.getAsJsonObject();

                    String type = item.has("type") && !item.get("type").isJsonNull()
                                          ? item.get("type").getAsString()
                                          : null;

                    if ("text".equals(type) && item.has("text") && !item.get("text").isJsonNull()) {
                        if (sb.length() > 0) {
                            sb.append(" ");
                        }
                        sb.append(item.get("text").getAsString());
                    }
                }
            }

            String result = sb.toString().trim();
            return result.isEmpty() ? null : result;
        }

        return null;
    }

    /**
     * Parse an ISO timestamp string to epoch milliseconds.
     */
    long parseTimestamp(String timestamp) {
        try {
            java.time.Instant instant = java.time.Instant.parse(timestamp);
            return instant.toEpochMilli();
        } catch (Exception e) {
            return 0;
        }
    }
}
