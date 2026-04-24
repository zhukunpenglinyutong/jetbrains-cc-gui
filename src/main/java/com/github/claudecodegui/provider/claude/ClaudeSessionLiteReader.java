package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.SessionLiteReader;
import com.intellij.openapi.diagnostic.Logger;

import java.nio.file.Path;
import java.util.regex.Pattern;

/**
 * Claude-specific lite session reader.
 * Extracts metadata from Claude JSONL session files using lite-read strategy.
 */
public class ClaudeSessionLiteReader {

    private static final Logger LOG = Logger.getInstance(ClaudeSessionLiteReader.class);

    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
            Pattern.CASE_INSENSITIVE
    );

    private final SessionLiteReader liteReader;

    public ClaudeSessionLiteReader() {
        this.liteReader = new SessionLiteReader();
    }

    /**
     * Claude session info extracted via lite-read.
     */
    public static class ClaudeLiteSessionInfo {
        public final String sessionId;
        public final String summary;
        public final long lastModified;
        public final long fileSize;
        public final String customTitle;
        public final String firstPrompt;
        public final int messageCount;
        public final long createdAt;

        public ClaudeLiteSessionInfo(
                String sessionId,
                String summary,
                long lastModified,
                long fileSize,
                String customTitle,
                String firstPrompt,
                int messageCount,
                long createdAt
        ) {
            this.sessionId = sessionId;
            this.summary = summary;
            this.lastModified = lastModified;
            this.fileSize = fileSize;
            this.customTitle = customTitle;
            this.firstPrompt = firstPrompt;
            this.messageCount = messageCount;
            this.createdAt = createdAt;
        }
    }

    /**
     * Reads a Claude session file and extracts metadata using lite-read.
     *
     * @param sessionPath the path to the session JSONL file
     * @return ClaudeLiteSessionInfo or null if should be filtered
     */
    public ClaudeLiteSessionInfo readSessionLite(Path sessionPath) {
        SessionLiteReader.LiteSessionFile lite = this.liteReader.readSessionLite(sessionPath);
        if (lite == null) {
            return null;
        }

        String fileName = sessionPath.getFileName().toString();
        String sessionId = this.extractSessionId(fileName);
        if (sessionId == null) {
            return null;
        }

        // Skip sidechain sessions
        if (this.liteReader.isSidechainSession(lite.head)) {
            return null;
        }

        return this.parseSessionInfoFromLite(sessionId, lite);
    }

    /**
     * Parses SessionInfo fields from a lite session read (head/tail/stat).
     * Returns null for sidechain sessions or metadata-only sessions with no extractable summary.
     *
     * @param sessionId the session ID
     * @param lite      the lite session file data
     * @return ClaudeLiteSessionInfo or null
     */
    public ClaudeLiteSessionInfo parseSessionInfoFromLite(
            String sessionId,
            SessionLiteReader.LiteSessionFile lite
    ) {
        if (lite == null || sessionId == null) {
            return null;
        }

        // Extract title: customTitle wins over aiTitle (same as CLI)
        // CLI merges customTitle and aiTitle into one variable for priority
        String userTitle = this.liteReader.extractLastJsonStringField(lite.tail, "customTitle");
        if (userTitle == null) {
            userTitle = this.liteReader.extractLastJsonStringField(lite.head, "customTitle");
        }
        if (userTitle == null) {
            userTitle = this.liteReader.extractLastJsonStringField(lite.tail, "aiTitle");
        }
        if (userTitle == null) {
            userTitle = this.liteReader.extractLastJsonStringField(lite.head, "aiTitle");
        }

        String firstPrompt = this.liteReader.extractFirstPromptFromHead(lite.head);

        // Extract last-prompt from tail (captured at write time)
        String lastPrompt = this.liteReader.extractLastJsonStringField(lite.tail, "lastPrompt");

        // Summary priority: userTitle > lastPrompt > summary > firstPrompt (same as CLI)
        String summary = userTitle;
        if (summary == null) {
            summary = lastPrompt;
        }
        if (summary == null) {
            summary = this.liteReader.extractLastJsonStringField(lite.tail, "summary");
        }
        if (summary == null) {
            summary = firstPrompt;
        }

        // Skip metadata-only sessions (no title, no summary, no prompt)
        if (summary == null || summary.isEmpty()) {
            return null;
        }

        // Skip invalid sessions (agent files, warmup, etc.)
        if (!this.isValidSession(sessionId, summary)) {
            return null;
        }

        // Extract first timestamp for createdAt
        String firstTimestamp = this.liteReader.extractJsonStringField(lite.head, "timestamp");
        long createdAt = 0;
        if (firstTimestamp != null) {
            try {
                createdAt = this.parseTimestamp(firstTimestamp);
            } catch (Exception e) {
                // Ignore invalid timestamp
            }
        }

        // Count messages in head (approximation)
        int messageCount = this.liteReader.countMessagesInHead(lite.head);

        return new ClaudeLiteSessionInfo(
                sessionId,
                summary,
                lite.mtime,
                lite.size,
                userTitle,
                firstPrompt,
                messageCount,
                createdAt
        );
    }

    /**
     * Extracts session ID from file name (UUID validation).
     *
     * @param fileName the file name (e.g., "abc123.jsonl")
     * @return validated session ID or null
     */
    private String extractSessionId(String fileName) {
        if (!fileName.endsWith(".jsonl")) {
            return null;
        }
        String sessionId = fileName.substring(0, fileName.length() - 6);
        if (!UUID_PATTERN.matcher(sessionId).matches()) {
            return null;
        }
        return sessionId.toLowerCase();
    }

    /**
     * Check if a session is valid (not an agent file, not warmup, etc.).
     */
    private boolean isValidSession(String sessionId, String summary) {
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

        return true;
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