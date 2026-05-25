package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PathUtils;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;
import com.intellij.util.concurrency.AppExecutorUtil;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * Reads Claude Code sidechain subagent logs for display inside Agent cards.
 */
class SubagentHistoryService {

    private static final Logger LOG = Logger.getInstance(SubagentHistoryService.class);
    private static final Pattern SAFE_ID = Pattern.compile("[A-Za-z0-9_-]+");
    private static final Gson GSON = new Gson();
    private static final int MAX_JSONL_LINES = 50_000;

    private final HandlerContext context;

    SubagentHistoryService(HandlerContext context) {
        this.context = context;
    }

    void handleLoadSubagentSession(String content) {
        JsonObject request = parseRequest(content);
        String sessionId = getString(request, "sessionId");
        String agentId = getString(request, "agentId");
        String toolUseId = getString(request, "toolUseId");
        String description = getString(request, "description");
        String provider = normalizeProvider(getString(request, "provider"), context.getCurrentProvider());

        JsonObject response = new JsonObject();
        response.addProperty("toolUseId", toolUseId);
        response.addProperty("agentId", agentId);
        response.addProperty("sessionId", sessionId);
        response.addProperty("provider", provider);

        if ("opencode".equals(provider)) {
            handleLoadOpenCodeSubagentSession(request, response);
            return;
        }

        try {
            validateId("sessionId", sessionId);

            Path file = agentId != null && !agentId.isEmpty()
                    ? resolveSubagentFile(sessionId, agentId)
                    : resolveSubagentFileByDescription(sessionId, description);
            if (!Files.exists(file) || !Files.isRegularFile(file)) {
                response.addProperty("success", false);
                response.addProperty("error", "Subagent log not found");
                sendResponse(response);
                return;
            }

            String resolvedAgentId = extractAgentId(file);
            response.addProperty("agentId", resolvedAgentId);

            JsonArray messages = readJsonl(file);
            response.addProperty("success", true);
            response.add("messages", messages);
        } catch (Exception e) {
            LOG.warn("[SubagentHistory] Failed to load subagent log: " + e.getMessage());
            response.addProperty("success", false);
            response.addProperty("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
        }

        sendResponse(response);
    }

    private void handleLoadOpenCodeSubagentSession(JsonObject request, JsonObject response) {
        CompletableFuture.runAsync(() -> {
            try {
                String childSessionId = getOpenCodeSubagentSessionId(request);
                if (childSessionId == null || childSessionId.isEmpty()) {
                    throw new IllegalArgumentException("opencode subagent session id unavailable");
                }
                validateId("subagentSessionId", childSessionId);

                if (!context.getSettingsService().isOpenCodeLocalConfigAuthorized()) {
                    throw new IllegalStateException("opencode access is not authorized");
                }

                if (context.getOpenCodeSDKBridge() == null) {
                    throw new IllegalStateException("opencode bridge is not available");
                }

                String cwd = resolveCwd();
                List<JsonObject> messages = context.getOpenCodeSDKBridge().getSessionMessages(childSessionId, cwd);
                JsonArray messageArray = new JsonArray();
                for (JsonObject message : messages) {
                    if (message != null) {
                        messageArray.add(message);
                    }
                }

                response.addProperty("success", true);
                response.addProperty("agentId", childSessionId);
                response.addProperty("subagentSessionId", childSessionId);
                response.addProperty("parentSessionId", getString(request, "sessionId"));
                response.addProperty("sessionId", childSessionId);
                response.add("messages", messageArray);
            } catch (Exception e) {
                LOG.warn("[SubagentHistory] Failed to load opencode subagent history: " + e.getMessage());
                response.addProperty("success", false);
                response.addProperty("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
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

    private static String normalizeProvider(String provider, String fallback) {
        String candidate = provider == null || provider.isBlank() ? fallback : provider;
        return candidate == null || candidate.isBlank() ? "claude" : candidate.trim().toLowerCase();
    }

    private static String getOpenCodeSubagentSessionId(JsonObject request) {
        String subagentSessionId = getString(request, "subagentSessionId");
        if (subagentSessionId != null && !subagentSessionId.isBlank()) {
            return subagentSessionId.trim();
        }
        String agentId = getString(request, "agentId");
        return agentId != null ? agentId.trim() : null;
    }

    private static void validateId(String name, String value) {
        if (value == null || value.isEmpty() || !SAFE_ID.matcher(value).matches()) {
            throw new IllegalArgumentException("Invalid " + name);
        }
    }

    private Path resolveSubagentFile(String sessionId, String agentId) {
        validateId("agentId", agentId);
        Path projectDir = Path.of(PlatformUtils.getHomeDirectory(), ".claude", "projects", projectKey());
        return projectDir.resolve(sessionId)
                .resolve("subagents")
                .resolve("agent-" + agentId + ".jsonl")
                .normalize();
    }

    private Path resolveSubagentFileByDescription(String sessionId, String description) throws IOException {
        if (description == null || description.isEmpty()) {
            throw new IllegalArgumentException("Missing agentId and description");
        }
        Path subagentsDir = Path.of(PlatformUtils.getHomeDirectory(), ".claude", "projects", projectKey())
                .resolve(sessionId)
                .resolve("subagents")
                .normalize();
        if (!Files.isDirectory(subagentsDir)) {
            return subagentsDir.resolve("missing.jsonl");
        }

        try (var stream = Files.list(subagentsDir)) {
            Optional<Path> meta = stream
                    .filter(path -> path.getFileName().toString().endsWith(".meta.json"))
                    .filter(path -> description.equals(readDescription(path)))
                    .max(Comparator.comparingLong(this::lastModifiedMillis));
            return meta.map(this::metaToJsonl).orElse(subagentsDir.resolve("missing.jsonl"));
        }
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

    private String projectKey() {
        String basePath = context.getProject().getBasePath();
        if (basePath == null || basePath.isEmpty()) {
            throw new IllegalStateException("Project base path is null");
        }
        return PathUtils.sanitizePath(basePath);
    }

    private String resolveCwd() {
        if (context.getSession() != null && context.getSession().getCwd() != null
                && !context.getSession().getCwd().isBlank()) {
            return context.getSession().getCwd();
        }
        if (context.getProject() != null && context.getProject().getBasePath() != null) {
            return context.getProject().getBasePath();
        }
        return "";
    }

    private JsonArray readJsonl(Path file) throws IOException {
        JsonArray messages = new JsonArray();
        try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
            lines.filter(s -> !s.isBlank())
                    .limit(MAX_JSONL_LINES)
                    .forEach(line -> {
                        try {
                            messages.add(JsonParser.parseString(line));
                        } catch (JsonSyntaxException e) {
                            LOG.warn("Skipping malformed JSONL line in subagent history: " + e.getMessage());
                        }
                    });
        }
        return messages;
    }

    private void sendResponse(JsonObject response) {
        String payload = JsUtils.escapeJs(GSON.toJson(response));
        context.callJavaScript("onSubagentHistoryLoaded", payload);
    }
}
