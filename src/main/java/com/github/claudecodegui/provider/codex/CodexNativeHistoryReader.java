package com.github.claudecodegui.provider.codex;

import com.github.claudecodegui.handler.CodexMessageConverter;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/** Loads native display pages without resuming a thread or claiming a writer. */
public final class CodexNativeHistoryReader {

    /** One native display page with its unchanged continuation cursor. */
    public record Page(List<JsonObject> messages, JsonObject thread, JsonElement cursor,
                       String readMode, boolean partial) { }

    private final CodexSDKBridge bridge;
    private final String channelId;
    private final String cwd;
    private final String threadId;
    private String readMode = "paged";

    /** Binds a read-only operation to the current host and persisted thread. */
    public CodexNativeHistoryReader(CodexSDKBridge bridge, String channelId, String cwd, String threadId) {
        this.bridge = bridge;
        this.channelId = channelId;
        this.cwd = cwd;
        this.threadId = threadId;
    }

    /** Loads a page and retains the storage capability selected on the first read. */
    public Page readPage(JsonElement cursor, int limit) throws Exception {
        JsonObject params = new JsonObject();
        params.add("cursor", cursor == null ? JsonNull.INSTANCE : cursor.deepCopy());
        params.addProperty("limit", limit);
        params.addProperty("readMode", this.readMode);
        JsonObject response = this.bridge.readCodexNative("codex.readHistoryPage", this.channelId,
                this.cwd, this.threadId, params).get(125, TimeUnit.SECONDS);
        if (response == null || response.has("error")) {
            throw new IllegalStateException(response == null ? "Native Codex history returned no response"
                    : response.get("error").getAsString());
        }
        JsonObject thread = response.getAsJsonObject("thread");
        if (thread == null || !this.threadId.equals(string(thread, "id"))) {
            throw new IllegalStateException("Native Codex history returned a different thread");
        }
        this.readMode = string(response, "readMode");
        List<JsonObject> messages = normalizeMessages(response.getAsJsonArray("messages"), this.threadId);
        JsonElement next = response.get("cursor");
        boolean partial = response.has("partial") && response.get("partial").getAsBoolean();
        return new Page(messages, thread.deepCopy(), next == null ? JsonNull.INSTANCE : next.deepCopy(), this.readMode, partial);
    }

    /** Limits offline fallback to unavailable transport; policy and writer errors remain errors. */
    public static boolean permitsOfflineFallback(String message) {
        if (message == null) {
            return false;
        }
        String text = message.toLowerCase(java.util.Locale.ROOT);
        return text.contains("runtime access is inactive") || text.contains("daemon is unavailable")
                || text.contains("cli not found") || text.contains("no codex cli")
                || text.contains("app-server child exited") || text.contains("app-server client closed")
                // Prefix-tolerant: the runtime layer appends per-CLI diagnostics
                // (and a "codex runtime failure: " prefix) to the same exit line,
                // and a transport outage must keep the legacy read-only fallback
                // available no matter which wrapper produced the text.
                || EXIT_LINE.matcher(text).find();
    }

    /** `codex app-server exited (code=1, signal=null)` anywhere in the message. */
    private static final java.util.regex.Pattern EXIT_LINE = java.util.regex.Pattern.compile(
            "codex app-server exited \\(code=(?:-?\\d+|null), signal=(?:sig[a-z0-9]+|null)\\)");

    /** Counts visible blocks so grouped wrapper commands are compared individually. */
    public static long countBlocks(List<JsonObject> messages, String type) {
        long count = 0;
        for (JsonObject message : messages) {
            JsonObject raw = message.getAsJsonObject("raw");
            if (raw == null) {
                continue;
            }
            JsonObject payload = raw.has("message") && raw.get("message").isJsonObject() ? raw.getAsJsonObject("message") : raw;
            JsonArray blocks = payload.has("content") && payload.get("content").isJsonArray() ? payload.getAsJsonArray("content") : null;
            if (blocks == null) {
                continue;
            }
            for (JsonElement block : blocks) {
                if (block.isJsonObject() && type.equals(string(block.getAsJsonObject(), "type"))) {
                    count++;
                }
            }
        }
        return count;
    }

    /** Detects persisted usage omitted by the native history item projection. */
    public static boolean hasUsage(List<JsonObject> messages) {
        return messages.stream().anyMatch(message -> {
            JsonObject raw = message.getAsJsonObject("raw");
            return raw != null && (raw.has("usage") || raw.has("turnUsage") || raw.has("contextUsage"));
        });
    }

    /** Counts display boundaries without requiring a human-readable summary. */
    public static long countCompactions(List<JsonObject> messages) {
        return messages.stream().filter(message -> {
            JsonObject raw = message.getAsJsonObject("raw");
            return raw != null && raw.has("isCompactSummary") && raw.get("isCompactSummary").getAsBoolean();
        }).count();
    }

    /** Counts boundaries with an actual item timestamp rather than a turn approximation. */
    public static long countTimedCompactions(List<JsonObject> messages) {
        return messages.stream().filter(message -> {
            JsonObject raw = message.getAsJsonObject("raw");
            if (raw == null || !raw.has("isCompactSummary") || !raw.get("isCompactSummary").getAsBoolean()) {
                return false;
            }
            JsonObject metadata = raw.has("summarizeMetadata") && raw.get("summarizeMetadata").isJsonObject()
                    ? raw.getAsJsonObject("summarizeMetadata") : null;
            return metadata != null && metadata.has("timestamp") && !metadata.get("timestamp").isJsonNull()
                    && "item".equals(string(metadata, "timestampSource"));
        }).count();
    }

    /** Applies image restoration and privacy before raw messages enter plugin state or export. */
    public static List<JsonObject> normalizeMessages(JsonArray source, String threadId) {
        List<JsonObject> messages = new ArrayList<>();
        CodexHistoryPrivacy privacy = new CodexHistoryPrivacy(threadId);
        if (source == null) {
            return messages;
        }
        for (JsonElement element : source) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject message = privacy.protect(element.getAsJsonObject());
            JsonObject raw = message.getAsJsonObject("raw");
            if (raw == null || !raw.has("message") || !raw.get("message").isJsonObject()) {
                continue;
            }
            JsonObject payload = raw.getAsJsonObject("message");
            JsonArray blocks = CodexMessageConverter.convertToClaudeContentBlocks(payload.get("content"));
            if ("user".equals(string(message, "type")) && !containsBlock(blocks, "tool_result")) {
                String text = CodexMessageConverter.stripSystemTags(CodexMessageConverter.extractContentAsString(blocks));
                JsonArray visible = new JsonArray();
                for (JsonElement block : blocks) {
                    if (block.isJsonObject() && "image".equals(string(block.getAsJsonObject(), "type"))) {
                        visible.add(block);
                    }
                }
                blocks = CodexMessageConverter.userContentBlocks(visible, text);
                message.addProperty("content", text == null ? "" : text);
                if (blocks.isEmpty()) {
                    continue;
                }
            }
            payload.add("content", blocks);
            messages.add(message);
        }
        return messages;
    }

    private static boolean containsBlock(JsonArray blocks, String type) {
        for (JsonElement block : blocks) {
            if (block.isJsonObject() && type.equals(string(block.getAsJsonObject(), "type"))) {
                return true;
            }
        }
        return false;
    }

    private static String string(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }
}
