package com.github.claudecodegui.session;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Message merger.
 * Merges streaming assistant messages, ensuring previously displayed tool steps are not overwritten.
 */
public class MessageMerger {

    /**
     * Merge streaming assistant messages.
     */
    public JsonObject mergeAssistantMessage(JsonObject existingRaw, JsonObject newRaw) {
        if (newRaw == null) {
            return existingRaw != null ? existingRaw.deepCopy() : null;
        }

        if (existingRaw == null) {
            return newRaw.deepCopy();
        }

        JsonObject merged = existingRaw.deepCopy();

        // Merge top-level fields (except "message")
        for (Map.Entry<String, JsonElement> entry : newRaw.entrySet()) {
            if ("message".equals(entry.getKey())) {
                continue;
            }
            merged.add(entry.getKey(), entry.getValue());
        }

        JsonObject incomingMessage = newRaw.has("message") && newRaw.get("message").isJsonObject()
            ? newRaw.getAsJsonObject("message")
            : null;

        if (incomingMessage == null) {
            return merged;
        }

        JsonObject mergedMessage = merged.has("message") && merged.get("message").isJsonObject()
            ? merged.getAsJsonObject("message")
            : new JsonObject();

        // Copy new metadata (keep latest stop_reason, usage, etc.)
        for (Map.Entry<String, JsonElement> entry : incomingMessage.entrySet()) {
            if ("content".equals(entry.getKey())) {
                continue;
            }
            mergedMessage.add(entry.getKey(), entry.getValue());
        }

        mergeAssistantContentArray(mergedMessage, incomingMessage);
        merged.add("message", mergedMessage);
        return merged;
    }

    /**
     * Merge the content array of assistant messages.
     */
    private void mergeAssistantContentArray(JsonObject targetMessage, JsonObject incomingMessage) {
        JsonArray baseContent = targetMessage.has("content") && targetMessage.get("content").isJsonArray()
            ? targetMessage.getAsJsonArray("content")
            : new JsonArray();

        Map<String, Integer> indexByKey = buildContentIndex(baseContent);

        JsonArray incomingContent = incomingMessage.has("content") && incomingMessage.get("content").isJsonArray()
            ? incomingMessage.getAsJsonArray("content")
            : null;

        if (incomingContent == null) {
            targetMessage.add("content", baseContent);
            return;
        }

        for (int i = 0; i < incomingContent.size(); i++) {
            JsonElement element = incomingContent.get(i);
            JsonElement elementCopy = element.deepCopy();

            if (element.isJsonObject()) {
                JsonObject block = element.getAsJsonObject();
                String key = getContentBlockKey(block);
                if (key != null && indexByKey.containsKey(key)) {
                    int idx = indexByKey.get(key);
                    baseContent.set(idx, elementCopy);
                    continue;
                } else if (key != null) {
                    baseContent.add(elementCopy);
                    indexByKey.put(key, baseContent.size() - 1);
                    continue;
                }
            }

            baseContent.add(elementCopy);
        }

        targetMessage.add("content", baseContent);
    }

    /**
     * Build an index of content blocks by their unique keys.
     */
    private Map<String, Integer> buildContentIndex(JsonArray contentArray) {
        Map<String, Integer> index = new HashMap<>();
        for (int i = 0; i < contentArray.size(); i++) {
            JsonElement element = contentArray.get(i);
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject block = element.getAsJsonObject();
            String key = getContentBlockKey(block);
            if (key != null && !index.containsKey(key)) {
                index.put(key, i);
            }
        }
        return index;
    }

    /**
     * Get the unique key for a content block.
     */
    private String getContentBlockKey(JsonObject block) {
        if (block.has("id") && !block.get("id").isJsonNull()) {
            return block.get("id").getAsString();
        }

        if (block.has("tool_use_id") && !block.get("tool_use_id").isJsonNull()) {
            return "tool_result:" + block.get("tool_use_id").getAsString();
        }

        return null;
    }
}
