package com.github.claudecodegui.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/** Identifies the separate IDE-context block injected by this plugin, not arbitrary user tags. */
public final class PluginIdeContext {

    /** Marks context prepended so Claude's final text block remains the user's command. */
    public static final String PREFIX = "<system-reminder>\n"
            + "The following IDE context applies to the user message below.\n";
    /** Carries projection provenance through history and transport without rewriting the native transcript. */
    public static final String REMOVED_FIELD = "pluginIdeContextRemoved";
    private static final String LEGACY_PREFIX = "<system-reminder>\n"
            + "The following IDE context applies only to this user message.\n";
    private static final String SUFFIX = "\n</system-reminder>";

    private PluginIdeContext() { }

    /**
     * Returns a read-only view without the plugin's leading context or legacy trailing context.
     * A single user-authored block, generic XML tags, and interior quoted examples remain intact.
     */
    public static JsonElement visibleContent(JsonElement content) {
        int contextIndex = contextIndex(content);
        if (contextIndex < 0) {
            return content;
        }
        JsonArray source = content.getAsJsonArray();
        JsonArray visible = new JsonArray(source.size() - 1);
        for (int i = 0; i < source.size(); i++) {
            if (i != contextIndex) {
                visible.add(source.get(i));
            }
        }
        return visible;
    }

    /** Strips flattened display text only when the raw message proves a separate plugin block existed. */
    public static String visibleText(String text, JsonObject raw) {
        if (contextAlreadyRemoved(raw)) {
            return text;
        }
        JsonElement content = contentOf(raw);
        int contextIndex = contextIndex(content);
        if (text == null || contextIndex < 0) {
            return text;
        }
        String context = content.getAsJsonArray().get(contextIndex).getAsJsonObject().get("text").getAsString();
        if (contextIndex == 0 && text.startsWith(context)) {
            return text.substring(context.length()).stripLeading();
        }
        if (contextIndex > 0 && text.endsWith(context)) {
            return text.substring(0, text.length() - context.length()).stripTrailing();
        }
        return text;
    }

    /** Returns an unchanged message or a copy with only the plugin context removed once. */
    public static JsonObject visibleMessage(JsonObject raw) {
        if (raw == null || contextAlreadyRemoved(raw) || contextIndex(contentOf(raw)) < 0) {
            return raw;
        }
        JsonObject copy = raw.deepCopy();
        // History normalization, parsing and transport all use this view. A
        // later pass must not mistake quoted user text for another context block.
        copy.addProperty(REMOVED_FIELD, true);
        if (copy.has("message") && copy.get("message").isJsonObject()) {
            JsonObject message = copy.getAsJsonObject("message");
            message.add("content", visibleContent(message.get("content")));
        } else {
            copy.add("content", visibleContent(copy.get("content")));
        }
        return copy;
    }

    private static boolean contextAlreadyRemoved(JsonObject raw) {
        return raw != null && new JsonPrimitive(true).equals(raw.get(REMOVED_FIELD));
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

    private static int contextIndex(JsonElement content) {
        if (content == null || !content.isJsonArray() || content.getAsJsonArray().size() < 2) {
            return -1;
        }
        JsonArray blocks = content.getAsJsonArray();
        // Each layout has its own marker so a quoted marker at the other end
        // cannot be mistaken for the context supplied by the plugin.
        if (isContextBlock(blocks.get(0), PREFIX)) {
            return 0;
        }
        int last = blocks.size() - 1;
        return isContextBlock(blocks.get(last), LEGACY_PREFIX) ? last : -1;
    }

    private static boolean isContextBlock(JsonElement element, String prefix) {
        if (!element.isJsonObject()) {
            return false;
        }
        JsonObject block = element.getAsJsonObject();
        JsonElement type = block.get("type");
        JsonElement text = block.get("text");
        if (type == null || !type.isJsonPrimitive() || !"text".equals(type.getAsString())
                || text == null || !text.isJsonPrimitive() || !text.getAsJsonPrimitive().isString()) {
            return false;
        }
        String value = text.getAsString();
        return value.startsWith(prefix) && value.endsWith(SUFFIX);
    }
}
