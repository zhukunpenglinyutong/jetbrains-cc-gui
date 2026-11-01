package com.github.claudecodegui.provider.gemini;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Loads Gemini subagent completion statuses and child session transcripts from local SQLite databases.
 */
public class GeminiSubagentHistoryLoader {

    public static final long STALE_RUNNING_GRACE_MS = 60_000L;

    private static final Logger LOG = Logger.getInstance(GeminiSubagentHistoryLoader.class);
    private static final String STATUS_COMPLETED = "completed";
    private static final String STATUS_RUNNING = "running";
    private static final Pattern MESSAGE_PATTERN = Pattern.compile(
            "\\[Message\\]\\s+timestamp=\\S+\\s+sender=([^\\s]+)\\s+priority=\\S+\\s+content=(.*)",
            Pattern.DOTALL
    );

    private final Path cliHome;
    private final GeminiHistoryReader historyReader;
    private final long staleRunningGraceMs;

    /**
     * Request descriptor for polling a single Gemini subagent status.
     *
     * @param toolUseId Parent tool use identifier
     * @param agentId Child subagent conversation identifier
     */
    public record StatusRequest(
            /** Parent tool use identifier. */
            String toolUseId,
            /** Child subagent conversation identifier. */
            String agentId
    ) {}

    /**
     * Lightweight status snapshot for a single Gemini subagent.
     *
     * @param toolUseId Parent tool use identifier
     * @param agentId Child subagent conversation identifier
     * @param success Whether the status check succeeded
     * @param status Normalized subagent status string
     * @param completed Whether the subagent has reached a terminal state
     * @param resultText Completion report text from the parent session
     * @param error Error message when resolution fails
     * @param messages Child session messages when requested
     */
    public record StatusResult(
            /** Parent tool use identifier. */
            String toolUseId,
            /** Child subagent conversation identifier. */
            String agentId,
            /** Whether the status check succeeded. */
            boolean success,
            /** Normalized subagent status string. */
            String status,
            /** Whether the subagent has reached a terminal state. */
            boolean completed,
            /** Completion report text from the parent session. */
            String resultText,
            /** Error message when resolution fails. */
            String error,
            /** Child session messages when requested. */
            List<JsonObject> messages
    ) {}

    /**
     * Full session transcript and completion status for a Gemini subagent.
     *
     * @param toolUseId Parent tool use identifier
     * @param agentId Child subagent conversation identifier
     * @param success Whether the session load succeeded
     * @param status Normalized subagent status string
     * @param completed Whether the subagent has reached a terminal state
     * @param resultText Completion report text from the parent session
     * @param error Error message when loading fails
     * @param messages Child session transcript messages
     */
    public record SessionResult(
            /** Parent tool use identifier. */
            String toolUseId,
            /** Child subagent conversation identifier. */
            String agentId,
            /** Whether the session load succeeded. */
            boolean success,
            /** Normalized subagent status string. */
            String status,
            /** Whether the subagent has reached a terminal state. */
            boolean completed,
            /** Completion report text from the parent session. */
            String resultText,
            /** Error message when loading fails. */
            String error,
            /** Child session transcript messages. */
            List<JsonObject> messages
    ) {}

    /**
     * Parsed subagent completion message extracted from a parent step-101 envelope.
     *
     * @param sender Subagent sender identifier
     * @param content Completion message body
     */
    public record CompletionMessage(
            /** Subagent sender identifier. */
            String sender,
            /** Completion message body. */
            String content
    ) {}

    /**
     * Creates a loader using the default history reader and staleness grace period.
     *
     * @param cliHome Gemini CLI home directory
     */
    public GeminiSubagentHistoryLoader(Path cliHome) {
        this(cliHome, new GeminiHistoryReader(cliHome, new Gson()), STALE_RUNNING_GRACE_MS);
    }

    /**
     * Creates a loader using the given history reader and default staleness grace period.
     *
     * @param cliHome Gemini CLI home directory
     * @param historyReader Reader for Gemini conversation databases
     */
    public GeminiSubagentHistoryLoader(Path cliHome, GeminiHistoryReader historyReader) {
        this(cliHome, historyReader, STALE_RUNNING_GRACE_MS);
    }

