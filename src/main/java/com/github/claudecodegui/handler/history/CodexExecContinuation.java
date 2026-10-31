package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Keeps yielded cells and notifications open until the host reports a terminal response. */
final class CodexExecContinuation {
    private static final Pattern RUNNING = Pattern.compile("^Script running with cell ID ([^\\s]+)(?:\\n|$)");
    private static final Pattern HOST_HEADER = Pattern.compile(
            "^Script (?:completed|failed|terminated|running with cell ID [^\\s]+)\\nWall time:? [^\\n]+\\nOutput:\\n");
    private final String callId;
    private final boolean notifications;
    private final List<JsonObject> records = new ArrayList<>();
    private final List<JsonObject> outputs = new ArrayList<>();
    private final Set<String> outputCallIds = new HashSet<>();
    private final List<JsonObject> deferred = new ArrayList<>();
    private String cellId;
    private String waitCallId;
    private boolean awaiting;
    private boolean continued;
    private boolean preservesWrapper;
    private long retainedBytes;

    CodexExecContinuation(JsonObject original) {
        JsonObject payload = object(original, "payload");
        this.callId = text(payload, "call_id");
        String source = text(payload, payload.has("input") ? "input" : "arguments");
        this.notifications = source != null && CodexExecHistoryReplay.findJavaScriptToken(source, "notify", 0) >= 0;
    }

    boolean accept(JsonObject record, long recordNumber, String nativeTurnId) {
        JsonObject payload = object(record, "payload");
        String type = text(payload, "type");
        String id = text(payload, "call_id");
        if (this.cellId != null && "function_call".equals(type) && List.of("wait", "functions.wait").contains(String.valueOf(text(payload, "name")))) {
            try {
                JsonObject arguments = JsonParser.parseString(text(payload, "arguments")).getAsJsonObject();
                if (this.cellId.equals(text(arguments, "cell_id")) && id != null && this.waitCallId == null) {
                    this.waitCallId = id;
                    this.remember(freezeResponseScope(record, recordNumber, nativeTurnId));
                    return true;
                }
            } catch (RuntimeException ignored) {
                return false;
            }
        }
        if (!List.of("custom_tool_call_output", "function_call_output").contains(String.valueOf(type))
                || !this.callId.equals(id) && !idEquals(this.waitCallId, id)) {
            return false;
        }
        List<String> texts = new ArrayList<>();
        CodexExecHistoryReplay.collectOutputTexts(payload.get("output"), texts);
        String header = texts.isEmpty() ? "" : texts.get(0).replace("\r\n", "\n");
        boolean hostHeader = !this.notifications || HOST_HEADER.matcher(header).find();
        var running = RUNNING.matcher(header);
        if (hostHeader && running.find()) {
            if (this.cellId != null && !this.cellId.equals(running.group(1))) {
                return false;
            }
            this.cellId = running.group(1);
            this.awaiting = true;
            this.continued = true;
        } else if (hostHeader && header.matches("(?s)^Script (?:completed|failed|terminated)(?:\\n.*|$)")) {
            this.awaiting = false;
            if (header.startsWith("Script terminated")) {
                // A host-confirmed termination must not become a successful generic result.
                record = record.deepCopy();
                object(record, "payload").addProperty("status", "error");
            }
        } else {
            // notify has no host header; a wait transport error cannot establish cell completion either.
            this.awaiting = this.notifications || this.cellId != null;
            this.continued |= this.awaiting;
        }
        if (idEquals(this.waitCallId, id)) {
            this.waitCallId = null;
            record = freezeResponseScope(record, recordNumber, nativeTurnId);
        }
        this.outputs.add(record);
        this.outputCallIds.add(id);
        this.remember(record);
        return true;
    }

    boolean awaiting() { return this.awaiting; }
    boolean continued() { return this.continued; }
    boolean preservesWrapper() { return this.preservesWrapper; }

    boolean ownsOutput(JsonObject record) {
        return this.outputCallIds.contains(text(object(record, "payload"), "call_id"));
    }

    static boolean hasTerminatedHeader(String header) {
        String normalized = header.replace("\r\n", "\n");
        return normalized.startsWith("Script terminated\n") && HOST_HEADER.matcher(normalized).find();
    }

    static boolean hasTerminalOutput(JsonObject payload) {
        List<String> texts = new ArrayList<>();
        CodexExecHistoryReplay.collectOutputTexts(payload.get("output"), texts);
        String header = texts.isEmpty() ? "" : texts.get(0).replace("\r\n", "\n");
        return HOST_HEADER.matcher(header).find() && !RUNNING.matcher(header).find();
    }

    static JsonObject keepHostTermination(JsonObject record) {
        JsonObject payload = object(record, "payload");
        if (!List.of("custom_tool_call_output", "function_call_output").contains(String.valueOf(text(payload, "type")))) {
            return record;
        }
        List<String> texts = new ArrayList<>();
        CodexExecHistoryReplay.collectOutputTexts(payload.get("output"), texts);
        if (texts.isEmpty() || !hasTerminatedHeader(texts.get(0))) {
            return record;
        }
        // A released replay buffer must not lose the host outcome when its eventual output arrives.
        JsonObject copy = record.deepCopy();
        object(copy, "payload").addProperty("status", "error");
        return copy;
    }

    List<JsonObject> deferred() { return this.deferred; }
    void remember(JsonObject record) {
        this.records.add(record);
        this.retainedBytes += 3L * record.toString().length();
    }
    void defer(JsonObject record, long recordNumber, String nativeTurnId) {
        this.defer(record, recordNumber, nativeTurnId, false);
    }

