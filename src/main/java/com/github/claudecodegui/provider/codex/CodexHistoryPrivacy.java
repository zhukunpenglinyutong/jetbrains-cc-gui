package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Masks classified answers before legacy history enters caches or exports. */
public final class CodexHistoryPrivacy {
    private static final String MASK = "[redacted secret answer]";
    private static final String UNCLASSIFIED_MASK = "[redacted answer: classification unavailable]";
    private static final Set<String> OUTPUT_FIELDS = Set.of("output", "result", "aggregatedOutput", "stdout", "stderr", "contentItems");
    private static final Set<String> CONTENT_TYPES = Set.of("text", "image", "inputText", "inputImage", "inputAudio", "url", "base64");
    private static final Set<String> IDENTITY_FIELDS = Set.of("id", "type", "status", "threadId", "thread_id",
            "turnId", "turn_id", "callId", "call_id", "itemId", "item_id", "codexItemId", "codexThreadId",
            "codexTurnId", "tool_use_id", "name", "role", "clientMessageId", "uuid");
    private static volatile String cachedHomeScope;
    private final List<JsonObject> entries = new ArrayList<>();
    private final String sessionId;
    private String currentTurnId;
    private boolean conservativeMasking;

    private record Identity(String threadId, String turnId, String callId, String itemId) { }

    /** Loads plugin-owned identity metadata without reading native credentials or configuration. */
    public CodexHistoryPrivacy(String sessionId) {
        this(new ConfigPathManager().getConfigDir().resolve("codex-privacy"), sessionId, resolveHomeScope());
    }

    CodexHistoryPrivacy(Path directory, String sessionId) {
        this(directory, sessionId, null);
    }

    CodexHistoryPrivacy(Path directory, String sessionId, String scope) {
        this.sessionId = sessionId;
        if (!Files.isDirectory(directory)) {
            // A missing index is different from an existing or inaccessible container.
            this.conservativeMasking = !Files.notExists(directory);
            return;
        }
        try (var files = Files.list(directory)) {
            String legacyName = scope == null ? null : scopeFile(scope);
            String recordPrefix = legacyName == null ? null : legacyName.replace(".json", ".record.");
            files.filter(file -> file.getFileName().toString().endsWith(".json"))
                    .filter(file -> scope == null || file.getFileName().toString().equals(legacyName)
                            || file.getFileName().toString().startsWith(recordPrefix)).forEach(file -> {
                try {
                    JsonObject index = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
                    if (!index.has("version") || !index.get("version").isJsonPrimitive()
                            || !index.getAsJsonPrimitive("version").isNumber() || index.get("version").getAsDouble() != 1
                            || !index.has("entries") || !index.get("entries").isJsonArray()) {
                        this.conservativeMasking = true;
                        return;
                    }
                    JsonElement conservative = index.get("conservativeMasking");
                    if (conservative != null && (!conservative.isJsonPrimitive()
                            || !conservative.getAsJsonPrimitive().isBoolean() || conservative.getAsBoolean())) {
                        this.conservativeMasking = true;
                    }
                    for (JsonElement element : index.getAsJsonArray("entries")) {
                        if (!validEntry(element)) {
                            this.conservativeMasking = true;
                            continue;
                        }
                        JsonObject entry = element.getAsJsonObject();
                        if (sessionId != null && !sessionId.equals(string(entry, "threadId"))) {
                            continue;
                        }
                        this.entries.add(entry.deepCopy());
                    }
                } catch (Exception ignored) {
                    // An unreadable record may be the only classification for an opaque output.
                    this.conservativeMasking = true;
                }
            });
        } catch (Exception ignored) {
            this.conservativeMasking = true;
        }
    }

    private static boolean validEntry(JsonElement element) {
        if (!element.isJsonObject()) {
            return false;
        }
        JsonObject entry = element.getAsJsonObject();
        for (String key : List.of("threadId", "turnId", "callId", "itemId")) {
            JsonElement value = entry.get(key);
            if (value != null && !value.isJsonNull() && (!value.isJsonPrimitive()
                    || !(value.getAsJsonPrimitive().isString() || value.getAsJsonPrimitive().isNumber()
                    && Double.isFinite(value.getAsDouble())))) {
                return false;
            }
        }
        return stringArray(entry.get("secretQuestionIds"), false) && stringArray(entry.get("questionIds"), true);
    }

