package com.github.claudecodegui.session;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Keeps native page boundaries and local submissions anchored to their identities. */
public final class CodexHistoryMerger {
    private CodexHistoryMerger() { }

    /** Merges an older page with the current transcript without comparing prompt text. */
    public static List<ClaudeSession.Message> merge(List<ClaudeSession.Message> older, List<ClaudeSession.Message> current) {
        List<ClaudeSession.Message> result = new ArrayList<>();
        Map<String, Integer> positions = new HashMap<>();
        for (List<ClaudeSession.Message> page : List.of(older, current)) {
            for (ClaudeSession.Message message : page) {
                String key = identity(message.raw);
                Integer position = key == null ? null : positions.get(key);
                if (position == null) {
                    if (key != null) {
                        positions.put(key, result.size());
                    }
                    result.add(message);
                } else {
                    JsonObject previous = result.get(position).raw;
                    // A local draft or preview must not overwrite native confirmation.
                    if (!(previous != null && string(previous, "codexItemId") != null
                            && (message.raw == null || string(message.raw, "codexItemId") == null))) {
                        result.set(position, message);
                    }
                }
            }
        }
        return result;
    }

    /** Reconciles a complete single-source load, retaining only unconfirmed work from another source. */
    public static List<ClaudeSession.Message> reconcile(List<ClaudeSession.Message> loaded, List<ClaudeSession.Message> current) {
        String source = loaded.stream().map(message -> source(message.raw)).filter(java.util.Objects::nonNull)
                .findFirst().orElse(null);
        List<ClaudeSession.Message> retained = current.stream().filter(message -> source == null
                || source.equals(source(message.raw)) || (message.raw != null
                && string(message.raw, "clientMessageId") != null && string(message.raw, "codexItemId") == null)).toList();
        return merge(loaded, retained);
    }

    private static String source(JsonObject raw) {
        if (raw == null) {
            return null;
        }
        String explicit = string(raw, "historySource");
        return explicit != null ? explicit : string(raw, "codexItemId") != null ? "native" : "legacy";
    }

    /** Returns a stable submission/item key, or null for unclassified legacy rows. */
    public static String identity(JsonObject raw) {
        if (raw == null) {
            return null;
        }
        String clientId = string(raw, "clientMessageId");
        if (clientId != null && !clientId.isBlank()) {
            return "client:" + clientId;
        }
        String itemId = string(raw, "codexItemId");
        if (itemId != null) {
            return "item:" + string(raw, "codexThreadId") + ":" + string(raw, "codexTurnId") + ":" + itemId;
        }
        String uuid = string(raw, "uuid");
        return uuid == null ? null : "uuid:" + uuid;
    }

    private static String string(JsonObject object, String key) {
        JsonElement value = object.get(key);
        return value != null && value.isJsonPrimitive() ? value.getAsString() : null;
    }
}
