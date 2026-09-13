package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.provider.common.SessionLiteReader;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Codex-specific lite session reader.
 * Extracts metadata from Codex JSONL session files using lite-read strategy.
 */
public class CodexSessionLiteReader {

    private static final Pattern THREAD_ID_PATTERN = Pattern.compile(
            "^thread_[a-zA-Z0-9]{10,}$"
    );

    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE
    );

    private static final Pattern UUID_IN_NAME_PATTERN = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            Pattern.CASE_INSENSITIVE
    );

    private final SessionLiteReader liteReader;
    private final CodexHistoryParser parser;
    private final Gson gson;

    public CodexSessionLiteReader() {
        this.liteReader = new SessionLiteReader();
        this.parser = new CodexHistoryParser();
        this.gson = new Gson();
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

        return this.parseSessionInfoFromLite(sessionId, lite);
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
        if (lite == null || sessionId == null) {
            return null;
        }

        JsonObject sessionMeta = CodexSessionMetadata.findSessionMetaPayload(lite.head);
        if (CodexSessionMetadata.isSubagent(sessionMeta)) {
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

        // Title from the first visible user prompt (event_msg or response_item).
        String summary = this.extractFirstUserMessageTitle(lite.head);

        // Skip sessions with no title
        if (summary == null || summary.isEmpty()) {
            return null;
        }

        // Count response_item messages (approximate from head)
        int messageCount = this.countResponseItems(lite.head);

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
     * Extracts the first visible user prompt title from event_msg or response_item lines.
     */
    private String extractFirstUserMessageTitle(String head) {
        int start = 0;
        while (start < head.length()) {
            int newlineIdx = head.indexOf('\n', start);
            String line = newlineIdx >= 0 ? head.substring(start, newlineIdx) : head.substring(start);
            start = newlineIdx >= 0 ? newlineIdx + 1 : head.length();
            if (line.isBlank()) {
                continue;
            }
            try {
                CodexHistoryReader.CodexMessage msg = this.gson.fromJson(line, CodexHistoryReader.CodexMessage.class);
                String title = this.parser.extractVisibleUserTitle(msg);
                if (title != null && !title.isEmpty()) {
                    return title;
                }
            } catch (Exception ignored) {
                // Truncated or malformed head lines are skipped; full parse is the fallback.
            }
        }
        return null;
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

    /**
     * Extracts session ID from file name.
     * Codex CLI writes {@code rollout-<timestamp>-<uuid>.jsonl}; session_meta.id
     * later overrides this when present.
     */
    private String extractSessionId(String fileName) {
        if (!fileName.endsWith(".jsonl")) {
            return null;
        }
        String sessionId = fileName.substring(0, fileName.length() - 6);

        if (UUID_PATTERN.matcher(sessionId).matches() || THREAD_ID_PATTERN.matcher(sessionId).matches()) {
            return sessionId;
        }

        if (sessionId.startsWith("rollout-")) {
            Matcher uuidInName = UUID_IN_NAME_PATTERN.matcher(sessionId);
            if (uuidInName.find()) {
                return uuidInName.group();
            }
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
