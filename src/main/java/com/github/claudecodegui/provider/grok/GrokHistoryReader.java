package com.github.claudecodegui.provider.grok;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.provider.ModelProviderHandler;
import com.github.claudecodegui.provider.common.HistoryPathMatcher;
import com.github.claudecodegui.provider.common.HistoryCancellation;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * Reads Grok CLI session history from
 * {@code $GROK_HOME/sessions/<url-encoded-cwd>/<sessionId>/{summary.json,chat_history.jsonl}}
 * (default home {@code ~/.grok}; often {@code ~/.antig-grok} when {@code GROK_HOME} is set).
 */
public class GrokHistoryReader {

    private static final Logger LOG = Logger.getInstance(GrokHistoryReader.class);
    private static final int MAX_TITLE_CHARS = 80;
    private static final int MAX_TOOL_RESULT_CHARS = 20_000;

    private static final String KEY_TOOL_RESULT = "tool_result";
    private static final String KEY_TOOL_USE_ID = "tool_use_id";
    private static final String KEY_GROK_TOOL_PREFIX = "grok-tool-";
    private static final String KEY_CONTENT = "content";
    private static final String KEY_TOTAL_TOKENS_CAMEL = "totalTokens";
    private static final String KEY_TOTAL_TOKENS = "total_tokens";
    private static final String KEY_INPUT_TOKENS = "input_tokens";
    private static final String KEY_TURNS = "turns";
    private static final String KEY_USAGE = "usage";
    private static final String KEY_TURN_ID = "turnId";
    private static final String KEY_TURN_ID_SNAKE = "turn_id";
    private static final String KEY_UPDATE = "update";
    private static final String KEY_DURATION_MS = "durationMs";
    private static final String KEY_META = "_meta";
    private static final String KEY_TURN_USAGE = "turnUsage";
    private static final String KEY_MESSAGE = "message";


    private final Gson gson;
    /** Ordered session roots (primary GROK_HOME first, then fallbacks). */
    private final List<Path> sessionsRoots;

    public GrokHistoryReader() {
        this(defaultSessionsRoots(), new Gson());
    }

    GrokHistoryReader(Path sessionsRoot, Gson gson) {
        this(sessionsRoot != null ? List.of(sessionsRoot) : List.of(), gson);
    }

    GrokHistoryReader(List<Path> sessionsRoots, Gson gson) {
        this.sessionsRoots = sessionsRoots != null ? List.copyOf(sessionsRoots) : List.of();
        this.gson = gson;
    }

    private static List<Path> defaultSessionsRoots() {
        List<Path> roots = new ArrayList<>();
        for (Path home : GrokLocalAuthResolver.resolveGrokHomeCandidates()) {
            if (home != null) {
                roots.add(home.resolve("sessions"));
            }
        }
        // Last-resort default if PlatformUtils home resolution failed above.
        if (roots.isEmpty()) {
            String home = NodeDetector.resolveHomeForFileOps();
            if (home != null && !home.isEmpty()) {
                roots.add(Paths.get(home, ".grok", "sessions"));
            }
        }
        LOG.info("[GrokHistoryReader] Session roots: " + roots);
        return roots;
    }

    public static class SessionInfo {
        public String sessionId;
        public String title;
        public int messageCount;
        public long lastTimestamp;
        public long firstTimestamp;
        public String cwd;
        public long fileSize;
        public String provider = "grok";
        /** Model id used by this session when known (e.g. grok-4.6). */
        public String model;
    }

    static final class SessionUsageTotals {
        String model;
        long inputTokens;
        long outputTokens;
        long cacheReadTokens;
        long cacheWriteTokens;
        long totalTokens;
    }

