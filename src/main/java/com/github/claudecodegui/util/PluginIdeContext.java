package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/** Identifies the separate IDE-context block appended by this plugin, not arbitrary user tags. */
public final class PluginIdeContext {

    public static final String PREFIX = "<system-reminder>\n"
            + "The following IDE context applies only to this user message.\n";
    private static final String SUFFIX = "\n</system-reminder>";

    private PluginIdeContext() { }

    /**
     * Returns a read-only view without the plugin's final text block. A single
     * user-authored block, generic XML tags, and interior quoted examples remain intact.
     */
    public static JsonElement visibleContent(JsonElement content) {
        String context = appendedContext(content);
        if (context == null) {
            return content;
        }
        JsonArray source = content.getAsJsonArray();
        JsonArray visible = new JsonArray(source.size() - 1);
        for (int i = 0; i < source.size() - 1; i++) {
            visible.add(source.get(i));
        }
        return visible;
    }

    /** Strips flattened display text only when the raw message proves a separate plugin block existed. */
    public static String visibleText(String text, JsonObject raw) {
        String context = appendedContext(contentOf(raw));
        if (text == null || context == null || !text.endsWith(context)) {
            return text;
        }
        return text.substring(0, text.length() - context.length()).stripTrailing();
    }

    /** Returns an unchanged message or a copy with only the appended context removed. */
    public static JsonObject visibleMessage(JsonObject raw) {
        if (raw == null || appendedContext(contentOf(raw)) == null) {
            return raw;
        }
        JsonObject copy = raw.deepCopy();
        if (copy.has("message") && copy.get("message").isJsonObject()) {
            JsonObject message = copy.getAsJsonObject("message");
            message.add("content", visibleContent(message.get("content")));
        } else {
            copy.add("content", visibleContent(copy.get("content")));
        }
        return copy;
    }

    private static JsonElement contentOf(JsonObject raw) {
        if (raw == null) {
            return null;
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            return raw.getAsJsonObject("message").get("content");
        }
        return raw.get("content");
    }

    private static String appendedContext(JsonElement content) {
        if (content == null || !content.isJsonArray() || content.getAsJsonArray().size() < 2) {
            return null;
        }
        JsonArray blocks = content.getAsJsonArray();
        JsonElement last = blocks.get(blocks.size() - 1);
        if (!last.isJsonObject()) {
            return null;
        }
        JsonObject block = last.getAsJsonObject();
        JsonElement type = block.get("type");
        JsonElement text = block.get("text");
        if (type == null || !type.isJsonPrimitive() || !"text".equals(type.getAsString())
                || text == null || !text.isJsonPrimitive() || !text.getAsJsonPrimitive().isString()) {
            return null;
        }
        String value = text.getAsString();
        return value.startsWith(PREFIX) && value.endsWith(SUFFIX) ? value : null;
    }
}