    /**
     * Creates a loader with a custom staleness grace period for uncompleted child databases.
     *
     * @param cliHome Gemini CLI home directory
     * @param historyReader Reader for Gemini conversation databases
     * @param staleRunningGraceMs Maximum inactivity duration in milliseconds before an uncompleted child is marked completed
     */
    public GeminiSubagentHistoryLoader(Path cliHome, GeminiHistoryReader historyReader, long staleRunningGraceMs) {
        this.cliHome = cliHome;
        this.historyReader = historyReader;
        this.staleRunningGraceMs = staleRunningGraceMs;
    }

    /**
     * Parses a raw step-101 protobuf byte payload into a subagent completion message.
     *
     * @param payload Raw step-101 payload bytes
     * @return parsed completion message, or {@code null} if not a valid subagent completion
     */
    public static CompletionMessage parseCompletionEnvelope(byte[] payload) {
        if (payload == null || payload.length == 0) {
            return null;
        }
        String text = new String(payload, StandardCharsets.UTF_8);
        return parseCompletionEnvelope(text);
    }

    /**
     * Parses a decoded step-101 text envelope into a subagent completion message, preserving multi-line content.
     *
     * @param text Decoded step-101 text envelope
     * @return parsed completion message, or {@code null} if not a valid subagent completion
     */
    public static CompletionMessage parseCompletionEnvelope(String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        int searchFrom = 0;
        while (searchFrom < text.length()) {
            int idx = text.indexOf("[Message] ", searchFrom);
            if (idx < 0) {
                break;
            }
            String candidate = text.substring(idx);
            Matcher matcher = MESSAGE_PATTERN.matcher(candidate);
            if (matcher.matches()) {
                String sender = matcher.group(1);
                String content = matcher.group(2);
                if (sender != null && !sender.contains("/task-") && !sender.startsWith("task-") && content != null) {
                    String cleanContent = stripControlTail(content).trim();
                    if (!cleanContent.isEmpty()) {
                        return new CompletionMessage(sender, cleanContent);
                    }
                }
            }
            searchFrom = idx + "[Message] ".length();
        }
        return null;
    }

    private static String stripControlTail(String content) {
        for (int i = 0; i < content.length(); i++) {
            char c = content.charAt(i);
            if ((c < 0x20 && c != '\r' && c != '\n' && c != '\t') || c == 0x7F) {
                return content.substring(0, i);
            }
        }
        return content;
    }

    /**
     * Loads the latest step-101 completion messages keyed by lowercase sender ID from the parent database.
     *
     * @param parentSessionId Parent conversation session identifier
     * @return map of lowercase subagent sender IDs to their latest completion text
     */
    public Map<String, String> loadParentStep101Completions(String parentSessionId) {
        Map<String, String> completions = new HashMap<>();
        if (!GeminiHistoryReader.isSafeSessionId(parentSessionId)) {
            return completions;
        }
        Path db = cliHome.resolve("conversations").resolve(parentSessionId.trim() + ".db");
        if (!Files.isRegularFile(db)) {
            return completions;
        }
        Connection conn = null;
        Path tempCopy = null;
        try {
            // Copy first: a read-only open of a live WAL database rewrites sidecars.
            tempCopy = historyReader.copyWithSidecarsToTemp(db);
            conn = historyReader.openReadOnlyConnection(tempCopy != null ? tempCopy : db);
            String sql = "SELECT idx, step_payload FROM steps WHERE step_type = 101 OR step_type = '101' ORDER BY idx DESC";
            try (Statement st = conn.createStatement();
                 ResultSet rs = st.executeQuery(sql)) {
                while (rs.next()) {
                    byte[] payload = rs.getBytes("step_payload");
                    CompletionMessage msg = parseCompletionEnvelope(payload);
                    if (msg != null && !msg.sender().isEmpty() && !msg.content().isEmpty()) {
                        completions.putIfAbsent(msg.sender().toLowerCase(), msg.content());
                    }
                }
            }
        } catch (Exception e) {
            LOG.debug("[GeminiSubagentHistoryLoader] Failed to read step 101 from parent " + parentSessionId + ": " + e.getMessage());
        } finally {
            if (conn != null) {
                try {
                    conn.close();
                } catch (SQLException ignored) {
                }
            }
            if (tempCopy != null) {
                GeminiHistoryReader.deleteTempCopy(tempCopy);
            }
        }
        return completions;
    }

