package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Content-block traversal and identities shared by snapshot and history consumers.
 * The webview mirrors block identities in messageSync.ts.
 */
final class MessageStructure {

    /** Block types whose identities survive snapshot reconciliation. */
    static final List<String> STRUCTURAL_BLOCK_TYPES =
            List.of("tool_use", "tool_result", "attachment", "image");

    private MessageStructure() {
    }

    /**
     * Return the content block array of a raw message, whichever shape it uses.
     *
     * <p>The nested {@code message.content} shape is checked first, mirroring
     * messageSync.ts's {@code getRawBlocks}: a raw carrying both shapes must
     * resolve to the same blocks on both sides, or the history guards here and
     * the frontend merge there would disagree about what the message holds.</p>
     *
     * @param raw raw message object, possibly {@code null}
     * @return the content array, or {@code null} when the message carries none
     */
    static JsonArray findContentArray(JsonObject raw) {
        if (raw == null) {
            return null;
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject message = raw.getAsJsonObject("message");
            if (message.has("content") && message.get("content").isJsonArray()) {
                return message.getAsJsonArray("content");
            }
        }
        if (raw.has("content") && raw.get("content").isJsonArray()) {
            return raw.getAsJsonArray("content");
        }
        return null;
    }

    /**
     * Return the identity of a structural block, or {@code null} when the block
     * carries no structure (text/thinking) or cannot be identified.
     *
     * @param block one content block
     * @return the identity key, or {@code null}
     */
    static String structuralBlockKey(JsonObject block) {
        // The type guard mirrors messageSync.ts's string comparisons: a
        // non-string type (missing, null, number, object) yields no key, and
        // must never throw — structuralBlockKeys walks untrusted history rows.
        if (block == null || !block.has("type")
                || !block.get("type").isJsonPrimitive()
                || !block.getAsJsonPrimitive("type").isString()) {
            return null;
        }
        String type = block.get("type").getAsString();
        if ("tool_use".equals(type)) {
            return primitiveKey(block, "id", "tool_use");
        }
        if ("tool_result".equals(type)) {
            return primitiveKey(block, "tool_use_id", "tool_result");
        }
        if ("attachment".equals(type)) {
            return primitiveKey(block, "fileName", "attachment");
        }
        if ("image".equals(type)) {
            return primitiveKey(block, "src", "image");
        }
        return null;
    }

    /**
     * Collect structural identities without comparing provider-specific payload sizes.
     */
    static Set<String> structuralBlockKeys(List<ClaudeSession.Message> messages) {
        Set<String> keys = new HashSet<>();
        for (ClaudeSession.Message message : messages) {
            JsonArray blocks = findContentArray(message.raw);
            if (blocks == null) {
                continue;
            }
            for (JsonElement element : blocks) {
                if (element.isJsonObject()) {
                    String key = structuralBlockKey(element.getAsJsonObject());
                    if (key != null) {
                        keys.add(key);
                    }
                }
            }
        }
        return keys;
    }

    private static String primitiveKey(JsonObject block, String field, String prefix) {
        String value = primitiveString(block, field);
        return value == null || value.isEmpty() ? null : prefix + ':' + value;
    }

    private static String primitiveString(JsonObject block, String field) {
        // String primitives only, matching the TS mirror's `typeof === 'string'`:
        // getAsString() would silently stringify numbers and booleans.
        if (!block.has(field) || !block.get(field).isJsonPrimitive()
                || !block.getAsJsonPrimitive(field).isString()) {
            return null;
        }
        return block.get(field).getAsString();
    }
}
