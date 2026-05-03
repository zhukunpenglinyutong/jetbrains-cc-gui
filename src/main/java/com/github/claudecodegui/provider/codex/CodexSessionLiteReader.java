package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.util.TagExtractor;
import com.github.claudecodegui.util.HistoryPromptSanitizer;
import com.github.claudecodegui.util.TextSanitizer;
import com.github.claudecodegui.provider.common.SessionLiteReader;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Path;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Codex-specific lite session reader.
 * Extracts metadata from Codex JSONL session files using lite-read strategy.
 */
public class CodexSessionLiteReader {

    private static final Logger LOG = Logger.getInstance(CodexSessionLiteReader.class);

    private static final Pattern THREAD_ID_PATTERN = Pattern.compile(
            "^thread_[a-zA-Z0-9]{10,}$"
    );

    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE
    );
    private static final int MIN_MEANINGFUL_INPUT_CHARS = 8;

    private final SessionLiteReader liteReader;

    public CodexSessionLiteReader() {
        this.liteReader = new SessionLiteReader();
    }

    /**
     * Codex session info extracted via lite-read.
     */
    public static class CodexLiteSessionInfo {
        public final String sessionId;
        public final String summary;
        public final long lastModified;
        public final long fileSize;
        public final int messageCount;
        public final long createdAt;
        public final String cwd;

        public CodexLiteSessionInfo(
                String sessionId,
                String summary,
                long lastModified,
                long fileSize,
                int messageCount,
                long createdAt,
                String cwd
        ) {
            this.sessionId = sessionId;
            this.summary = summary;
            this.lastModified = lastModified;
            this.fileSize = fileSize;
            this.messageCount = messageCount;
            this.createdAt = createdAt;
            this.cwd = cwd;
        }
    }

    /**
     * Reads a Codex session file and extracts metadata using lite-read.
     *
     * @param sessionPath the path to the session JSONL file
     * @return CodexLiteSessionInfo or null if should be filtered
     */
    public CodexLiteSessionInfo readSessionLite(Path sessionPath) {
        SessionLiteReader.LiteSessionFile lite = this.liteReader.readSessionLite(sessionPath);
        if (lite == null) {
            return null;
        }

        String fileName = sessionPath.getFileName().toString();
        String sessionId = this.extractSessionId(fileName);
        if (sessionId == null) {
            return null;
        }

        return this.parseSessionInfoFromLite(sessionId, lite, sessionPath);
    }

    /**
     * Parses SessionInfo fields from a lite session read (head/tail/stat).
     *
     * @param sessionId the default session ID from filename
     * @param lite      the lite session file data
     * @return CodexLiteSessionInfo or null
     */
    public CodexLiteSessionInfo parseSessionInfoFromLite(
            String sessionId,
            SessionLiteReader.LiteSessionFile lite
    ) {
        return parseSessionInfoFromLite(sessionId, lite, null);
    }

    private CodexLiteSessionInfo parseSessionInfoFromLite(
            String sessionId,
            SessionLiteReader.LiteSessionFile lite,
            Path sessionPath
    ) {
        if (lite == null || sessionId == null) {
            return null;
        }

        // Extract session_meta.id if available (preferred over filename)
        String metaId = this.extractSessionMetaId(lite.head);
        if (metaId != null) {
            sessionId = metaId;
        }

        // Extract cwd from session_meta
        String cwd = this.extractSessionMetaField(lite.head, "cwd");

        // Extract timestamp from session_meta for createdAt
        String timestamp = this.extractSessionMetaField(lite.head, "timestamp");
        long createdAt = 0;
        if (timestamp != null) {
            try {
                createdAt = this.parseTimestamp(timestamp);
            } catch (Exception e) {
                // Ignore
            }
        }

        // Extract title from the latest meaningful user message.
        String summary = this.extractLatestMeaningfulUserMessageTitle(lite.head, lite.tail);

        // Skip sessions with no title
        if (summary == null || summary.isEmpty()) {
            return null;
        }

        int messageCount = this.countResponseItemsExactly(sessionPath, lite);

        // Use mtime as lastTimestamp (more reliable than last message timestamp)
        long lastModified = lite.mtime;
        if (createdAt == 0) {
            createdAt = lastModified;
        }

        return new CodexLiteSessionInfo(
                sessionId,
                summary,
                lastModified,
                lite.size,
                messageCount,
                createdAt,
                cwd
        );
    }

    /**
     * Extracts session_meta.id from head chunk.
     */
    private String extractSessionMetaId(String head) {
        // Look for {"type":"session_meta", "payload":{"id":"..."}}
        String[] patterns = {"\"type\":\"session_meta\"", "\"type\": \"session_meta\""};
        for (String pattern : patterns) {
            int idx = head.indexOf(pattern);
            if (idx < 0) {
                continue;
            }

            // Find the payload.id within this line
            int lineEnd = head.indexOf('\n', idx);
            String line = lineEnd >= 0 ? head.substring(idx, lineEnd) : head.substring(idx);

            String id = this.liteReader.extractJsonStringField(line, "id");
            if (id != null && (THREAD_ID_PATTERN.matcher(id).matches() || UUID_PATTERN.matcher(id).matches())) {
                return id;
            }
        }
        return null;
    }

    /**
     * Extracts a field from session_meta payload.
     */
    private String extractSessionMetaField(String head, String field) {
        String[] patterns = {"\"type\":\"session_meta\"", "\"type\": \"session_meta\""};
        for (String pattern : patterns) {
            int idx = head.indexOf(pattern);
            if (idx < 0) {
                continue;
            }

            int lineEnd = head.indexOf('\n', idx);
            String line = lineEnd >= 0 ? head.substring(idx, lineEnd) : head.substring(idx);

            return this.liteReader.extractJsonStringField(line, field);
        }
        return null;
    }

    /**
     * Extracts the latest meaningful user message title from event_msg records.
     * Falls back to the latest available user message if all candidates are shorter than 8 chars.
     */
    private String extractLatestMeaningfulUserMessageTitle(String head, String tail) {
        String fromTail = extractLatestMeaningfulUserMessageTitleFromChunk(tail);
        if (fromTail != null && !fromTail.isEmpty()) {
            return fromTail;
        }
        return extractLatestMeaningfulUserMessageTitleFromChunk(head);
    }

    private String extractLatestMeaningfulUserMessageTitleFromChunk(String chunk) {
        if (chunk == null || chunk.isEmpty()) {
            return null;
        }

        String fallback = null;
        int end = chunk.length();
        while (end > 0) {
            int newlineIdx = chunk.lastIndexOf('\n', end - 1);
            int lineStart = newlineIdx >= 0 ? newlineIdx + 1 : 0;
            String line = chunk.substring(lineStart, end);
            end = newlineIdx >= 0 ? newlineIdx : 0;

            if (line.isEmpty()) {
                continue;
            }
            if (!line.contains("\"type\":\"event_msg\"") && !line.contains("\"type\": \"event_msg\"")) {
                continue;
            }
            if (!line.contains("\"user_message\"")) {
                continue;
            }

            String title = extractUserMessageTitleFromLine(line);
            if (title == null || title.isEmpty()) {
                continue;
            }
            if (fallback == null) {
                fallback = title;
            }
            if (isMeaningfulTitle(title)) {
                return title;
            }
        }

        return fallback;
    }

    private String extractUserMessageTitleFromLine(String line) {
        String message = this.liteReader.extractLastJsonStringField(line, "message");
        if (message == null || message.isEmpty()) {
            return null;
        }

        message = HistoryPromptSanitizer.sanitizeForHistory(message);
        message = TagExtractor.extractCommandMessageContent(message);
        if (message == null || message.isEmpty()) {
            return null;
        }

        // Skip auto-generated patterns
        if (message.startsWith("<") && message.length() > 1) {
            char nextChar = message.charAt(1);
            if (Character.isLowerCase(nextChar)) {
                return null;
            }
        }

        return TextSanitizer.sanitizeAndTruncateSingleLine(message, 45);
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
     * Counts response_item messages in head chunk.
     */
    private int countResponseItems(String head) {
        int count = 0;
        int start = 0;
        while (start < head.length()) {
            int newlineIdx = head.indexOf('\n', start);
            String line = newlineIdx >= 0 ? head.substring(start, newlineIdx) : head.substring(start);
            start = newlineIdx >= 0 ? newlineIdx + 1 : head.length();

            if (line.contains("\"type\":\"response_item\"") || line.contains("\"type\": \"response_item\"")) {
                count++;
            }
        }
        return count;
    }

    private int countResponseItemsExactly(Path sessionPath, SessionLiteReader.LiteSessionFile lite) {
        if (sessionPath != null && lite != null && lite.size > SessionLiteReader.LITE_READ_BUF_SIZE) {
            int exactCount = this.liteReader.countMatchingLines(
                    sessionPath,
                    line -> line != null && (
                            line.contains("\"type\":\"response_item\"") ||
                                    line.contains("\"type\": \"response_item\"")
                    )
            );
            if (exactCount >= 0) {
                return exactCount;
            }
        }

        return lite != null ? this.countResponseItems(lite.head) : 0;
    }

    /**
     * Extracts session ID from file name.
     */
    private String extractSessionId(String fileName) {
        if (!fileName.endsWith(".jsonl")) {
            return null;
        }
        String sessionId = fileName.substring(0, fileName.length() - 6);

        // Validate: must be UUID or thread_xxx format
        Matcher uuidMatcher = UUID_PATTERN.matcher(sessionId);
        Matcher threadMatcher = THREAD_ID_PATTERN.matcher(sessionId);

        if (uuidMatcher.matches() || threadMatcher.matches()) {
            return sessionId;
        }
        return null;
    }

    /**
     * Parse an ISO timestamp string to epoch milliseconds.
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
     * Returns the underlying SessionLiteReader for reuse.
     */
    public SessionLiteReader getLiteReader() {
        return this.liteReader;
    }
}