    /**
     * List sessions for a project path as JSON expected by HistoryView.
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
            LOG.error("[GrokHistoryReader] Failed to list sessions: " + e.getMessage(), e);
            Map<String, Object> error = new HashMap<>();
            error.put("success", false);
            error.put("error", "Failed to read Grok sessions: " + e.getMessage());
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
        // Prefer the first root that owns a given sessionId when the same id
        // appears in multiple homes (should be rare).
        Map<String, SessionInfo> byId = new HashMap<>();
        boolean anyRoot = false;
        for (Path sessionsRoot : sessionsRoots) {
            if (!Files.isDirectory(sessionsRoot)) {
                LOG.info("[GrokHistoryReader] Sessions root missing: " + sessionsRoot);
                continue;
            }
            anyRoot = true;
            try (DirectoryStream<Path> cwdDirs = Files.newDirectoryStream(sessionsRoot)) {
                for (Path cwdDir : cwdDirs) {
                    if (!Files.isDirectory(cwdDir)) {
                        continue;
                    }
                    String name = cwdDir.getFileName().toString();
                    if (name.startsWith(".") || name.endsWith(".sqlite") || name.endsWith(".db")) {
                        continue;
                    }
                    String cwd = decodeCwdDirName(name);
                    try (DirectoryStream<Path> sessionDirs = Files.newDirectoryStream(cwdDir)) {
                        for (Path sessionDir : sessionDirs) {
                            if (!Files.isDirectory(sessionDir)) {
                                continue;
                            }
                            SessionInfo info = readSessionSummary(sessionDir, cwd);
                            if (info != null && info.sessionId != null) {
                                byId.putIfAbsent(info.sessionId, info);
                            }
                        }
                    }
                }
            }
        }
        if (!anyRoot) {
            LOG.info("[GrokHistoryReader] No sessions roots available: " + sessionsRoots);
        }
        sessions.addAll(byId.values());
        sessions.sort(Comparator.comparingLong((SessionInfo s) -> s.lastTimestamp).reversed());
        return sessions;
    }

    private SessionInfo readSessionSummary(Path sessionDir, String cwd) {
        String sessionId = sessionDir.getFileName().toString();
        if (sessionId.isEmpty() || sessionId.contains("..")) {
            return null;
        }
        Path summaryPath = sessionDir.resolve("summary.json");
        Path chatPath = sessionDir.resolve("chat_history.jsonl");
        if (!Files.isRegularFile(chatPath) && !Files.isRegularFile(summaryPath)) {
            return null;
        }

        SessionInfo info = new SessionInfo();
        info.sessionId = sessionId;
        info.cwd = cwd;
        info.provider = "grok";

        long chatMtime = fileMtimeMillis(chatPath);
        long summaryMtime = fileMtimeMillis(summaryPath);
        long created = 0L;
        long updatedFromSummary = 0L;
        String generatedTitle = null;
        String sessionSummary = null;
        int messageCount = 0;

        if (Files.isRegularFile(summaryPath)) {
            try {
                String raw = Files.readString(summaryPath, StandardCharsets.UTF_8);
                JsonObject summary = JsonParser.parseString(raw).getAsJsonObject();
                if (summary.has("generated_title") && !summary.get("generated_title").isJsonNull()) {
                    generatedTitle = summary.get("generated_title").getAsString();
                }
                if (summary.has("session_summary") && !summary.get("session_summary").isJsonNull()) {
                    sessionSummary = summary.get("session_summary").getAsString();
                }
                if (summary.has("num_chat_messages") && summary.get("num_chat_messages").isJsonPrimitive()) {
                    messageCount = summary.get("num_chat_messages").getAsInt();
                } else if (summary.has("num_messages") && summary.get("num_messages").isJsonPrimitive()) {
                    messageCount = summary.get("num_messages").getAsInt();
                }
                created = parseRfc3339Millis(summary, "created_at");
                updatedFromSummary = parseRfc3339Millis(summary, "updated_at");
                if (summary.has("current_model_id") && !summary.get("current_model_id").isJsonNull()) {
                    String modelId = summary.get("current_model_id").getAsString();
                    if (modelId != null && !modelId.isBlank()) {
                        info.model = modelId.trim();
                    }
                }
                if (summary.has("info") && summary.get("info").isJsonObject()) {
                    JsonObject sessionInfo = summary.getAsJsonObject("info");
                    if (sessionInfo.has("cwd") && !sessionInfo.get("cwd").isJsonNull()) {
                        info.cwd = sessionInfo.get("cwd").getAsString();
                    }
                    if (sessionInfo.has("id") && !sessionInfo.get("id").isJsonNull()) {
                        info.sessionId = sessionInfo.get("id").getAsString();
                    }
                }
            } catch (Exception e) {
                LOG.debug("[GrokHistoryReader] Failed to parse summary for " + sessionDir + ": " + e.getMessage());
            }
        }

        if (info.model == null || info.model.isBlank()) {
            SessionUsageTotals usageTotals = readUsageJsonFromDir(sessionDir);
            if (usageTotals != null && usageTotals.model != null && !usageTotals.model.isBlank()) {
                info.model = usageTotals.model;
            }
        }

        String firstUserPrompt = null;
        if (Files.isRegularFile(chatPath)) {
            try {
                info.fileSize = Files.size(chatPath);
                // Always capture first user prompt when possible: Grok CLI's generated_title
                // is frequently an English paraphrase of a non-English user message.
                ChatHistoryMeta meta = scanChatHistoryMeta(chatPath, true);
                if (messageCount <= 0) {
                    messageCount = meta.nonEmptyLines;
                }
                firstUserPrompt = meta.firstUserPrompt;
            } catch (Exception e) {
                LOG.debug("[GrokHistoryReader] Failed to read chat history meta for " + sessionDir + ": " + e.getMessage());
            }
        }

        info.title = resolveSessionTitle(firstUserPrompt, generatedTitle, sessionSummary, sessionId);
        info.messageCount = Math.max(messageCount, 0);
        info.firstTimestamp = created > 0 ? created : (summaryMtime > 0 ? summaryMtime : chatMtime);
        // Prefer chat file mtime so bulk summary rewrites don't collapse all rows to "just now".
        long activity = chatMtime > 0 ? chatMtime
                : (updatedFromSummary > 0 ? updatedFromSummary
                : (summaryMtime > 0 ? summaryMtime : info.firstTimestamp));
        info.lastTimestamp = activity > 0 ? activity : System.currentTimeMillis();
        if (info.firstTimestamp <= 0) {
            info.firstTimestamp = info.lastTimestamp;
        }
        return info;
    }

    /**
     * Load session transcript as Claude-compatible message envelopes for
     * {@link com.github.claudecodegui.session.MessageParser}.
     */
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) throws IOException {
        return getSessionMessagesInternal(sessionId, cwd, () -> false, false);
    }

    public List<JsonObject> getSessionMessages(String sessionId, String cwd,
                                               BooleanSupplier cancellation) throws IOException {
        return getSessionMessagesInternal(sessionId, cwd, cancellation, true);
    }

    private List<JsonObject> getSessionMessagesInternal(String sessionId, String cwd,
                                                         BooleanSupplier cancellation, boolean failMissing) throws IOException {
        HistoryCancellation.check(cancellation);
        Path sessionDir = resolveSessionDir(sessionId, cwd, cancellation);
        if (sessionDir == null) {
            if (failMissing) {
                requireScannableSessionRoots();
                throw new com.github.claudecodegui.provider.common.SessionHistoryNotFoundException(sessionId, cwd);
            }

            LOG.warn("[GrokHistoryReader] Session dir not found for id=" + sessionId + " cwd=" + cwd);
            return List.of();
        }
        Path chatPath = sessionDir.resolve("chat_history.jsonl");
        if (!Files.isRegularFile(chatPath)) {
            if (failMissing) {
                // The session directory exists, so a transcript not written yet is retryable, never a retirement signal.
                throw new IOException("Grok session history is not readable yet: " + sessionId);
            }

            return List.of();
        }
        return parseChatHistoryToMessages(chatPath, cancellation);
    }

    public boolean deleteSession(String sessionId, String projectPath) throws IOException {
        if (sessionId == null || sessionId.trim().isEmpty()
                || sessionId.contains("/") || sessionId.contains("\\") || sessionId.contains("..")) {
            LOG.warn("[GrokHistoryReader] Refusing to delete session with invalid id: " + sessionId);
            return false;
        }
        Path sessionDir = resolveSessionDir(sessionId, projectPath);
        if (sessionDir == null || !Files.isDirectory(sessionDir)) {
            // Fallback: scan all cwd dirs for this id
            sessionDir = findSessionDirById(sessionId);
        }
        if (sessionDir == null || !Files.isDirectory(sessionDir)) {
            return false;
        }
        deleteRecursively(sessionDir);
        // Remove empty cwd parent
        Path parent = sessionDir.getParent();
        if (parent != null && Files.isDirectory(parent)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(parent)) {
                if (!stream.iterator().hasNext()) {
                    Files.deleteIfExists(parent);
                }
            } catch (Exception ignored) {
            }
        }
        return true;
    }

    private Path resolveSessionDir(String sessionId, String cwd) {
        return resolveSessionDir(sessionId, cwd, () -> false);
    }

    private Path resolveSessionDir(String sessionId, String cwd,
                                   BooleanSupplier cancellation) {
        HistoryCancellation.check(cancellation);
        if (sessionId == null || sessionId.trim().isEmpty()) {
            return null;
        }
        String id = sessionId.trim();
        if (id.contains("/") || id.contains("\\") || id.contains("..")) {
            return null;
        }
        if (cwd != null && !cwd.trim().isEmpty()) {
            String encoded = encodeCwd(cwd);
            String encodedCanon = encodeCwd(canonicalizePath(cwd));
            for (Path sessionsRoot : sessionsRoots) {
                HistoryCancellation.check(cancellation);
                Path direct = sessionsRoot.resolve(encoded).resolve(id);
                if (Files.isDirectory(direct)) {
                    return direct;
                }
                // macOS may canonicalize /var → /private/var etc.
                Path canon = sessionsRoot.resolve(encodedCanon).resolve(id);
                if (Files.isDirectory(canon)) {
                    return canon;
                }
            }
        }
        return findSessionDirById(id, cancellation);
    }

    private Path findSessionDirById(String sessionId) {
        return findSessionDirById(sessionId, () -> false);
    }

    private Path findSessionDirById(String sessionId,
                                    BooleanSupplier cancellation) {
        for (Path sessionsRoot : sessionsRoots) {
            HistoryCancellation.check(cancellation);
            if (!Files.isDirectory(sessionsRoot)) {
                continue;
            }
            try (DirectoryStream<Path> cwdDirs = Files.newDirectoryStream(sessionsRoot)) {
                for (Path cwdDir : cwdDirs) {
                    HistoryCancellation.check(cancellation);
                    if (!Files.isDirectory(cwdDir)) {
                        continue;
                    }
                    Path candidate = cwdDir.resolve(sessionId);
                    if (Files.isDirectory(candidate)) {
                        return candidate;
                    }
                }
            } catch (IOException e) {
                LOG.warn("[GrokHistoryReader] Scan for session id failed under "
                        + sessionsRoot + ": " + e.getMessage());
            }
        }
        return null;
    }

    /** A root the id scan could not list proves nothing about the session, so restore retries instead. */
    private void requireScannableSessionRoots() throws IOException {
        for (Path sessionsRoot : sessionsRoots) {
            if (Files.isDirectory(sessionsRoot)) {
                try (DirectoryStream<Path> ignored = Files.newDirectoryStream(sessionsRoot)) {
                    // Opening the stream is the readability check.
                }
            }
        }
    }

    List<JsonObject> parseChatHistoryToMessages(Path chatPath) throws IOException {
        return parseChatHistoryToMessages(chatPath, () -> false);
    }

    private List<JsonObject> parseChatHistoryToMessages(
            Path chatPath,
            BooleanSupplier cancellation
    ) throws IOException {
        List<JsonObject> messages = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(chatPath, StandardCharsets.UTF_8)) {
            String line;
            int counter = 0;
            while ((line = reader.readLine()) != null) {
                HistoryCancellation.check(cancellation);
                line = line.trim();
                if (line.isEmpty() || !line.contains("\"type\"")) {
                    continue;
                }
                JsonObject value;
                try {
                    value = JsonParser.parseString(line).getAsJsonObject();
                } catch (Exception e) {
                    continue;
                }
                String type = value.has("type") && !value.get("type").isJsonNull()
                        ? value.get("type").getAsString()
                        : "";
                switch (type) {
                    case "user" -> {
                        if (value.has("synthetic_reason")) {
                            continue;
                        }
                        JsonElement contentEl = resolveMessageContent(value);
                        if (containsToolResultBlock(contentEl)) {
                            for (JsonElement el : contentEl.getAsJsonArray()) {
                                if (!el.isJsonObject()) {
                                    continue;
                                }
                                JsonObject block = el.getAsJsonObject();
                                if (block.has("type") && KEY_TOOL_RESULT.equals(block.get("type").getAsString())) {
                                    String callId = block.has(KEY_TOOL_USE_ID) && !block.get(KEY_TOOL_USE_ID).isJsonNull()
                                            ? block.get(KEY_TOOL_USE_ID).getAsString()
                                            : (KEY_GROK_TOOL_PREFIX + (++counter));
                                    String content = truncate(stringifyContent(block.get(KEY_CONTENT)), MAX_TOOL_RESULT_CHARS);
                                    if (!content.isBlank()) {
                                        messages.add(buildToolResultMessage(callId, content));
                                    }
                                }
                            }
                            continue;
                        }
                        String rawText = extractContentText(contentEl);
                        if (isRuntimeContextUserText(rawText)) {
                            continue;
                        }
                        String display = stripUserQueryWrapper(rawText);
                        if (display.isEmpty()) {
                            continue;
                        }
                        counter++;
                        messages.add(buildUserTextMessage(display, "grok-user-" + counter));
                    }
                    case "reasoning" -> {
                        String text = extractReasoningSummary(value.get("summary"));
                        if (text.isBlank()) {
                            continue;
                        }
                        counter++;
                        messages.add(buildAssistantThinkingMessage(text, "grok-reasoning-" + counter));
                    }
                    case "assistant" -> {
                        String text = extractContentText(resolveMessageContent(value));
                        if (!text.isBlank()) {
                            counter++;
                            messages.add(buildAssistantTextMessage(text, "grok-assistant-" + counter));
                        }
                        if (value.has("tool_calls") && value.get("tool_calls").isJsonArray()) {
                            JsonArray toolCalls = value.getAsJsonArray("tool_calls");
                            for (JsonElement el : toolCalls) {
                                if (!el.isJsonObject()) {
                                    continue;
                                }
                                JsonObject call = el.getAsJsonObject();
                                String toolName = resolveToolName(call);
                                String callId = call.has("id") && !call.get("id").isJsonNull()
                                        ? call.get("id").getAsString()
                                        : (KEY_GROK_TOOL_PREFIX + (++counter));
                                JsonObject input = resolveToolArguments(call);
                                messages.add(buildToolUseMessage(callId, toolName, input));
                            }
                        }
                    }
                    case KEY_TOOL_RESULT -> {
                        String callId = value.has("tool_call_id") && !value.get("tool_call_id").isJsonNull()
                                ? value.get("tool_call_id").getAsString()
                                : (KEY_GROK_TOOL_PREFIX + (++counter));
                        String content = truncate(stringifyContent(resolveMessageContent(value)), MAX_TOOL_RESULT_CHARS);
                        if (content.isBlank()) {
                            continue;
                        }
                        messages.add(buildToolResultMessage(callId, content));
                    }
                    default -> {
                        // skip system / unknown
                    }
                }
            }
        }
        enrichMessagesWithCompanionData(chatPath.getParent(), messages);
        return messages;
    }

    SessionUsageTotals readSessionUsageTotals(String sessionId, String cwd) {
        Path sessionDir = resolveSessionDir(sessionId, cwd);
        return readUsageJsonFromDir(sessionDir);
    }

    private static SessionUsageTotals readUsageJsonFromDir(Path sessionDir) {
        if (sessionDir == null) {
            return null;
        }
        Path usagePath = sessionDir.resolve("usage.json");
        if (!Files.isRegularFile(usagePath)) {
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(usagePath, StandardCharsets.UTF_8));
            if (parsed == null || !parsed.isJsonObject()) {
                return null;
            }
            return sessionTotalsFromUsageRoot(parsed.getAsJsonObject());
        } catch (Exception e) {
            LOG.debug("[GrokHistoryReader] Failed to read usage.json in " + sessionDir + ": " + e.getMessage());
            return null;
        }
    }

    private static SessionUsageTotals sessionTotalsFromUsageRoot(JsonObject obj) {
        SessionUsageTotals totals = new SessionUsageTotals();
        totals.model = firstNonBlankString(obj, "primaryModelId", "modelId", "model");
        totals.totalTokens = firstPositiveLong(obj, KEY_TOTAL_TOKENS_CAMEL, KEY_TOTAL_TOKENS);
        totals.inputTokens = firstPositiveLong(obj, "inputTokens", KEY_INPUT_TOKENS);
        totals.outputTokens = firstPositiveLong(obj, "outputTokens", "output_tokens");
        totals.cacheReadTokens = firstPositiveLong(
                obj, "cacheReadTokens", "cachedReadTokens", "cache_read_input_tokens", "cached_read_tokens");
        totals.cacheWriteTokens = firstPositiveLong(
                obj, "cacheWriteTokens", "cachedWriteTokens", "cache_creation_input_tokens", "cached_write_tokens");
        if (totals.totalTokens <= 0) {
            accumulateTurnTotals(obj, totals);
        }
        return totals;
    }

    private static void accumulateTurnTotals(JsonObject obj, SessionUsageTotals totals) {
        if (!obj.has(KEY_TURNS) || !obj.get(KEY_TURNS).isJsonArray()) {
            return;
        }
        for (JsonElement turnEl : obj.getAsJsonArray(KEY_TURNS)) {
            if (!turnEl.isJsonObject()) {
                continue;
            }
            JsonObject usage = usageObject(turnEl.getAsJsonObject());
            totals.inputTokens += firstPositiveLong(usage, "inputTokens", KEY_INPUT_TOKENS);
            totals.outputTokens += firstPositiveLong(usage, "outputTokens", "output_tokens");
            totals.cacheReadTokens += firstPositiveLong(
                    usage, "cacheReadTokens", "cachedReadTokens", "cache_read_input_tokens", "cached_read_tokens");
            totals.cacheWriteTokens += firstPositiveLong(
                    usage, "cacheWriteTokens", "cachedWriteTokens", "cache_creation_input_tokens", "cached_write_tokens");
            totals.totalTokens += firstPositiveLong(usage, KEY_TOTAL_TOKENS_CAMEL, KEY_TOTAL_TOKENS);
        }
    }

    private static void enrichMessagesWithCompanionData(Path sessionDir, List<JsonObject> messages) {
        if (sessionDir == null || messages == null || messages.isEmpty()) {
            return;
        }
        List<JsonObject> turnAssistants = new ArrayList<>();
        JsonObject lastSessionAssistant = collectTurnAssistants(messages, turnAssistants);
        if (lastSessionAssistant == null) {
            return;
        }
        Map<Integer, JsonObject> turnUsageByIndex = new HashMap<>();
        String sessionModel = loadUsageTurns(sessionDir, turnUsageByIndex);
        Map<Integer, Long> turnDurationByIndex = new HashMap<>();
        int lastStepContextTokens = loadUpdates(sessionDir, turnUsageByIndex, turnDurationByIndex);
        stampTurnMetadata(turnAssistants, turnUsageByIndex, turnDurationByIndex);
        stampSessionContext(lastSessionAssistant, sessionDir, sessionModel, lastStepContextTokens);
    }

    private static JsonObject collectTurnAssistants(List<JsonObject> messages, List<JsonObject> turnAssistants) {
        TurnGroup group = new TurnGroup();
        for (JsonObject msg : messages) {
            acceptTurnMessage(group, turnAssistants, msg);
        }
        if (group.inTurn) {
            turnAssistants.add(group.currentTurnLastAssistant);
        }
        return group.lastSessionAssistant;
    }

    private static void acceptTurnMessage(TurnGroup group, List<JsonObject> turnAssistants, JsonObject msg) {
        if (!isTypedMessage(msg)) {
            return;
        }
        String type = msg.get("type").getAsString();
        if ("user".equals(type) && !isToolResultEnvelope(msg)) {
            startTurn(group, turnAssistants);
            return;
        }
        if ("assistant".equals(type)) {
            rememberAssistant(group, msg);
        }
    }

    private static boolean isTypedMessage(JsonObject msg) {
        return msg != null && msg.has("type") && !msg.get("type").isJsonNull();
    }

    private static void startTurn(TurnGroup group, List<JsonObject> turnAssistants) {
        if (group.inTurn) {
            turnAssistants.add(group.currentTurnLastAssistant);
        }
        group.inTurn = true;
        group.currentTurnLastAssistant = null;
    }

    private static void rememberAssistant(TurnGroup group, JsonObject msg) {
        if (!group.inTurn) {
            group.inTurn = true;
        }
        group.currentTurnLastAssistant = msg;
        group.lastSessionAssistant = msg;
    }

    private static String loadUsageTurns(Path sessionDir, Map<Integer, JsonObject> turnUsageByIndex) {
        Path usagePath = sessionDir.resolve("usage.json");
        if (!Files.isRegularFile(usagePath)) {
            return null;
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(usagePath, StandardCharsets.UTF_8));
            if (parsed == null || !parsed.isJsonObject()) {
                return null;
            }
            return indexUsageTurns(parsed.getAsJsonObject(), turnUsageByIndex);
        } catch (Exception e) {
            LOG.debug("[GrokHistoryReader] Failed to parse companion usage.json: " + e.getMessage());
            return null;
        }
    }

    private static String indexUsageTurns(JsonObject usageRoot, Map<Integer, JsonObject> turnUsageByIndex) {
        String sessionModel = firstNonBlankString(usageRoot, "primaryModelId", "modelId", "model");
        if (!usageRoot.has(KEY_TURNS) || !usageRoot.get(KEY_TURNS).isJsonArray()) {
            return sessionModel;
        }
        JsonArray turns = usageRoot.getAsJsonArray(KEY_TURNS);
        for (int i = 0; i < turns.size(); i++) {
            indexOneUsageTurn(turns.get(i), i, turnUsageByIndex);
        }
        return sessionModel;
    }

    private static void indexOneUsageTurn(JsonElement element, int index, Map<Integer, JsonObject> turnUsageByIndex) {
        if (!element.isJsonObject()) {
            return;
        }
        JsonObject turnObj = element.getAsJsonObject();
        int turnIdx = (int) firstPositiveLong(turnObj, KEY_TURN_ID, "turn", KEY_TURN_ID_SNAKE) - 1;
        if (turnIdx < 0) {
            turnIdx = index;
        }
        JsonObject normalized = GrokContextUsageBuilder.normalizeTurnUsage(usageObject(turnObj));
        if (normalized != null) {
            turnUsageByIndex.put(turnIdx, normalized);
        }
    }

    private static JsonObject usageObject(JsonObject parent) {
        if (parent.has(KEY_USAGE) && parent.get(KEY_USAGE).isJsonObject()) {
            return parent.getAsJsonObject(KEY_USAGE);
        }
        return parent;
    }

    private static int loadUpdates(
            Path sessionDir,
            Map<Integer, JsonObject> turnUsageByIndex,
            Map<Integer, Long> turnDurationByIndex) {
        Path updatesPath = sessionDir.resolve("updates.jsonl");
        if (!Files.isRegularFile(updatesPath)) {
            return 0;
        }
        UpdateScan scan = new UpdateScan();
        try (BufferedReader reader = Files.newBufferedReader(updatesPath, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                acceptUpdateLine(line, scan, turnUsageByIndex, turnDurationByIndex);
            }
        } catch (Exception e) {
            LOG.debug("[GrokHistoryReader] Failed to parse companion updates.jsonl: " + e.getMessage());
        }
        return scan.lastStepContextTokens;
    }

    private static void acceptUpdateLine(
            String line,
            UpdateScan scan,
            Map<Integer, JsonObject> turnUsageByIndex,
            Map<Integer, Long> turnDurationByIndex) {
        String trimmed = line.trim();
        if (trimmed.isEmpty() || !trimmed.startsWith("{")) {
            return;
        }
        try {
            applyUpdateObject(
                    JsonParser.parseString(trimmed).getAsJsonObject(),
                    scan,
                    turnUsageByIndex,
                    turnDurationByIndex);
        } catch (Exception ignored) {
            // Skip one malformed updates.jsonl line and keep reading the rest.
        }
    }

    private static void applyUpdateObject(
            JsonObject obj,
            UpdateScan scan,
            Map<Integer, JsonObject> turnUsageByIndex,
            Map<Integer, Long> turnDurationByIndex) {
        JsonObject update = nestedObjectOrSelf(obj, KEY_UPDATE);
        recordElapsed(obj, update, scan, turnDurationByIndex);
        recordTurnUsageFromUpdate(update, scan, turnUsageByIndex);
        recordStepContext(obj, update, scan);
    }

    private static JsonObject nestedObjectOrSelf(JsonObject obj, String key) {
        if (obj.has(key) && obj.get(key).isJsonObject()) {
            return obj.getAsJsonObject(key);
        }
        return obj;
    }

    private static void recordElapsed(
            JsonObject obj,
            JsonObject update,
            UpdateScan scan,
            Map<Integer, Long> turnDurationByIndex) {
        long elapsed = elapsedMillis(update);
        if (elapsed <= 0 && update != obj) {
            elapsed = elapsedMillis(obj);
        }
        if (elapsed <= 0) {
            return;
        }
        long explicitTurn = explicitTurnId(update);
        if (explicitTurn <= 0 && update != obj) {
            explicitTurn = explicitTurnId(obj);
        }
        int idx = explicitTurn > 0 ? (int) (explicitTurn - 1) : scan.sequentialDurationIdx++;
        turnDurationByIndex.put(idx, elapsed);
    }

    private static long elapsedMillis(JsonObject obj) {
        return firstPositiveLong(obj, "elapsed_ms", "elapsedMs", "duration_ms", KEY_DURATION_MS);
    }

    private static long explicitTurnId(JsonObject obj) {
        return firstPositiveLong(obj, "turn", KEY_TURN_ID, KEY_TURN_ID_SNAKE);
    }

    private static void recordTurnUsageFromUpdate(
            JsonObject update,
            UpdateScan scan,
            Map<Integer, JsonObject> turnUsageByIndex) {
        String kind = firstNonBlankString(update, "sessionUpdate", "type");
        if ("turn_completed".equals(kind)) {
            rememberTurnCompletedUsage(update, scan, turnUsageByIndex);
            return;
        }
        if ("response_completed".equals(kind)) {
            rememberResponseCompleted(update, scan);
        }
    }

    private static void rememberTurnCompletedUsage(
            JsonObject update,
            UpdateScan scan,
            Map<Integer, JsonObject> turnUsageByIndex) {
        if (!update.has(KEY_USAGE) || !update.get(KEY_USAGE).isJsonObject()) {
            return;
        }
        int idx = scan.sequentialTurnUsageIdx++;
        long explicitTurn = explicitTurnId(update);
        if (explicitTurn > 0) {
            idx = (int) (explicitTurn - 1);
        }
        if (turnUsageByIndex.containsKey(idx)) {
            return;
        }
        JsonObject normalized = GrokContextUsageBuilder.normalizeTurnUsage(update.getAsJsonObject(KEY_USAGE));
        if (normalized != null) {
            turnUsageByIndex.put(idx, normalized);
        }
    }

    private static void rememberResponseCompleted(JsonObject update, UpdateScan scan) {
        if (!update.has(KEY_USAGE) || !update.get(KEY_USAGE).isJsonObject()) {
            return;
        }
        int stepTokens = GrokContextUsageBuilder.extractUsedTokens(update.getAsJsonObject(KEY_USAGE));
        if (stepTokens > 0) {
            scan.lastStepContextTokens = stepTokens;
        }
    }

    private static void recordStepContext(JsonObject obj, JsonObject update, UpdateScan scan) {
        JsonObject meta = metaObject(obj, update);
        if (meta == null) {
            return;
        }
        int metaTokens = (int) firstPositiveLong(meta, KEY_TOTAL_TOKENS_CAMEL, KEY_TOTAL_TOKENS);
        if (metaTokens > 0) {
            scan.lastStepContextTokens = metaTokens;
        }
    }

    private static JsonObject metaObject(JsonObject obj, JsonObject update) {
        if (obj.has(KEY_META) && obj.get(KEY_META).isJsonObject()) {
            return obj.getAsJsonObject(KEY_META);
        }
        if (update.has(KEY_META) && update.get(KEY_META).isJsonObject()) {
            return update.getAsJsonObject(KEY_META);
        }
        return null;
    }

    private static void stampTurnMetadata(
            List<JsonObject> turnAssistants,
            Map<Integer, JsonObject> turnUsageByIndex,
            Map<Integer, Long> turnDurationByIndex) {
        for (int turn = 0; turn < turnAssistants.size(); turn++) {
            JsonObject assistant = turnAssistants.get(turn);
            if (assistant == null) {
                continue;
            }
            JsonObject turnUsage = turnUsageByIndex.get(turn);
            if (turnUsage != null) {
                assistant.add(KEY_TURN_USAGE, turnUsage.deepCopy());
            }
            Long durationMs = turnDurationByIndex.get(turn);
            if (durationMs != null && durationMs > 0) {
                assistant.addProperty(KEY_DURATION_MS, durationMs);
            }
        }
    }

    private static void stampSessionContext(
            JsonObject lastSessionAssistant,
            Path sessionDir,
            String sessionModel,
            int lastStepContextTokens) {
        SignalSnapshot signals = readSignals(sessionDir);
        int resolvedContextUsed = signals.contextUsed() > 0 ? signals.contextUsed() : lastStepContextTokens;
        if (resolvedContextUsed <= 0 && lastSessionAssistant.has(KEY_TURN_USAGE)) {
            JsonObject lastTurnUsage = lastSessionAssistant.getAsJsonObject(KEY_TURN_USAGE);
            resolvedContextUsed = (int) firstPositiveLong(lastTurnUsage, KEY_TOTAL_TOKENS);
        }
        int resolvedContextWindow = signals.contextWindow() > 0
                ? signals.contextWindow()
                : resolveHistoryContextWindow(sessionModel);
        if (resolvedContextUsed > 0 || resolvedContextWindow > 0) {
            attachSessionUsage(lastSessionAssistant, resolvedContextUsed, resolvedContextWindow);
        }
    }

    private static SignalSnapshot readSignals(Path sessionDir) {
        Path signalsPath = sessionDir.resolve("signals.json");
        if (!Files.isRegularFile(signalsPath)) {
            return new SignalSnapshot(0, 0);
        }
        try {
            JsonElement parsed = JsonParser.parseString(Files.readString(signalsPath, StandardCharsets.UTF_8));
            if (parsed == null || !parsed.isJsonObject()) {
                return new SignalSnapshot(0, 0);
            }
            JsonObject signals = parsed.getAsJsonObject();
            int used = (int) firstPositiveLong(signals, "contextTokensUsed", "context_tokens_used");
            int window = (int) firstPositiveLong(signals, "contextWindowTokens", "context_window_tokens");
            return new SignalSnapshot(used, window);
        } catch (Exception e) {
            LOG.debug("[GrokHistoryReader] Failed to parse companion signals.json: " + e.getMessage());
            return new SignalSnapshot(0, 0);
        }
    }

    private static int resolveHistoryContextWindow(String sessionModel) {
        Integer fromResolver = GrokContextWindowResolver.resolve(sessionModel);
        if (fromResolver != null && fromResolver > 0) {
            return fromResolver;
        }
        if (sessionModel != null && !sessionModel.isBlank()) {
            return ModelProviderHandler.resolveContextLimit("grok", sessionModel, null);
        }
        return 0;
    }

    private static void attachSessionUsage(
            JsonObject lastSessionAssistant,
            int resolvedContextUsed,
            int resolvedContextWindow) {
        JsonObject message = jsonObjectField(lastSessionAssistant, KEY_MESSAGE);
        JsonObject usage = jsonObjectField(message, KEY_USAGE);
        if (resolvedContextUsed > 0) {
            usage.addProperty(KEY_TOTAL_TOKENS, resolvedContextUsed);
            usage.addProperty(KEY_INPUT_TOKENS, resolvedContextUsed);
        }
        if (resolvedContextWindow > 0) {
            usage.addProperty("model_context_window", resolvedContextWindow);
        }
        message.add(KEY_USAGE, usage);
        lastSessionAssistant.add(KEY_MESSAGE, message);
    }

    private static JsonObject jsonObjectField(JsonObject parent, String key) {
        if (parent.has(key) && parent.get(key).isJsonObject()) {
            return parent.getAsJsonObject(key);
        }
        return new JsonObject();
    }

    private static final class TurnGroup {
        private boolean inTurn;
        private JsonObject currentTurnLastAssistant;
        private JsonObject lastSessionAssistant;
    }

    private static final class UpdateScan {
        private int sequentialDurationIdx;
        private int sequentialTurnUsageIdx;
        private int lastStepContextTokens;
    }

    private record SignalSnapshot(int contextUsed, int contextWindow) {
    }
    private static JsonElement resolveMessageContent(JsonObject value) {
        if (value == null) {
            return null;
        }
        if (value.has(KEY_CONTENT) && !value.get(KEY_CONTENT).isJsonNull()) {
            return value.get(KEY_CONTENT);
        }
        if (value.has(KEY_MESSAGE) && value.get(KEY_MESSAGE).isJsonObject()) {
            JsonObject message = value.getAsJsonObject(KEY_MESSAGE);
            if (message.has(KEY_CONTENT) && !message.get(KEY_CONTENT).isJsonNull()) {
                return message.get(KEY_CONTENT);
            }
        }
        return null;
    }

    private static boolean containsToolResultBlock(JsonElement content) {
        if (content == null || !content.isJsonArray()) {
            return false;
        }
        for (JsonElement el : content.getAsJsonArray()) {
            if (el.isJsonObject()) {
                JsonObject block = el.getAsJsonObject();
                if (block.has("type") && KEY_TOOL_RESULT.equals(block.get("type").getAsString())) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean isToolResultEnvelope(JsonObject msg) {
        if (msg == null || !msg.has(KEY_MESSAGE) || !msg.get(KEY_MESSAGE).isJsonObject()) {
            return false;
        }
        JsonObject inner = msg.getAsJsonObject(KEY_MESSAGE);
        return containsToolResultBlock(inner.get(KEY_CONTENT));
    }

    private static long firstPositiveLong(JsonObject obj, String... keys) {
        if (obj == null || keys == null) {
            return 0L;
        }
        for (String key : keys) {
            if (key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
                continue;
            }
            try {
                long val = obj.get(key).getAsLong();
                if (val > 0L) {
                    return val;
                }
            } catch (Exception ignored) {
                // Ignore a non-numeric value and try the next key.
            }
        }
        return 0L;
    }

    private static String firstNonBlankString(JsonObject obj, String... keys) {
        if (obj == null || keys == null) {
            return null;
        }
        for (String key : keys) {
            if (key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
                continue;
            }
            try {
                String val = obj.get(key).getAsString();
                if (val != null && !val.isBlank()) {
                    return val.trim();
                }
            } catch (Exception ignored) {
                // Ignore a non-string value and try the next key.
            }
        }
        return null;
    }

    private static JsonObject buildUserTextMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add(KEY_CONTENT, content);
        root.add(KEY_MESSAGE, message);
        return root;
    }

    private static JsonObject buildAssistantTextMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "text");
        block.addProperty("text", text);
        content.add(block);
        message.add(KEY_CONTENT, content);
        root.add(KEY_MESSAGE, message);
        return root;
    }

    private static JsonObject buildAssistantThinkingMessage(String text, String uuid) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        root.addProperty("uuid", uuid);
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "thinking");
        block.addProperty("thinking", text);
        content.add(block);
        message.add(KEY_CONTENT, content);
        root.add(KEY_MESSAGE, message);
        return root;
    }

    private static JsonObject buildToolUseMessage(String id, String name, JsonObject input) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "assistant");
        JsonObject message = new JsonObject();
        message.addProperty("role", "assistant");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", "tool_use");
        block.addProperty("id", id);
        block.addProperty("name", name);
        block.add("input", input != null ? input : new JsonObject());
        content.add(block);
        message.add(KEY_CONTENT, content);
        root.add(KEY_MESSAGE, message);
        return root;
    }

    private static JsonObject buildToolResultMessage(String toolUseId, String contentText) {
        JsonObject root = new JsonObject();
        root.addProperty("type", "user");
        JsonObject message = new JsonObject();
        message.addProperty("role", "user");
        JsonArray content = new JsonArray();
        JsonObject block = new JsonObject();
        block.addProperty("type", KEY_TOOL_RESULT);
        block.addProperty(KEY_TOOL_USE_ID, toolUseId);
        block.addProperty("is_error", false);
        block.addProperty(KEY_CONTENT, contentText);
        content.add(block);
        message.add(KEY_CONTENT, content);
        root.add(KEY_MESSAGE, message);
        return root;
    }

    private static String resolveToolName(JsonObject call) {
        if (call.has("name") && !call.get("name").isJsonNull()) {
            String name = call.get("name").getAsString();
            if (!name.isBlank()) {
                return name.trim();
            }
        }
        if (call.has("function") && call.get("function").isJsonObject()) {
            JsonObject fn = call.getAsJsonObject("function");
            if (fn.has("name") && !fn.get("name").isJsonNull()) {
                return fn.get("name").getAsString();
            }
        }
        return "tool";
    }

    private static JsonObject resolveToolArguments(JsonObject call) {
        JsonElement args = null;
        if (call.has("arguments")) {
            args = call.get("arguments");
        } else if (call.has("function") && call.get("function").isJsonObject()) {
            JsonObject fn = call.getAsJsonObject("function");
            if (fn.has("arguments")) {
                args = fn.get("arguments");
            }
        }
        return parseArguments(args);
    }

    private static JsonObject parseArguments(JsonElement args) {
        if (args == null || args.isJsonNull()) {
            return new JsonObject();
        }
        if (args.isJsonObject()) {
            return args.getAsJsonObject();
        }
        if (args.isJsonPrimitive()) {
            String raw = args.getAsString();
            if (raw == null || raw.isBlank()) {
                return new JsonObject();
            }
            try {
                JsonElement parsed = JsonParser.parseString(raw);
                if (parsed.isJsonObject()) {
                    return parsed.getAsJsonObject();
                }
                JsonObject wrap = new JsonObject();
                wrap.add("value", parsed);
                return wrap;
            } catch (Exception e) {
                JsonObject wrap = new JsonObject();
                wrap.addProperty("raw", raw);
                return wrap;
            }
        }
        JsonObject wrap = new JsonObject();
        wrap.add("value", args);
        return wrap;
    }

    private static String extractContentText(JsonElement content) {
        if (content == null || content.isJsonNull()) {
            return "";
        }
        if (content.isJsonPrimitive()) {
            return content.getAsString();
        }
        if (content.isJsonArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonElement el : content.getAsJsonArray()) {
                if (!el.isJsonObject()) {
                    continue;
                }
                JsonObject block = el.getAsJsonObject();
                if (block.has("text") && !block.get("text").isJsonNull()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(block.get("text").getAsString());
                }
            }
            return sb.toString();
        }
        return "";
    }

    private static String extractReasoningSummary(JsonElement summary) {
        if (summary == null || summary.isJsonNull()) {
            return "";
        }
        if (summary.isJsonPrimitive()) {
            return summary.getAsString();
        }
        if (summary.isJsonArray()) {
            StringBuilder sb = new StringBuilder();
            for (JsonElement el : summary.getAsJsonArray()) {
                if (el.isJsonPrimitive()) {
                    if (sb.length() > 0) {
                        sb.append('\n');
                    }
                    sb.append(el.getAsString());
                } else if (el.isJsonObject()) {
                    JsonObject part = el.getAsJsonObject();
                    if (part.has("text") && !part.get("text").isJsonNull()) {
                        if (sb.length() > 0) {
                            sb.append('\n');
                        }
                        sb.append(part.get("text").getAsString());
                    }
                }
            }
            return sb.toString();
        }
        return "";
    }

    private static String stringifyContent(JsonElement content) {
        if (content == null || content.isJsonNull()) {
            return "";
        }
        if (content.isJsonPrimitive()) {
            return content.getAsString();
        }
        return content.toString();
    }

    /**
     * History list / reopen title priority:
     * <ol>
     *   <li>First real user prompt (preserves the user's language; matches Codex)</li>
     *   <li>Grok CLI {@code generated_title}</li>
     *   <li>{@code session_summary}</li>
     *   <li>Short session-id fallback</li>
     * </ol>
     * Preferring the user prompt avoids English auto-titles for Chinese (etc.) prompts.
     */
    static String resolveSessionTitle(
            String firstUserPrompt,
            String generatedTitle,
            String sessionSummary,
            String sessionId
    ) {
        if (firstUserPrompt != null && !firstUserPrompt.trim().isEmpty()) {
            return truncate(firstUserPrompt.trim(), MAX_TITLE_CHARS);
        }
        if (generatedTitle != null && !generatedTitle.trim().isEmpty()) {
            return generatedTitle.trim();
        }
        if (sessionSummary != null && !sessionSummary.trim().isEmpty()) {
            return truncate(sessionSummary.trim(), MAX_TITLE_CHARS);
        }
        String id = sessionId != null ? sessionId : "";
        return "Grok session " + id.substring(0, Math.min(8, id.length()));
    }

    private static String stripUserQueryWrapper(String raw) {
        if (raw == null) {
            return "";
        }
        String text = raw.trim();
        // Prefer <user_query> body when present
        int start = text.indexOf("<user_query>");
        int end = text.indexOf("</user_query>");
        if (start >= 0 && end > start) {
            return text.substring(start + "<user_query>".length(), end).trim();
        }
        return text;
    }

    private static boolean isRuntimeContextUserText(String raw) {
        if (raw == null) {
            return true;
        }
        String t = raw.trim();
        if (t.isEmpty()) {
            return true;
        }
        return t.startsWith("<user_info>")
                || t.startsWith("<git_status>")
                || t.startsWith("<system-reminder>")
                || t.contains("<system-reminder>");
    }

    /**
     * Single-pass scan of chat_history.jsonl: counts non-empty lines and (when
     * {@code captureFirstUserPrompt}) captures the first real user prompt.
     */
    private static ChatHistoryMeta scanChatHistoryMeta(Path chatPath, boolean captureFirstUserPrompt) throws IOException {
        ChatHistoryMeta meta = new ChatHistoryMeta();
        try (BufferedReader reader = Files.newBufferedReader(chatPath, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }
                meta.nonEmptyLines++;
                if (!captureFirstUserPrompt || meta.firstUserPrompt != null) {
                    continue;
                }
                if (!line.contains("\"type\":\"user\"") && !line.contains("\"type\": \"user\"")) {
                    continue;
                }
                try {
                    JsonObject value = JsonParser.parseString(line).getAsJsonObject();
                    if (value.has("synthetic_reason")) {
                        continue;
                    }
                    String raw = extractContentText(resolveMessageContent(value));
                    if (isRuntimeContextUserText(raw)) {
                        continue;
                    }
                    String display = stripUserQueryWrapper(raw);
                    if (!display.isEmpty()) {
                        meta.firstUserPrompt = display;
                    }
                } catch (Exception ignored) {
                }
            }
        }
        return meta;
    }

    private static final class ChatHistoryMeta {
        int nonEmptyLines;
        String firstUserPrompt;
    }

    private static long fileMtimeMillis(Path path) {
        try {
            if (path != null && Files.isRegularFile(path)) {
                return Files.getLastModifiedTime(path).toMillis();
            }
        } catch (IOException ignored) {
        }
        return 0L;
    }

    private static long parseRfc3339Millis(JsonObject obj, String field) {
        if (!obj.has(field) || obj.get(field).isJsonNull()) {
            return 0L;
        }
        try {
            return Instant.parse(obj.get(field).getAsString()).toEpochMilli();
        } catch (Exception e) {
            return 0L;
        }
    }

    static String encodeCwd(String cwd) {
        String normalized = normalizePath(cwd);
        return URLEncoder.encode(normalized, StandardCharsets.UTF_8);
    }

    static String decodeCwdDirName(String name) {
        try {
            return URLDecoder.decode(name, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return name;
        }
    }

    static String normalizePath(String path) {
        return HistoryPathMatcher.normalize(path);
    }

    private static String canonicalizePath(String path) {
        try {
            return Paths.get(path).toRealPath().toString();
        } catch (Exception e) {
            return path;
        }
    }

    static boolean pathsMatch(String sessionCwd, String projectPath) {
        return HistoryPathMatcher.matches(sessionCwd, projectPath);
    }

    private static String truncate(String value, int maxChars) {
        if (value == null) {
            return "";
        }
        if (value.length() <= maxChars) {
            return value;
        }
        return value.substring(0, maxChars) + "…";
    }

    private static void deleteRecursively(Path path) throws IOException {
        if (!Files.exists(path)) {
            return;
        }
        if (Files.isDirectory(path)) {
            try (DirectoryStream<Path> stream = Files.newDirectoryStream(path)) {
                for (Path child : stream) {
                    deleteRecursively(child);
                }
            }
        }
        Files.deleteIfExists(path);
    }
}