    /**
     * Loads lightweight status snapshots for the requested Gemini subagents without reading child message transcripts.
     *
     * @param parentSessionId Parent conversation session identifier
     * @param requests List of subagent status requests to evaluate
     * @return list of lightweight status results in request order
     */
    public List<StatusResult> loadStatuses(String parentSessionId, List<StatusRequest> requests) {
        Map<String, String> completions = parentSessionId != null ? loadParentStep101Completions(parentSessionId) : Map.of();
        List<StatusResult> results = new ArrayList<>(requests.size());
        for (StatusRequest req : requests) {
            String toolUseId = req.toolUseId();
            String agentId = req.agentId();
            if (agentId == null || !GeminiHistoryReader.isSafeSessionId(agentId)) {
                results.add(new StatusResult(toolUseId, agentId, false, "error", false, null, "Invalid agent id", List.of()));
                continue;
            }
            Path childDb = cliHome.resolve("conversations").resolve(agentId + ".db");
            boolean hasChildDb = Files.isRegularFile(childDb);
            String completion = completions.get(agentId.toLowerCase());
            if (completion != null) {
                results.add(new StatusResult(toolUseId, agentId, true, STATUS_COMPLETED, true, completion, null, List.of()));
            } else if (!hasChildDb) {
                results.add(new StatusResult(toolUseId, agentId, false, STATUS_RUNNING, false, null, "Subagent log not found yet", List.of()));
            } else if (isStaleChildDb(childDb)) {
                results.add(new StatusResult(toolUseId, agentId, true, STATUS_COMPLETED, true, null, null, List.of()));
            } else {
                results.add(new StatusResult(toolUseId, agentId, true, STATUS_RUNNING, false, null, null, List.of()));
            }
        }
        return results;
    }

    /**
     * Loads the full transcript and completion status for a single Gemini child subagent session.
     *
     * @param parentSessionId Parent conversation session identifier
     * @param toolUseId Parent tool use identifier
     * @param agentId Child subagent conversation identifier
     * @return full child session result including transcript messages
     */
    public SessionResult loadChildSession(String parentSessionId, String toolUseId, String agentId) {
        if (agentId == null || !GeminiHistoryReader.isSafeSessionId(agentId)) {
            return new SessionResult(toolUseId, agentId, false, "error", false, null, "Invalid agent id", List.of());
        }
        Map<String, String> completions = parentSessionId != null ? loadParentStep101Completions(parentSessionId) : Map.of();
        String completion = completions.get(agentId.toLowerCase());
        Path childDb = cliHome.resolve("conversations").resolve(agentId + ".db");
        if (!Files.isRegularFile(childDb)) {
            if (completion != null) {
                return new SessionResult(toolUseId, agentId, true, STATUS_COMPLETED, true, completion, null, List.of());
            }
            return new SessionResult(toolUseId, agentId, false, STATUS_RUNNING, false, null, "Subagent log not found yet", List.of());
        }
        List<JsonObject> messages;
        try {
            messages = historyReader.getSessionMessages(agentId, null);
        } catch (IOException e) {
            LOG.warn("[GeminiSubagentHistoryLoader] Failed to read session messages for " + agentId + ": " + e.getMessage());
            return new SessionResult(toolUseId, agentId, false, "error", false, null, e.getMessage(), List.of());
        }
        if (completion != null) {
            return new SessionResult(toolUseId, agentId, true, STATUS_COMPLETED, true, completion, null, messages);
        }
        if (isStaleChildDb(childDb)) {
            return new SessionResult(toolUseId, agentId, true, STATUS_COMPLETED, true, null, null, messages);
        }
        return new SessionResult(toolUseId, agentId, true, STATUS_RUNNING, false, null, null, messages);
    }

    private boolean isStaleChildDb(Path childDb) {
        long latestMtime = latestModifiedMillis(childDb);
        if (latestMtime <= 0L) {
            return false;
        }
        return System.currentTimeMillis() - latestMtime > staleRunningGraceMs;
    }

    private static long latestModifiedMillis(Path childDb) {
        long mtime = fileModifiedMillis(childDb);
        Path wal = childDb.resolveSibling(childDb.getFileName() + "-wal");
        if (Files.isRegularFile(wal)) {
            mtime = Math.max(mtime, fileModifiedMillis(wal));
        }
        return mtime;
    }

    private static long fileModifiedMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }
}