    private static boolean stringArray(JsonElement value, boolean optional) {
        if (value == null || value.isJsonNull()) {
            return optional;
        }
        if (!value.isJsonArray()) {
            return false;
        }
        for (JsonElement id : value.getAsJsonArray()) {
            if (!id.isJsonPrimitive() || !id.getAsJsonPrimitive().isString()) {
                return false;
            }
        }
        return true;
    }

    /** Returns a masked copy before a transcript enters display, cache, or export. */
    public JsonObject protect(JsonObject raw) {
        JsonObject payload = raw.has("payload") && raw.get("payload").isJsonObject() ? raw.getAsJsonObject("payload") : raw;
        String observedTurn = firstString(payload, "turn_id", "turnId");
        if ("turn_context".equals(string(raw, "type")) || "task_started".equals(string(payload, "type"))) {
            this.currentTurnId = observedTurn;
        }
        return this.protectValue(raw, false, new Identity(this.sessionId, this.currentTurnId, null, null), false).getAsJsonObject();
    }

    private JsonElement protectValue(JsonElement value, boolean mask, Identity inherited, boolean outputBody) {
        if (value == null || value.isJsonNull()) {
            return value;
        }
        if (value.isJsonPrimitive()) {
            if (value.getAsJsonPrimitive().isString()) {
                String text = value.getAsString();
                String trimmed = text.stripLeading();
                if (outputBody && text.matches("(?s).*\"answers\"\\s*:.*") && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
                    // Re-protect JSON-like answer blobs, including truncated ones and nested
                    // arrays, while prose that merely explains answer syntax remains visible.
                    try {
                        return new com.google.gson.JsonPrimitive(
                                this.protectValue(JsonParser.parseString(text), mask, inherited, true).toString());
                    } catch (Exception ignored) {
                        return new com.google.gson.JsonPrimitive(UNCLASSIFIED_MASK);
                    }
                }
                return mask ? new com.google.gson.JsonPrimitive(MASK) : value.deepCopy();
            }
            return mask ? new com.google.gson.JsonPrimitive(MASK) : value.deepCopy();
        }
        if (value.isJsonArray()) {
            JsonArray result = new JsonArray();
            for (JsonElement child : value.getAsJsonArray()) {
                result.add(this.protectValue(child, mask, inherited, outputBody));
            }
            return result;
        }
        JsonObject source = value.getAsJsonObject();
        Identity identity = outputBody ? inherited : inheritIdentity(source, inherited);
        List<JsonObject> matching = this.entries.stream().filter(entry -> matches(entry, identity)).toList();
        List<JsonObject> strong = matching.stream().filter(entry -> string(entry, "callId") != null || string(entry, "itemId") != null).toList();
        if (!strong.isEmpty()) {
            matching = strong;
        }
        Set<String> classifiedQuestions = new HashSet<>();
        Set<String> secretQuestions = new HashSet<>();
        boolean secretOutput = false;
        for (JsonObject entry : matching) {
            this.collectIds(entry, "secretQuestionIds", secretQuestions);
            if (identity.threadId != null && identity.threadId.equals(string(entry, "threadId"))
                    && (string(entry, "turnId") == null || string(entry, "turnId").equals(identity.turnId))
                    && (string(entry, "callId") != null || string(entry, "itemId") != null)) {
                this.collectIds(entry, "questionIds", classifiedQuestions);
            }
            secretOutput |= !secretQuestions.isEmpty();
        }
        JsonObject result = new JsonObject();
        for (Map.Entry<String, JsonElement> entry : source.entrySet()) {
            String key = entry.getKey();
            if ("answers".equals(key) && !entry.getValue().isJsonObject()) {
                result.addProperty(key, UNCLASSIFIED_MASK);
            } else if ("answers".equals(key)) {
                JsonObject answers = new JsonObject();
                for (Map.Entry<String, JsonElement> answer : entry.getValue().getAsJsonObject().entrySet()) {
                    boolean visible = !this.conservativeMasking && classifiedQuestions.contains(answer.getKey())
                            && !secretQuestions.contains(answer.getKey());
                    answers.add(answer.getKey(), visible ? answer.getValue().deepCopy()
                            : new com.google.gson.JsonPrimitive(!this.conservativeMasking
                            && classifiedQuestions.contains(answer.getKey()) ? MASK : UNCLASSIFIED_MASK));
                }
                result.add(key, answers);
            } else {
                // Protect result bodies without rewriting history metadata or unrelated text.
                String type = string(source, "type");
                boolean output = OUTPUT_FIELDS.contains(key) || ("content".equals(key)
                        && List.of("tool_result", "functionCallOutput", "function_call_output").contains(type == null ? "" : type))
                        || "error".equals(key) && List.of("mcpToolCall", "mcp_tool_call", "dynamicToolCall").contains(type == null ? "" : type);
                String question = firstString(source, "id", "questionId", "question_id");
                boolean secretAnswer = secretQuestions.contains(question) && ("answer".equals(key) || "value".equals(key));
                boolean identityField = !mask && IDENTITY_FIELDS.contains(key)
                        || mask && "type".equals(key) && CONTENT_TYPES.contains(type == null ? "" : type);
                result.add(key, identityField ? entry.getValue().deepCopy()
                        : this.protectValue(entry.getValue(), mask || ((secretOutput || this.conservativeMasking) && output)
                        || secretAnswer, identity, outputBody || output));
            }
        }
        return result;
    }

