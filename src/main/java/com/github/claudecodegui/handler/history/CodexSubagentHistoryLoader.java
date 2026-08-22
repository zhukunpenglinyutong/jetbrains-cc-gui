package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Resolves and converts one Codex subagent turn from local rollout files.
 */
final class CodexSubagentHistoryLoader {

    private static final Logger LOG = Logger.getInstance(CodexSubagentHistoryLoader.class);
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9_-]+");
    private static final Pattern SAFE_AGENT_PATH =
            Pattern.compile("/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*");
    private static final int MAX_CACHE_ENTRIES = 256;
    static final int MAX_STATUS_REQUESTS = 64;
    /**
     * Status polling runs on a fixed two-second cadence, so directory scans
     * younger than this are reused instead of walking the sessions tree again.
     */
    private static final long SESSION_SCAN_TTL_MS = 2_000;

    private final Path sessionsDir;
    private final Map<LookupKey, Location> locationCache =
            Collections.synchronizedMap(new LinkedHashMap<LookupKey, Location>(32, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<LookupKey, Location> eldest) {
                    return size() > MAX_CACHE_ENTRIES;
                }
            });
    private final Map<String, CachedSessionFile> sessionFileCache =
            Collections.synchronizedMap(new LinkedHashMap<String, CachedSessionFile>(32, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, CachedSessionFile> eldest) {
                    return size() > MAX_CACHE_ENTRIES;
                }
            });
    private volatile CachedSessionIndex sessionIndexCache;

    CodexSubagentHistoryLoader(Path sessionsDir) {
        this.sessionsDir = sessionsDir;
    }

    Result load(String parentSessionId, String toolUseId, String requestedAgentPath) throws IOException {
        validateId("sessionId", parentSessionId);
        if (toolUseId != null && !toolUseId.isBlank()) {
            validateId("toolUseId", toolUseId);
        }
        if (requestedAgentPath != null && !requestedAgentPath.isBlank()) {
            validateAgentPath(requestedAgentPath);
        }
        if ((toolUseId == null || toolUseId.isBlank())
                && (requestedAgentPath == null || requestedAgentPath.isBlank())) {
            throw new IllegalArgumentException("Missing toolUseId and agentPath");
        }

        LookupKey key = new LookupKey("codex", parentSessionId, toolUseId, requestedAgentPath, null);
        Location location = locationCache.get(key);
        if (location == null || !Files.isRegularFile(location.file())) {
            location = resolveLocation(parentSessionId, toolUseId, requestedAgentPath);
            locationCache.put(key, location);
        }

        JsonArray rollout = readInitialSubagentRollout(location.file());
        TurnSlice turn = extractInitialSubagentTurn(rollout);
        JsonArray frontendMessages = new JsonArray();
        for (JsonObject message : HistoryMessageInjector.convertCodexMessagesToFrontendBatch(turn.messages())) {
            frontendMessages.add(message);
        }
        return new Result(
                location.agentThreadId(),
                location.agentPath(),
                frontendMessages,
                turn.status(),
                turn.error()
        );
    }

    List<StatusResult> loadStatuses(String parentSessionId, List<StatusRequest> requests) throws IOException {
        validateId("sessionId", parentSessionId);
        if (requests == null || requests.size() > MAX_STATUS_REQUESTS) {
            throw new IllegalArgumentException("Invalid agents count");
        }
        for (StatusRequest request : requests) {
            validateStatusRequest(request);
        }
        if (requests.isEmpty()) {
            return List.of();
        }

        List<StatusResult> results = new ArrayList<>(Collections.nCopies(requests.size(), null));
        List<Integer> unresolvedIndexes = new ArrayList<>();
        for (int i = 0; i < requests.size(); i++) {
            StatusRequest request = requests.get(i);
            Location cached = locationCache.get(statusLookupKey(parentSessionId, request));
            if (cached != null && Files.isRegularFile(cached.file())) {
                results.set(i, readStatus(request, cached));
            } else {
                unresolvedIndexes.add(i);
            }
        }
        if (unresolvedIndexes.isEmpty()) {
            return results;
        }

        Set<String> requestedToolUseIds = new HashSet<>();
        for (int index : unresolvedIndexes) {
            String toolUseId = requests.get(index).toolUseId();
            if (toolUseId != null && !toolUseId.isBlank()) {
                requestedToolUseIds.add(toolUseId);
            }
        }

        ActivityLookup activities = ActivityLookup.empty();
        String activityPendingError = null;
        String activityFailure = null;
        if (!requestedToolUseIds.isEmpty()) {
            try {
                activities = findActivityLocations(findExactSessionFile(parentSessionId), requestedToolUseIds);
            } catch (PendingException e) {
                activityPendingError = e.getMessage();
            } catch (IOException e) {
                // Transient read failure (slow disk, file mid-write): stay
                // retryable instead of failing the whole batch permanently.
                activityPendingError = errorMessage(e);
            } catch (Exception e) {
                activityFailure = errorMessage(e);
            }
        }

        Set<String> requiredThreadIds = new HashSet<>();
        boolean needsLegacyLookup = false;
        for (int index : unresolvedIndexes) {
            StatusRequest request = requests.get(index);
            Location activity = request.toolUseId() != null
                    ? activities.locations().get(request.toolUseId())
                    : null;
            if (activity != null) {
                requiredThreadIds.add(activity.agentThreadId());
            }
            if (request.agentId() != null && !request.agentId().isBlank()) {
                requiredThreadIds.add(request.agentId());
            }
            if (activity == null && activityPendingError == null
                    && request.agentPath() != null && !request.agentPath().isBlank()) {
                needsLegacyLookup = true;
            }
        }

        SessionIndex sessionIndex;
        try {
            sessionIndex = buildSessionIndex(parentSessionId, requiredThreadIds, needsLegacyLookup);
        } catch (PendingException e) {
            sessionIndex = SessionIndex.empty();
            if (activityPendingError == null) {
                activityPendingError = e.getMessage();
            }
        }

        for (int index : unresolvedIndexes) {
            StatusRequest request = requests.get(index);
            StatusResult resolutionFailure = resolveFailure(
                    request,
                    activities,
                    activityPendingError,
                    activityFailure
            );
            if (resolutionFailure != null) {
                results.set(index, resolutionFailure);
                continue;
            }

            Location location;
            try {
                location = resolveBatchLocation(parentSessionId, request, activities, sessionIndex);
            } catch (PendingException e) {
                results.set(index, pendingStatus(request, e.getMessage()));
                continue;
            } catch (Exception e) {
                results.set(index, failedStatus(request, errorMessage(e)));
                continue;
            }

            locationCache.put(statusLookupKey(parentSessionId, request), location);
            results.set(index, readStatus(request, location));
        }
        return results;
    }

    private static void validateStatusRequest(StatusRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("Invalid agent request");
        }
        if (request.toolUseId() != null && !request.toolUseId().isBlank()) {
            validateId("toolUseId", request.toolUseId());
        }
        if (request.agentId() != null && !request.agentId().isBlank()) {
            validateId("agentId", request.agentId());
        }
        if (request.agentPath() != null && !request.agentPath().isBlank()) {
            validateAgentPath(request.agentPath());
        }
        if ((request.toolUseId() == null || request.toolUseId().isBlank())
                && (request.agentId() == null || request.agentId().isBlank())
                && (request.agentPath() == null || request.agentPath().isBlank())) {
            throw new IllegalArgumentException("Missing agent identifier");
        }
    }

    private LookupKey statusLookupKey(String parentSessionId, StatusRequest request) {
        return new LookupKey("codex", parentSessionId, request.toolUseId(), request.agentPath(), request.agentId());
    }

    private StatusResult resolveFailure(
            StatusRequest request,
            ActivityLookup activities,
            String activityPendingError,
            String activityFailure
    ) {
        if (request.toolUseId() == null || request.toolUseId().isBlank()) {
            return null;
        }
        if (activities.ambiguousToolUseIds().contains(request.toolUseId())) {
            return failedStatus(request, "Ambiguous Codex subagent activity");
        }
        if (activityFailure != null) {
            return failedStatus(request, activityFailure);
        }
        if (activityPendingError != null && (request.agentId() == null || request.agentId().isBlank())) {
            return pendingStatus(request, activityPendingError);
        }
        return null;
    }

    private Location resolveBatchLocation(
            String parentSessionId,
            StatusRequest request,
            ActivityLookup activities,
            SessionIndex sessionIndex
    ) {
        Location activity = request.toolUseId() != null
                ? activities.locations().get(request.toolUseId())
                : null;
        if (activity != null) {
            return exactLocation(activity.agentThreadId(), activity.agentPath(), sessionIndex);
        }
        if (request.agentId() != null && !request.agentId().isBlank()) {
            Location direct = exactLocation(request.agentId(), request.agentPath(), sessionIndex);
            JsonObject meta = readSessionMeta(direct.file());
            if (meta == null) {
                // Null means the file is unreadable or not fully written yet.
                // Retry on the next poll instead of misreporting a transient
                // read failure as a permanent ownership error.
                throw new PendingException("Codex subagent metadata not readable yet: " + request.agentId());
            }
            if (!parentSessionId.equals(getParentThreadId(meta))) {
                throw new IllegalStateException("Codex subagent does not belong to parent session");
            }
            return new Location(direct.file(), request.agentId(), getAgentPath(meta));
        }
        if (request.agentPath() == null || request.agentPath().isBlank()) {
            throw new PendingException("Codex subagent activity not found yet");
        }

        List<Location> matches = sessionIndex.legacyLocations().stream()
                .filter(location -> matchesAgentPath(request.agentPath(), location.agentPath()))
                .toList();
        if (matches.isEmpty()) {
            throw new PendingException("Codex subagent rollout not found yet");
        }
        if (matches.size() > 1) {
            throw new IllegalStateException("Ambiguous Codex subagent rollout for agentPath");
        }
        return matches.get(0);
    }

    private Location exactLocation(String threadId, String agentPath, SessionIndex sessionIndex) {
        List<Path> matches = sessionIndex.filesByThreadId().getOrDefault(threadId, List.of());
        if (matches.isEmpty()) {
            throw new PendingException("Codex session rollout not found yet: " + threadId);
        }
        if (matches.size() > 1) {
            throw new IllegalStateException("Ambiguous Codex session rollout: " + threadId);
        }
        return new Location(matches.get(0), threadId, agentPath);
    }

    private ActivityLookup findActivityLocations(Path parentFile, Set<String> requestedToolUseIds) throws IOException {
        Map<String, Location> locations = new HashMap<>();
        Set<String> ambiguousToolUseIds = new HashSet<>();
        try (Stream<String> lines = Files.lines(parentFile, StandardCharsets.UTF_8)) {
            for (java.util.Iterator<String> iterator = lines.iterator(); iterator.hasNext();) {
                String line = iterator.next();
                if (line.isBlank()) {
                    continue;
                }
                JsonObject payload = eventPayload(parseObject(line), "sub_agent_activity");
                String toolUseId = getString(payload, "event_id");
                if (toolUseId == null || !requestedToolUseIds.contains(toolUseId)) {
                    continue;
                }
                String threadId = getString(payload, "agent_thread_id");
                if (threadId == null || threadId.isBlank()) {
                    continue;
                }
                validateId("agentThreadId", threadId);
                Location previous = locations.get(toolUseId);
                if (previous != null && !previous.agentThreadId().equals(threadId)) {
                    ambiguousToolUseIds.add(toolUseId);
                    locations.remove(toolUseId);
                    continue;
                }
                if (!ambiguousToolUseIds.contains(toolUseId)) {
                    locations.put(toolUseId, new Location(null, threadId, getString(payload, "agent_path")));
                }
            }
        }
        return new ActivityLookup(locations, ambiguousToolUseIds);
    }

    private SessionIndex buildSessionIndex(
            String parentSessionId,
            Set<String> requiredThreadIds,
            boolean needsLegacyLookup
    ) throws IOException {
        String cacheKey = parentSessionId + "\n" + String.join(",", new TreeSet<>(requiredThreadIds))
                + "\n" + needsLegacyLookup;
        CachedSessionIndex cached = sessionIndexCache;
        long now = System.currentTimeMillis();
        if (cached != null
                && cached.key().equals(cacheKey)
                && now - cached.timestamp() < SESSION_SCAN_TTL_MS) {
            return cached.index();
        }
        SessionIndex index = scanSessionIndex(parentSessionId, requiredThreadIds, needsLegacyLookup);
        sessionIndexCache = new CachedSessionIndex(now, cacheKey, index);
        return index;
    }

    private SessionIndex scanSessionIndex(
            String parentSessionId,
            Set<String> requiredThreadIds,
            boolean needsLegacyLookup
    ) throws IOException {
        if (!Files.isDirectory(sessionsDir)) {
            throw new PendingException("Codex sessions directory not found yet");
        }
        Map<String, List<Path>> filesByThreadId = new HashMap<>();
        List<Location> legacyLocations = new ArrayList<>();
        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            for (java.util.Iterator<Path> iterator = paths.iterator(); iterator.hasNext();) {
                Path path = iterator.next();
                if (!Files.isRegularFile(path) || !path.getFileName().toString().endsWith(".jsonl")) {
                    continue;
                }
                String fileName = path.getFileName().toString();
                for (String threadId : requiredThreadIds) {
                    if (fileName.endsWith("-" + threadId + ".jsonl")) {
                        filesByThreadId.computeIfAbsent(threadId, ignored -> new ArrayList<>()).add(path);
                    }
                }
                if (!needsLegacyLookup) {
                    continue;
                }
                JsonObject meta = readSessionMeta(path);
                if (meta == null || !parentSessionId.equals(getParentThreadId(meta))) {
                    continue;
                }
                String threadId = getString(meta, "id");
                if (threadId != null) {
                    legacyLocations.add(new Location(path, threadId, getAgentPath(meta)));
                }
            }
        }
        return new SessionIndex(filesByThreadId, legacyLocations);
    }

    private StatusResult readStatus(StatusRequest request, Location location) {
        try {
            StatusSlice status = readInitialSubagentStatus(location.file());
            return new StatusResult(
                    request.toolUseId(),
                    location.agentPath() != null ? location.agentPath() : request.agentPath(),
                    location.agentThreadId(),
                    true,
                    status.status(),
                    status.error()
            );
        } catch (PendingException e) {
            return pendingStatus(request, e.getMessage());
        } catch (IOException e) {
            // Transient read failure (slow disk, file mid-write): stay
            // retryable instead of locking the agent into a terminal error.
            return pendingStatus(request, errorMessage(e));
        } catch (Exception e) {
            return failedStatus(request, errorMessage(e));
        }
    }

    private StatusSlice readInitialSubagentStatus(Path file) throws IOException {
        boolean afterSessionMeta = false;
        Set<String> startedTurnIds = new HashSet<>();
        String turnId = null;
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (java.util.Iterator<String> iterator = lines.iterator(); iterator.hasNext();) {
                String line = iterator.next();
                if (line.isBlank()) {
                    continue;
                }
                JsonObject record = parseObject(line);
                if (record == null) {
                    continue;
                }
                if ("session_meta".equals(getString(record, "type"))) {
                    afterSessionMeta = true;
                    startedTurnIds.clear();
                    turnId = null;
                    continue;
                }
                if (!afterSessionMeta) {
                    continue;
                }
                JsonObject started = eventPayload(record, "task_started");
                if (started != null) {
                    String startedTurnId = getString(started, "turn_id");
                    if (startedTurnId != null) {
                        startedTurnIds.add(startedTurnId);
                    }
                }
                if (turnId == null && "turn_context".equals(getString(record, "type"))
                        && record.has("payload") && record.get("payload").isJsonObject()) {
                    turnId = getString(record.getAsJsonObject("payload"), "turn_id");
                    continue;
                }
                if (turnId != null && matchesTurnEvent(record, "task_complete", turnId)) {
                    if (!startedTurnIds.contains(turnId)) {
                        throw new PendingException("Codex subagent turn start not found yet");
                    }
                    return new StatusSlice("completed", null);
                }
                if (turnId != null && matchesTurnEvent(record, "turn_aborted", turnId)) {
                    if (!startedTurnIds.contains(turnId)) {
                        throw new PendingException("Codex subagent turn start not found yet");
                    }
                    return new StatusSlice("error", "Codex subagent turn was aborted");
                }
            }
        }
        if (turnId == null) {
            throw new PendingException("Codex subagent turn context not found yet");
        }
        if (!startedTurnIds.contains(turnId)) {
            throw new PendingException("Codex subagent turn start not found yet");
        }
        return new StatusSlice("running", null);
    }

    private static StatusResult pendingStatus(StatusRequest request, String error) {
        return new StatusResult(
                request.toolUseId(), request.agentPath(), request.agentId(), false, "running", error);
    }

    private static StatusResult failedStatus(StatusRequest request, String error) {
        return new StatusResult(
                request.toolUseId(), request.agentPath(), request.agentId(), false, "error", error);
    }

    private static String errorMessage(Exception e) {
        return e.getMessage() != null ? e.getMessage() : "Unknown error";
    }

    private Location resolveLocation(
            String parentSessionId,
            String toolUseId,
            String requestedAgentPath
    ) throws IOException {
        if (toolUseId != null && !toolUseId.isBlank()) {
            Path parentFile = findExactSessionFile(parentSessionId);
            Location activityLocation = findActivityLocation(parentFile, toolUseId);
            if (activityLocation != null) {
                Path childFile = findExactSessionFile(activityLocation.agentThreadId());
                return new Location(childFile, activityLocation.agentThreadId(), activityLocation.agentPath());
            }
        }

        if (requestedAgentPath == null || requestedAgentPath.isBlank()) {
            throw new PendingException("Codex subagent activity not found yet");
        }
        return findLegacyLocation(parentSessionId, requestedAgentPath);
    }

    private Location findActivityLocation(Path parentFile, String toolUseId) throws IOException {
        Location matched = null;
        try (Stream<String> lines = Files.lines(parentFile, StandardCharsets.UTF_8)) {
            for (java.util.Iterator<String> iterator = lines.iterator(); iterator.hasNext();) {
                String line = iterator.next();
                if (line.isBlank()) {
                    continue;
                }
                JsonObject record = parseObject(line);
                JsonObject payload = eventPayload(record, "sub_agent_activity");
                if (payload == null || !toolUseId.equals(getString(payload, "event_id"))) {
                    continue;
                }
                String threadId = getString(payload, "agent_thread_id");
                if (threadId == null || threadId.isBlank()) {
                    continue;
                }
                validateId("agentThreadId", threadId);
                String agentPath = getString(payload, "agent_path");
                if (matched != null && !matched.agentThreadId().equals(threadId)) {
                    throw new IllegalStateException("Ambiguous Codex subagent activity");
                }
                matched = new Location(null, threadId, agentPath);
            }
        }
        return matched;
    }

    private Location findLegacyLocation(String parentSessionId, String agentPath) throws IOException {
        List<Location> matches = new ArrayList<>();
        if (!Files.isDirectory(sessionsDir)) {
            throw new PendingException("Codex sessions directory not found yet");
        }
        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            paths.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(".jsonl"))
                    .forEach(path -> {
                        JsonObject meta = readSessionMeta(path);
                        if (meta == null) {
                            return;
                        }
                        String candidateParent = getParentThreadId(meta);
                        String candidatePath = getAgentPath(meta);
                        String threadId = getString(meta, "id");
                        if (parentSessionId.equals(candidateParent)
                                && matchesAgentPath(agentPath, candidatePath)
                                && threadId != null) {
                            matches.add(new Location(path, threadId, candidatePath));
                        }
                    });
        }
        if (matches.isEmpty()) {
            throw new PendingException("Codex subagent rollout not found yet");
        }
        if (matches.size() > 1) {
            throw new IllegalStateException("Ambiguous Codex subagent rollout for agentPath");
        }
        return matches.get(0);
    }

    private Path findExactSessionFile(String sessionId) throws IOException {
        CachedSessionFile cached = sessionFileCache.get(sessionId);
        long now = System.currentTimeMillis();
        if (cached != null
                && now - cached.timestamp() < SESSION_SCAN_TTL_MS
                && Files.isRegularFile(cached.file())) {
            return cached.file();
        }
        Path resolved = scanExactSessionFile(sessionId);
        sessionFileCache.put(sessionId, new CachedSessionFile(now, resolved));
        return resolved;
    }

    private Path scanExactSessionFile(String sessionId) throws IOException {
        if (!Files.isDirectory(sessionsDir)) {
            throw new PendingException("Codex sessions directory not found yet");
        }
        String suffix = "-" + sessionId + ".jsonl";
        List<Path> matches;
        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            matches = paths.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().endsWith(suffix))
                    .limit(2)
                    .toList();
        }
        if (matches.isEmpty()) {
            throw new PendingException("Codex session rollout not found yet: " + sessionId);
        }
        if (matches.size() > 1) {
            throw new IllegalStateException("Ambiguous Codex session rollout: " + sessionId);
        }
        return matches.get(0);
    }

    private JsonObject readSessionMeta(Path file) {
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (java.util.Iterator<String> iterator = lines.iterator(); iterator.hasNext();) {
                String line = iterator.next();
                if (line.isBlank()) {
                    continue;
                }
                JsonObject record = parseObject(line);
                if (record == null || !"session_meta".equals(getString(record, "type"))
                        || !record.has("payload") || !record.get("payload").isJsonObject()) {
                    continue;
                }
                return record.getAsJsonObject("payload");
            }
            return null;
        } catch (IOException e) {
            LOG.debug("Failed to read Codex session metadata: " + e.getMessage());
            return null;
        }
    }

    private JsonArray readInitialSubagentRollout(Path file) throws IOException {
        JsonArray messages = new JsonArray();
        boolean afterSessionMeta = false;
        String turnId = null;
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            for (java.util.Iterator<String> iterator = lines.iterator(); iterator.hasNext();) {
                String line = iterator.next();
                if (line.isBlank()) {
                    continue;
                }
                JsonObject record = parseObject(line);
                if (record == null) {
                    continue;
                }
                if ("session_meta".equals(getString(record, "type"))) {
                    messages = new JsonArray();
                    afterSessionMeta = true;
                    turnId = null;
                }
                if (!afterSessionMeta) {
                    continue;
                }
                messages.add(record);
                if (turnId == null && "turn_context".equals(getString(record, "type"))
                        && record.has("payload") && record.get("payload").isJsonObject()) {
                    turnId = getString(record.getAsJsonObject("payload"), "turn_id");
                    continue;
                }
                if (turnId != null && (matchesTurnEvent(record, "task_complete", turnId)
                        || matchesTurnEvent(record, "turn_aborted", turnId))) {
                    break;
                }
            }
        }
        return messages;
    }

    private static boolean matchesTurnEvent(JsonObject record, String eventType, String turnId) {
        JsonObject payload = eventPayload(record, eventType);
        return payload != null && turnId.equals(getString(payload, "turn_id"));
    }

    private JsonObject parseObject(String line) {
        try {
            JsonElement parsed = JsonParser.parseString(line);
            return parsed.isJsonObject() ? parsed.getAsJsonObject() : null;
        } catch (JsonSyntaxException e) {
            LOG.warn("Skipping malformed JSONL line in Codex subagent history: " + e.getMessage());
            return null;
        }
    }

    static TurnSlice extractInitialSubagentTurn(JsonArray rollout) {
        int sessionMetaIndex = -1;
        for (int i = 0; i < rollout.size(); i++) {
            if (rollout.get(i).isJsonObject()
                    && "session_meta".equals(getString(rollout.get(i).getAsJsonObject(), "type"))) {
                sessionMetaIndex = i;
            }
        }

        String turnId = null;
        int contextIndex = -1;
        for (int i = sessionMetaIndex + 1; i < rollout.size(); i++) {
            if (!rollout.get(i).isJsonObject()) {
                continue;
            }
            JsonObject record = rollout.get(i).getAsJsonObject();
            if (!"turn_context".equals(getString(record, "type"))
                    || !record.has("payload") || !record.get("payload").isJsonObject()) {
                continue;
            }
            turnId = getString(record.getAsJsonObject("payload"), "turn_id");
            if (turnId != null) {
                contextIndex = i;
                break;
            }
        }
        if (turnId == null) {
            throw new PendingException("Codex subagent turn context not found yet");
        }

        int startIndex = -1;
        for (int i = sessionMetaIndex + 1; i <= contextIndex; i++) {
            JsonObject payload = eventPayload(rollout.get(i), "task_started");
            if (payload != null && turnId.equals(getString(payload, "turn_id"))) {
                startIndex = i;
            }
        }
        if (startIndex < 0) {
            throw new PendingException("Codex subagent turn start not found yet");
        }

        JsonArray turnMessages = new JsonArray();
        String status = "running";
        String error = null;
        for (int i = startIndex; i < rollout.size(); i++) {
            JsonElement record = rollout.get(i);
            turnMessages.add(record.deepCopy());
            JsonObject completed = eventPayload(record, "task_complete");
            if (completed != null && turnId.equals(getString(completed, "turn_id"))) {
                status = "completed";
                break;
            }
            JsonObject aborted = eventPayload(record, "turn_aborted");
            if (aborted != null && turnId.equals(getString(aborted, "turn_id"))) {
                status = "error";
                error = "Codex subagent turn was aborted";
                break;
            }
        }
        return new TurnSlice(turnMessages, status, error);
    }

    private static JsonObject eventPayload(JsonElement element, String payloadType) {
        if (element == null || !element.isJsonObject()) {
            return null;
        }
        JsonObject record = element.getAsJsonObject();
        if (!"event_msg".equals(getString(record, "type"))
                || !record.has("payload") || !record.get("payload").isJsonObject()) {
            return null;
        }
        JsonObject payload = record.getAsJsonObject("payload");
        return payloadType.equals(getString(payload, "type")) ? payload : null;
    }

    private static String getParentThreadId(JsonObject meta) {
        String direct = getString(meta, "parent_thread_id");
        if (direct != null) {
            return direct;
        }
        JsonObject spawn = getThreadSpawn(meta);
        return spawn != null ? getString(spawn, "parent_thread_id") : null;
    }

    private static String getAgentPath(JsonObject meta) {
        String direct = getString(meta, "agent_path");
        if (direct != null) {
            return direct;
        }
        JsonObject spawn = getThreadSpawn(meta);
        return spawn != null ? getString(spawn, "agent_path") : null;
    }

    private static JsonObject getThreadSpawn(JsonObject meta) {
        if (!meta.has("source") || !meta.get("source").isJsonObject()) {
            return null;
        }
        JsonObject source = meta.getAsJsonObject("source");
        if (!source.has("subagent") || !source.get("subagent").isJsonObject()) {
            return null;
        }
        JsonObject subagent = source.getAsJsonObject("subagent");
        return subagent.has("thread_spawn") && subagent.get("thread_spawn").isJsonObject()
                ? subagent.getAsJsonObject("thread_spawn") : null;
    }

    private static String getString(JsonObject object, String key) {
        if (object == null || !object.has(key) || object.get(key).isJsonNull()) {
            return null;
        }
        return object.get(key).getAsString();
    }

    private static void validateId(String name, String value) {
        if (value == null || value.isBlank() || !SAFE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("Invalid " + name);
        }
    }

    private static void validateAgentPath(String value) {
        if (value.length() > 500
                || (!SAFE_AGENT_PATH.matcher(value).matches() && !SAFE_ID.matcher(value).matches())) {
            throw new IllegalArgumentException("Invalid agentPath");
        }
        // The SAFE_AGENT_PATH alphabet technically matches ".." segments.
        // Reject them explicitly so a future path-concatenation sink can never
        // turn an agentPath into a traversal.
        for (String segment : value.split("/")) {
            if ("..".equals(segment)) {
                throw new IllegalArgumentException("Invalid agentPath");
            }
        }
    }

    private static boolean matchesAgentPath(String requested, String candidate) {
        if (candidate == null) {
            return false;
        }
        return requested.equals(candidate)
                || (!requested.startsWith("/") && candidate.endsWith("/" + requested));
    }

    record Result(
            String agentThreadId,
            String agentPath,
            JsonArray messages,
            String status,
            String error
    ) {
        boolean completed() {
            return "completed".equals(status);
        }
    }

    record TurnSlice(JsonArray messages, String status, String error) {
    }

    record StatusRequest(String toolUseId, String agentPath, String agentId) {
    }

    record StatusResult(
            String toolUseId,
            String agentPath,
            String agentId,
            boolean success,
            String status,
            String error
    ) {
        boolean completed() {
            return "completed".equals(status);
        }
    }

    private record StatusSlice(String status, String error) {
    }

    private record LookupKey(
            String provider,
            String parentSessionId,
            String toolUseId,
            String agentPath,
            String agentId
    ) {
    }

    private record Location(Path file, String agentThreadId, String agentPath) {
    }

    private record ActivityLookup(Map<String, Location> locations, Set<String> ambiguousToolUseIds) {
        private static ActivityLookup empty() {
            return new ActivityLookup(Map.of(), Set.of());
        }
    }

    private record CachedSessionFile(long timestamp, Path file) {
    }

    private record CachedSessionIndex(long timestamp, String key, SessionIndex index) {
    }

    private record SessionIndex(Map<String, List<Path>> filesByThreadId, List<Location> legacyLocations) {
        private static SessionIndex empty() {
            return new SessionIndex(Map.of(), List.of());
        }
    }

    static final class PendingException extends IllegalStateException {
        PendingException(String message) {
            super(message);
        }
    }
}