    void defer(JsonObject record, long recordNumber, String nativeTurnId, boolean preservesWrapper) {
        JsonObject copy = freezeResponseScope(record, recordNumber, nativeTurnId);
        this.deferred.add(copy);
        this.remember(copy);
        this.preservesWrapper |= preservesWrapper;
    }

    private static JsonObject freezeResponseScope(JsonObject record, long recordNumber, String nativeTurnId) {
        JsonObject copy = record.deepCopy();
        JsonObject payload = object(copy, "payload");
        boolean responseItem = "response_item".equals(text(copy, "type"));
        if (payload != null && responseItem && text(payload, "turn_id") == null && nativeTurnId != null) {
            // A yielded cell can span turns; later replies cannot lend their scope to earlier response items.
            payload.addProperty("turn_id", nativeTurnId);
        }
        if (payload != null && responseItem && text(payload, "id") == null && text(payload, "call_id") == null) {
            String timestamp = text(copy, "timestamp");
            // Freeze the usual fallback identity before later wait replies advance the cursor.
            payload.addProperty("id", (timestamp == null ? "record" : timestamp) + ":" + recordNumber);
        }
        return copy;
    }

    long retainedBytes() {
        return this.retainedBytes;
    }

    JsonObject mergedOutput() {
        if (this.outputs.isEmpty()) {
            return null;
        }
        if (this.outputs.size() == 1) {
            JsonObject output = this.outputs.get(0).deepCopy();
            object(output, "payload").addProperty("call_id", this.callId);
            return output;
        }
        JsonObject merged = this.outputs.get(this.outputs.size() - 1).deepCopy();
        JsonObject payload = object(merged, "payload");
        payload.addProperty("call_id", this.callId);
        JsonArray body = new JsonArray();
        JsonArray inventory = new JsonArray();
        boolean completeInputs = true;
        for (JsonObject record : this.outputs) {
            JsonObject output = object(record, "payload");
            if (CodexMessageConverter.isFailedToolOutput(output)) {
                payload.addProperty("status", "error");
            }
            JsonElement content = output.get("output");
            if (content != null && content.isJsonArray()) {
                content.getAsJsonArray().forEach(value -> body.add(value.deepCopy()));
            } else if (content != null) {
                body.add(content.deepCopy());
            }
            JsonObject metadata = object(output, "internal_chat_message_metadata_passthrough");
            JsonElement calls = metadata == null ? null : metadata.get("executed_tool_calls");
            if (calls == null && text(metadata, "cell_id") == null) {
                // A yield before the first invocation has no inventory fragment to contribute.
                continue;
            }
            if (this.callId.equals(text(metadata, "cell_id")) && calls != null && calls.isJsonArray()) {
                calls.getAsJsonArray().forEach(call -> inventory.add(call.deepCopy()));
            } else {
                completeInputs = false;
            }
        }
        payload.add("output", body);
        JsonObject metadata = object(payload, "internal_chat_message_metadata_passthrough");
        if (metadata != null && this.outputs.size() > 1) {
            if (completeInputs) {
                metadata.add("executed_tool_calls", inventory);
            } else {
                metadata.remove("tool_calls_complete");
            }
        }
        return merged;
    }

    List<JsonObject> fallbackRecords() {
        List<JsonObject> replay = new ArrayList<>();
        Map<String, JsonArray> outputBodies = new LinkedHashMap<>();
        Map<String, JsonObject> outputPayloads = new LinkedHashMap<>();
        Map<String, Integer> nativePositions = new LinkedHashMap<>();
        for (JsonObject record : this.records) {
            JsonObject payload = object(record, "payload");
            String type = text(payload, "type");
            if (!List.of("custom_tool_call_output", "function_call_output").contains(String.valueOf(type))) {
                String identity = nativeItemIdentity(payload);
                Integer position = identity == null ? null : nativePositions.get(identity);
                if (position != null) {
                    // The host can repeat an item_completed; only its latest state belongs in the fallback.
                    replay.set(position, record);
                } else {
                    if (identity != null) {
                        nativePositions.put(identity, replay.size());
                    }
                    replay.add(record);
                }
                continue;
            }
            String id = text(payload, "call_id");
            JsonArray body = outputBodies.get(id);
            if (body == null) {
                JsonObject combined = record.deepCopy();
                body = new JsonArray();
                object(combined, "payload").add("output", body);
                outputBodies.put(id, body);
                outputPayloads.put(id, object(combined, "payload"));
                replay.add(combined);
            }
            if (CodexMessageConverter.isFailedToolOutput(payload)) {
                outputPayloads.get(id).addProperty("status", "error");
            }
            JsonElement output = payload.get("output");
            if (output != null && output.isJsonArray()) {
                for (JsonElement entry : output.getAsJsonArray()) {
                    body.add(entry.deepCopy());
                }
            } else if (output != null) {
                body.add(output.deepCopy());
            }
        }
        return replay;
    }

    private static String nativeItemIdentity(JsonObject payload) {
        JsonObject item = object(payload, "item");
        String id = text(item, "id");
        String type = text(item, "type");
        return "item_completed".equals(text(payload, "type")) && id != null && type != null
                ? text(payload, "thread_id") + ":" + text(payload, "turn_id") + ":" + type + ":" + id : null;
    }

    private static boolean idEquals(String expected, String actual) {
        return expected != null && expected.equals(actual);
    }

    private static JsonObject object(JsonObject parent, String key) {
        JsonElement value = parent == null ? null : parent.get(key);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }

    private static String text(JsonObject object, String key) {
        return HistoryMessageInjector.getStringProperty(object, key);
    }
}
