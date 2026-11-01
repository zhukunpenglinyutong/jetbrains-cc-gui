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

public class GeminiSubagentHistoryLoader {

    private static final Logger LOG = Logger.getInstance(GeminiSubagentHistoryLoader.class);
    private static final Pattern MESSAGE_PATTERN = Pattern.compile("\\[Message\\]\\s+timestamp=\\S+\\s+sender=([^\\s]+)\\s+priority=\\S+\\s+content=(.*)");

    private final Path cliHome;
    private final GeminiHistoryReader historyReader;

    public record StatusRequest(String toolUseId, String agentId) {}

    public record StatusResult(
            String toolUseId,
            String agentId,
            boolean success,
            String status,
            boolean completed,
            String resultText,
            String error,
            List<JsonObject> messages
    ) {}

    public record SessionResult(
            String toolUseId,
            String agentId,
            boolean success,
            String status,
            boolean completed,
            String resultText,
            String error,
            List<JsonObject> messages
    ) {}

    public record CompletionMessage(String sender, String content) {}

    public GeminiSubagentHistoryLoader(Path cliHome) {
        this(cliHome, new GeminiHistoryReader(cliHome, new Gson()));
    }

    public GeminiSubagentHistoryLoader(Path cliHome, GeminiHistoryReader historyReader) {
        this.cliHome = cliHome;
        this.historyReader = historyReader;
    }

    public static CompletionMessage parseCompletionEnvelope(byte[] payload) {
        if (payload == null || payload.length == 0) {
            return null;
        }
        String text = new String(payload, StandardCharsets.UTF_8);
        return parseCompletionEnvelope(text);
    }

    public static CompletionMessage parseCompletionEnvelope(String text) {
        if (text == null || text.isEmpty()) {
            return null;
        }
        for (String line : text.split("\r?\n")) {
            int idx = line.indexOf("[Message] ");
            if (idx < 0) {
                continue;
            }
            String candidate = line.substring(idx);
            Matcher matcher = MESSAGE_PATTERN.matcher(candidate);
            if (matcher.matches()) {
                String sender = matcher.group(1);
                String content = matcher.group(2);
                if (sender != null && !sender.contains("/task-") && !sender.startsWith("task-") && content != null && !content.trim().isEmpty()) {
                    String cleanContent = content.replaceAll("[\\p{Cntrl}&&[^\r\n\t]]+$", "").trim();
                    if (!cleanContent.isEmpty()) {
                        return new CompletionMessage(sender, cleanContent);
                    }
                }
            }
        }
        return null;
    }

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
            List<JsonObject> messages = hasChildDb ? loadChildMessages(agentId) : List.of();
            String completion = completions.get(agentId.toLowerCase());
            if (completion != null) {
                results.add(new StatusResult(toolUseId, agentId, true, "completed", true, completion, null, messages));
            } else if (!hasChildDb) {
                results.add(new StatusResult(toolUseId, agentId, false, "running", false, null, "Subagent log not found yet", messages));
            } else {
                results.add(new StatusResult(toolUseId, agentId, true, "running", false, null, null, messages));
            }
        }
        return results;
    }

    public SessionResult loadChildSession(String parentSessionId, String toolUseId, String agentId) {
        if (agentId == null || !GeminiHistoryReader.isSafeSessionId(agentId)) {
            return new SessionResult(toolUseId, agentId, false, "error", false, null, "Invalid agent id", List.of());
        }
        Map<String, String> completions = parentSessionId != null ? loadParentStep101Completions(parentSessionId) : Map.of();
        String completion = completions.get(agentId.toLowerCase());
        Path childDb = cliHome.resolve("conversations").resolve(agentId + ".db");
        if (!Files.isRegularFile(childDb)) {
            if (completion != null) {
                return new SessionResult(toolUseId, agentId, true, "completed", true, completion, null, List.of());
            }
            return new SessionResult(toolUseId, agentId, false, "running", false, null, "Subagent log not found yet", List.of());
        }
        List<JsonObject> messages;
        try {
            messages = historyReader.getSessionMessages(agentId, null);
        } catch (IOException e) {
            LOG.warn("[GeminiSubagentHistoryLoader] Failed to read session messages for " + agentId + ": " + e.getMessage());
            return new SessionResult(toolUseId, agentId, false, "error", false, null, e.getMessage(), List.of());
        }
        if (completion != null) {
            return new SessionResult(toolUseId, agentId, true, "completed", true, completion, null, messages);
        }
        return new SessionResult(toolUseId, agentId, true, "running", false, null, null, messages);
    }

    private List<JsonObject> loadChildMessages(String agentId) {
        try {
            return historyReader.getSessionMessages(agentId, null);
        } catch (IOException e) {
            LOG.debug("[GeminiSubagentHistoryLoader] Failed to read child messages for " + agentId + ": " + e.getMessage());
            return List.of();
        }
    }
}
