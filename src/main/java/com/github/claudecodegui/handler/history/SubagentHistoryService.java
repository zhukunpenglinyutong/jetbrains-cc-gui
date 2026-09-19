package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Reads Claude Code sidechain subagent logs for display inside Agent cards.
 */
class SubagentHistoryService {

    private static final Logger LOG = Logger.getInstance(SubagentHistoryService.class);
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9_-]+");
    private static final Pattern SAFE_REQUEST_ID = Pattern.compile("[A-Za-z0-9_:-]{1,256}");
    private static final Gson GSON = new Gson();
    private static final int MAX_JSONL_LINES = 50_000;
    /**
     * How long a torn tail may sit unmodified before the writer is presumed gone.
     * A live writer completes a mid-append line within milliseconds; a line still
     * torn after this grace means the process crashed or was killed, and polling
     * must not report "running" forever.
     */
    private static final long TORN_TAIL_GRACE_MS = 10_000;

    private final HandlerContext context;
    private final CodexSubagentHistoryLoader codexLoader;
    private final Set<String> inFlightCodexRequests = ConcurrentHashMap.newKeySet();
    private final Set<String> inFlightCodexStatusSessions = ConcurrentHashMap.newKeySet();

    SubagentHistoryService(HandlerContext context) {
        this(context, new CodexSubagentHistoryLoader(
                Path.of(NodeDetector.resolveHomeForFileOps(), ".codex", "sessions")));
    }

    SubagentHistoryService(HandlerContext context, CodexSubagentHistoryLoader codexLoader) {
        this.context = context;
        this.codexLoader = codexLoader;
    }

    void handleLoadSubagentSession(String content) {
        JsonObject request = parseRequest(content);
        String sessionId = getString(request, "sessionId");
        String agentId = getString(request, "agentId");
        String agentPath = getString(request, "agentPath");
        String toolUseId = getString(request, "toolUseId");
        String description = getString(request, "description");
        String provider = getString(request, "provider");

        JsonObject response = new JsonObject();
        response.addProperty("toolUseId", toolUseId);
        response.addProperty("agentId", agentId);
        response.addProperty("agentPath", agentPath);
        response.addProperty("sessionId", sessionId);
        response.addProperty("provider", provider);

        if ("codex".equals(provider)) {
            loadCodexSubagentAsync(sessionId, toolUseId, agentPath, response);
            return;
        }
        if (provider != null && !"claude".equals(provider)) {
            response.addProperty("success", false);
            response.addProperty("status", "error");
            response.addProperty("error", "Invalid provider");
            sendResponse(response);
            return;
        }

        try {
            validateId("sessionId", sessionId);

            Path file = agentId != null && !agentId.isEmpty()
                    ? resolveSubagentFile(sessionId, agentId)
                    : resolveSubagentFileByDescription(sessionId, description);
            if (!Files.exists(file) || !Files.isRegularFile(file)) {
                response.addProperty("success", false);
                response.addProperty("status", "running");
                response.addProperty("error", "Subagent log not found");
                sendResponse(response);
                return;
            }

            String resolvedAgentId = extractAgentId(file);
            response.addProperty("agentId", resolvedAgentId);

            JsonArray messages = readJsonl(file);
            response.addProperty("success", true);
            response.addProperty("completed", hasCompleted(messages));
            response.addProperty("status", hasCompleted(messages) ? "completed" : "running");
            response.add("messages", messages);
        } catch (TranscriptIncompleteException e) {
            // The last line is still being appended: the subagent is healthy and
            // the panel's next poll retries. Reported as running with no error —
            // SubagentProcessError renders any error for Claude regardless of
            // status, which would flash a failure banner on a healthy subagent.
            LOG.debug("[SubagentHistory] Subagent log still being written: " + e.getMessage());
            response.addProperty("success", false);
            response.addProperty("completed", false);
            response.addProperty("status", "running");
        } catch (Exception e) {
            LOG.warn("[SubagentHistory] Failed to load subagent log: " + e.getMessage());
            response.addProperty("success", false);
            response.addProperty("status", "error");
            response.addProperty("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
        }

        sendResponse(response);
    }

    void handleLoadSubagentStatuses(String content) {
        JsonObject response = new JsonObject();
        response.add("statuses", new JsonArray());

        String sessionId = null;
        String provider = null;
        String requestId = null;
        List<CodexSubagentHistoryLoader.StatusRequest> agents;
        try {
            JsonObject request = parseRequest(content);
            sessionId = getString(request, "sessionId");
            provider = getString(request, "provider");
            requestId = getString(request, "requestId");
            response.addProperty("sessionId", sessionId);
            response.addProperty("provider", provider);
            response.addProperty("requestId", requestId);

            validateId("sessionId", sessionId);
            validateRequestId(requestId);
            if (!"codex".equals(provider)) {
                throw new IllegalArgumentException("Invalid provider");
            }
            if (!request.has("agents") || !request.get("agents").isJsonArray()) {
                throw new IllegalArgumentException("Invalid agents");
            }
            JsonArray agentArray = request.getAsJsonArray("agents");
            if (agentArray.size() > CodexSubagentHistoryLoader.MAX_STATUS_REQUESTS) {
                throw new IllegalArgumentException("Too many agents");
            }
            agents = parseStatusRequests(agentArray);
        } catch (Exception e) {
            response.addProperty("success", false);
            response.addProperty("error", e.getMessage() != null ? e.getMessage() : "Invalid request");
            sendStatusesResponse(response);
            return;
        }

        String responseSessionId = sessionId;
        if (!inFlightCodexStatusSessions.add(responseSessionId)) {
            response.addProperty("success", false);
            response.addProperty("error", "Codex subagent status request already in progress");
            sendStatusesResponse(response);
            return;
        }
        CompletableFuture.runAsync(() -> {
            try {
                List<CodexSubagentHistoryLoader.StatusResult> results =
                        codexLoader.loadStatuses(responseSessionId, agents);
                JsonArray statuses = new JsonArray();
                for (CodexSubagentHistoryLoader.StatusResult result : results) {
                    statuses.add(toJson(result));
                }
                response.addProperty("success", true);
                response.add("statuses", statuses);
            } catch (Exception e) {
                LOG.warn("[SubagentHistory] Failed to load Codex subagent statuses: " + e.getMessage());
                response.addProperty("success", false);
                response.addProperty("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
            } finally {
                inFlightCodexStatusSessions.remove(responseSessionId);
            }
            sendStatusesResponse(response);
        }, AppExecutorUtil.getAppExecutorService());
    }

    private static List<CodexSubagentHistoryLoader.StatusRequest> parseStatusRequests(JsonArray agents) {
        List<CodexSubagentHistoryLoader.StatusRequest> requests = new java.util.ArrayList<>(agents.size());
        for (JsonElement element : agents) {
            if (!element.isJsonObject()) {
                throw new IllegalArgumentException("Invalid agent request");
            }
            JsonObject agent = element.getAsJsonObject();
            requests.add(new CodexSubagentHistoryLoader.StatusRequest(
                    getString(agent, "toolUseId"),
                    getString(agent, "agentPath"),
                    getString(agent, "agentId")
            ));
        }
        return requests;
    }

    private static JsonObject toJson(CodexSubagentHistoryLoader.StatusResult result) {
        JsonObject status = new JsonObject();
        if (result.toolUseId() != null) {
            status.addProperty("toolUseId", result.toolUseId());
        }
        if (result.agentPath() != null) {
            status.addProperty("agentPath", result.agentPath());
        }
        if (result.agentId() != null) {
            status.addProperty("agentId", result.agentId());
        }
        status.addProperty("success", result.success());
        status.addProperty("completed", result.completed());
        status.addProperty("status", result.status());
        if (result.error() != null) {
            status.addProperty("error", result.error());
        }
        return status;
    }

    private void loadCodexSubagentAsync(
            String sessionId,
            String toolUseId,
            String agentPath,
            JsonObject response
    ) {
        String requestKey = "codex:" + sessionId + ":" + toolUseId + ":" + agentPath;
        if (!inFlightCodexRequests.add(requestKey)) {
            return;
        }
        CompletableFuture.runAsync(() -> {
            try {
                CodexSubagentHistoryLoader.Result result = codexLoader.load(sessionId, toolUseId, agentPath);
                response.addProperty("success", true);
                response.addProperty("completed", result.completed());
                response.addProperty("status", result.status());
                response.addProperty("agentId", result.agentThreadId());
                response.addProperty("agentPath", result.agentPath());
                response.add("messages", result.messages());
                if (result.error() != null) {
                    response.addProperty("error", result.error());
                }
            } catch (CodexSubagentHistoryLoader.PendingException e) {
                response.addProperty("success", false);
                response.addProperty("completed", false);
                response.addProperty("status", "running");
                response.addProperty("error", e.getMessage());
            } catch (Exception e) {
                LOG.warn("[SubagentHistory] Failed to load Codex subagent log: " + e.getMessage());
                response.addProperty("success", false);
                response.addProperty("completed", false);
                response.addProperty("status", "error");
                response.addProperty("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
            } finally {
                inFlightCodexRequests.remove(requestKey);
            }
            sendResponse(response);
        }, AppExecutorUtil.getAppExecutorService());
    }

    private JsonObject parseRequest(String content) {
        if (content == null || content.trim().isEmpty()) {
            return new JsonObject();
        }
        return JsonParser.parseString(content).getAsJsonObject();
    }

    private static String getString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static void validateId(String name, String value) {
        if (value == null || value.isEmpty() || !SAFE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("Invalid " + name);
        }
    }

    private static void validateRequestId(String value) {
        if (value == null || !SAFE_REQUEST_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("Invalid requestId");
        }
    }

    private Path resolveSubagentFile(String sessionId, String agentId) {
        validateId("agentId", agentId);
        List<String> projectKeys = projectKeys();
        for (String projectKey : projectKeys) {
            Path file = Path.of(NodeDetector.resolveHomeForFileOps(), ".claude", "projects", projectKey)
                    .resolve(sessionId)
                    .resolve("subagents")
                    .resolve("agent-" + agentId + ".jsonl")
                    .normalize();
            if (Files.isRegularFile(file)) {
                return file;
            }
        }
        return Path.of(NodeDetector.resolveHomeForFileOps(), ".claude", "projects", projectKeys.get(0))
                .resolve(sessionId)
                .resolve("subagents")
                .resolve("agent-" + agentId + ".jsonl")
                .normalize();
    }

    private Path resolveSubagentFileByDescription(String sessionId, String description) throws IOException {
        if (description == null || description.isEmpty()) {
            throw new IllegalArgumentException("Missing agentId and description");
        }

        List<Path> subagentsDirs = new ArrayList<>();
        for (String projectKey : projectKeys()) {
            Path subagentsDir = Path.of(NodeDetector.resolveHomeForFileOps(), ".claude", "projects", projectKey)
                    .resolve(sessionId)
                    .resolve("subagents")
                    .normalize();
            if (Files.isDirectory(subagentsDir)) {
                subagentsDirs.add(subagentsDir);
            }
        }
        if (subagentsDirs.isEmpty()) {
            return Path.of(NodeDetector.resolveHomeForFileOps(), ".claude", "projects", projectKeys().get(0))
                    .resolve(sessionId)
                    .resolve("subagents")
                    .resolve("missing.jsonl");
        }

        List<Path> metaFiles = new ArrayList<>();
        for (Path subagentsDir : subagentsDirs) {
            try (Stream<Path> stream = Files.list(subagentsDir)) {
                stream.filter(path -> path.getFileName().toString().endsWith(".meta.json"))
                        .filter(path -> description.equals(readDescription(path)))
                        .forEach(metaFiles::add);
            }
        }
        return metaFiles.stream()
                .max(Comparator.comparingLong(this::lastModifiedMillis))
                .map(this::metaToJsonl)
                .orElse(subagentsDirs.get(0).resolve("missing.jsonl"));
    }

    private String readDescription(Path metaFile) {
        try {
            JsonObject meta = JsonParser.parseString(Files.readString(metaFile, StandardCharsets.UTF_8)).getAsJsonObject();
            return getString(meta, "description");
        } catch (Exception e) {
            return null;
        }
    }

    private long lastModifiedMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private Path metaToJsonl(Path metaFile) {
        String name = metaFile.getFileName().toString().replaceFirst("\\.meta\\.json$", ".jsonl");
        return metaFile.resolveSibling(name);
    }

    private String extractAgentId(Path jsonlFile) {
        String name = jsonlFile.getFileName().toString();
        if (name.startsWith("agent-") && name.endsWith(".jsonl")) {
            return name.substring("agent-".length(), name.length() - ".jsonl".length());
        }
        return null;
    }

    private List<String> projectKeys() {
        String rawPath = context.getProject().getBasePath();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String basePath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        if (basePath == null || basePath.isEmpty()) {
            throw new IllegalStateException("Project base path is null");
        }
        return PathUtils.getSanitizedPathCandidates(basePath);
    }

    /**
     * Return the preferred project key for callers that only need one location.
     *
     * <p>The single-key method remains as a compatibility seam for existing tests and
     * integrations; subagent lookup uses {@link #projectKeys()} to support legacy paths.
     *
     * @return the canonical project key
     */
    private String projectKey() {
        return projectKeys().get(0);
    }

    /**
     * Signals that a transcript's last line is still being written.
     *
     * <p>Distinct from a read failure: the subagent is mid-append, so the caller
     * reports it as still running and lets the next poll retry, instead of
     * surfacing an error for a healthy subagent.</p>
     */
    static class TranscriptIncompleteException extends IOException {

        private static final long serialVersionUID = 1L;

        /**
         * Creates an exception for a transcript whose writer is mid-append.
         *
         * @param message description of the incomplete state
         */
        TranscriptIncompleteException(String message) {
            super(message);
        }
    }

    /**
     * Read a JSONL subagent transcript, skipping interior corruption but refusing
     * a transcript whose last line is torn.
     *
     * <p>Package-private and static so the torn-tail decision is unit-testable
     * without a HandlerContext.</p>
     *
     * @param file transcript to read
     * @return the parsed records, capped at {@link #MAX_JSONL_LINES}
     * @throws IOException when the writer is still mid-append
     */
    static JsonArray readJsonl(Path file) throws IOException {
        JsonArray messages = new JsonArray();
        // True while the most recent non-blank line failed to parse. A valid line
        // clears it, so this ends up describing the LAST non-blank line alone —
        // which is exactly what a torn tail is: only a malformed final line means
        // the writer is still mid-append. Interior corruption followed by valid
        // lines clears the flag and must not block reads forever, since retries
        // would re-read the same permanently damaged bytes.
        boolean tailMalformed = false;
        int acceptedLines = 0;
        // Streaming keeps memory flat for large subagent transcripts; every line still
        // participates in the torn-tail check even after the accepted-lines cap.
        // Decode with REPLACE, not Files.lines' REPORT: a mid-append read whose write
        // boundary splits a multi-byte UTF-8 character (CJK text, emoji) must degrade
        // to an unparseable last line — i.e. the torn-tail path below — instead of
        // throwing UncheckedIOException, which the caller cannot tell from a genuine
        // read failure and would surface as an error banner on a healthy subagent.
        // This mirrors the Node bridge, whose utf8 decoding emits U+FFFD.
        try (BufferedReader reader = newBufferedLenientReader(file)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                try {
                    JsonElement parsed = JsonParser.parseString(line);
                    tailMalformed = false;
                    if (acceptedLines < MAX_JSONL_LINES) {
                        messages.add(parsed);
                        acceptedLines++;
                    }
                } catch (JsonSyntaxException e) {
                    tailMalformed = true;
                    LOG.warn("Malformed JSONL line in subagent history: " + e.getMessage());
                }
            }
        }
        if (tailMalformed) {
            // A live writer finishes its mid-append line within milliseconds. If the
            // file has not changed beyond the grace window, the writer is gone and
            // the tail will never heal: serve the parseable prefix (the interior
            // corruption policy) instead of reporting "running" forever.
            if (isStaleTornTail(file)) {
                LOG.warn("Serving subagent history with a permanently torn tail (writer inactive): " + file);
                return messages;
            }
            throw new TranscriptIncompleteException(
                    "Subagent history is incomplete; retry after the history writer finishes");
        }
        return messages;
    }

    /**
     * Open a reader whose UTF-8 decoder replaces malformed input with U+FFFD
     * instead of throwing.
     */
    private static BufferedReader newBufferedLenientReader(Path file) throws IOException {
        return new BufferedReader(new InputStreamReader(Files.newInputStream(file),
                StandardCharsets.UTF_8.newDecoder()
                        .onMalformedInput(CodingErrorAction.REPLACE)
                        .onUnmappableCharacter(CodingErrorAction.REPLACE)));
    }

    /**
     * Return whether a torn tail has outlived {@link #TORN_TAIL_GRACE_MS}, meaning
     * the writer is presumed dead. An unreadable timestamp fails safe: keep
     * reporting the transcript as incomplete.
     */
    private static boolean isStaleTornTail(Path file) {
        try {
            long ageMs = System.currentTimeMillis() - Files.getLastModifiedTime(file).toMillis();
            return ageMs > TORN_TAIL_GRACE_MS;
        } catch (IOException e) {
            return false;
        }
    }

    static boolean hasCompleted(JsonArray messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            if (!messages.get(i).isJsonObject()) {
                continue;
            }
            JsonObject record = messages.get(i).getAsJsonObject();
            if (!"assistant".equals(getString(record, "type"))
                    || !record.has("message") || !record.get("message").isJsonObject()) {
                continue;
            }
            JsonObject message = record.getAsJsonObject("message");
            String stopReason = getString(message, "stop_reason");
            // The sidechain's last assistant stop_reason is the only persisted
            // completion signal (task_notification is a live event, not stored).
            // tool_use means the agent is still mid-turn (waiting on a tool
            // result); a null/missing value means streaming/incomplete. Any
            // other value (end_turn, stop_sequence, max_tokens, pause_turn,
            // refusal) means the agent's turn ended - treat it as terminal so
            // the UI does not stay stuck on "running" after a max_tokens or
            // refusal termination, which would reproduce the bug this fixes.
            return stopReason != null && !"tool_use".equals(stopReason);
        }
        return false;
    }

    private void sendResponse(JsonObject response) {
        if (context.getProject() == null || context.getProject().isDisposed()) {
            return;
        }
        String responseJson = GSON.toJson(response);
        String payload = JsUtils.escapeJs(responseJson);
        if (payload.length() <= HistoryMessageInjector.HISTORY_BATCH_TARGET_CHAR_LIMIT) {
            context.callJavaScript("onSubagentHistoryLoaded", payload);
            return;
        }

        String transferId = UUID.randomUUID().toString();
        List<String> chunks = HistoryMessageInjector.splitHistoryPayload(responseJson);
        for (int i = 0; i < chunks.size(); i++) {
            context.callJavaScript(
                    "onSubagentHistoryChunk",
                    transferId,
                    JsUtils.escapeJs(chunks.get(i)),
                    String.valueOf(i == chunks.size() - 1)
            );
        }
    }

    private void sendStatusesResponse(JsonObject response) {
        if (context.getProject() == null || context.getProject().isDisposed()) {
            return;
        }
        context.callJavaScript("onSubagentStatusesLoaded", JsUtils.escapeJs(GSON.toJson(response)));
    }
}