    private static boolean matches(JsonObject entry, Identity identity) {
        if (identity.threadId != null && !identity.threadId.equals(string(entry, "threadId"))) {
            return false;
        }
        if (identity.turnId != null && string(entry, "turnId") != null && !identity.turnId.equals(string(entry, "turnId"))) {
            return false;
        }
        String call = string(entry, "callId");
        String item = string(entry, "itemId");
        if (call != null || item != null) {
            return (identity.callId != null && (identity.callId.equals(call) || identity.callId.equals(item)))
                    || (identity.itemId != null && (identity.itemId.equals(call) || identity.itemId.equals(item)));
        }
        String turn = string(entry, "turnId");
        return identity.threadId != null && identity.threadId.equals(string(entry, "threadId"))
                && (turn != null ? turn.equals(identity.turnId)
                : "mcpServer/elicitation/request".equals(string(entry, "method")));
    }

    private static Identity inheritIdentity(JsonObject object, Identity parent) {
        boolean turn = object.has("items") && object.get("items").isJsonArray();
        String item = firstString(object, "itemId", "item_id", "codexItemId");
        if (item == null && object.has("type")) {
            item = string(object, "id");
        }
        String turnId = firstString(object, "turnId", "turn_id", "codexTurnId");
        return new Identity(orElse(firstString(object, "threadId", "thread_id", "codexThreadId"), parent.threadId),
                orElse(turnId, turn ? string(object, "id") : parent.turnId),
                orElse(firstString(object, "callId", "call_id", "tool_use_id"), turn ? null : parent.callId),
                normalizeResultId(orElse(item, turn ? null : parent.itemId)));
    }

    private static String normalizeResultId(String id) {
        return id != null && id.endsWith(":result") ? id.substring(0, id.length() - 7) : id;
    }

    private static String firstString(JsonObject object, String... names) {
        for (String name : names) {
            String value = string(object, name);
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private static String orElse(String value, String fallback) {
        return value == null ? fallback : value;
    }

    private static String scopeFile(String scope) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(scope.getBytes(StandardCharsets.UTF_8))) + ".json";
        } catch (Exception ignored) {
            return "unavailable-scope";
        }
    }

    /**
     * Resolves the effective CODEX_HOME by reading the daemon environment that
     * {@link EnvironmentConfigurator} would assemble (no process is started).
     * Memoized because history pagination constructs one privacy index per page.
     */
    private static String resolveHomeScope() {
        String cached = cachedHomeScope;
        if (cached != null) {
            return cached;
        }
        synchronized (CodexHistoryPrivacy.class) {
            if (cachedHomeScope == null) {
                ProcessBuilder environment = new ProcessBuilder("node");
                new EnvironmentConfigurator().updateProcessEnvironment(environment, NodeDetector.getInstance().getCachedNodePath());
                cachedHomeScope = environment.environment().getOrDefault("CODEX_HOME", "default");
            }
            return cachedHomeScope;
        }
    }

    private void collectIds(JsonObject entry, String name, Set<String> target) {
        if (!entry.has(name) || !entry.get(name).isJsonArray()) {
            return;
        }
        for (JsonElement id : entry.getAsJsonArray(name)) {
            if (id.isJsonPrimitive() && id.getAsJsonPrimitive().isString()) {
                target.add(id.getAsString());
            }
        }
    }

    private static String string(JsonObject object, String name) {
        JsonElement value = object.get(name);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }
}
