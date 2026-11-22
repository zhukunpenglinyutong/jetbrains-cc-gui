package com.github.claudecodegui.provider.opencode;

import com.github.claudecodegui.util.TurnUsageAccumulator;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Stamps OpenCode token usage onto converted history envelopes while one session
 * is read.
 *
 * <p>Each OpenCode assistant message is one model step. Its own usage goes on its
 * own last assistant envelope as {@code message.usage} (the latest one restores the
 * context ring). The steps between two user prompts are summed into {@code turnUsage}
 * on that turn's last assistant envelope. Usage never moves into another turn: a step
 * without visible envelopes only adds to its own turn's total.</p>
 */
final class OpenCodeHistoryUsage {

    private static final String PROVIDER = "opencode";

    private final String cwd;
    private final Map<String, Integer> contextWindowByModel = new HashMap<>();
    private final TurnUsageAccumulator turnTotal = new TurnUsageAccumulator();
    private JsonObject turnAnchor;
    private String turnModel;

    /**
     * @param cwd session directory used for project-level OpenCode config, or null
     */
    OpenCodeHistoryUsage(String cwd) {
        this.cwd = cwd;
    }

    /**
     * Record one assistant message after its parts were converted into envelopes.
     */
    void onAssistantMessage(JsonObject msg, List<JsonObject> parts, List<JsonObject> converted) {
        JsonObject anchor = lastAssistantEnvelope(converted);
        if (anchor != null) {
            turnAnchor = anchor;
        }
        JsonObject usage = OpenCodeUsageConverter.fromAssistantMessage(msg, parts);
        if (usage == null) {
            return;
        }
        String model = OpenCodeHistoryReader.normalizeOpenCodeModelFromMessage(msg);
        Integer contextWindow = contextWindow(model);
        if (contextWindow != null) {
            usage.addProperty("model_context_window", contextWindow);
        }
        if (anchor != null) {
            messageObject(anchor).add("usage", usage);
        }
        turnTotal.add(usage);
        turnModel = model;
    }

    /**
     * Close the current turn: call before each user prompt and once after the last message.
     */
    void finishTurn() {
        if (turnAnchor != null && !turnTotal.isEmpty()) {
            turnAnchor.add("turnUsage", turnTotal.snapshot());
            Double turnCostUsd = turnTotal.turnCostUsd(PROVIDER, turnModel);
            if (turnCostUsd != null) {
                turnAnchor.addProperty("turnCostUsd", turnCostUsd);
            }
        }
        turnTotal.reset();
        turnAnchor = null;
        turnModel = null;
    }

    /** One config lookup per model per session read, not per message. */
    private Integer contextWindow(String model) {
        String key = model == null ? "" : model;
        if (!contextWindowByModel.containsKey(key)) {
            contextWindowByModel.put(key, OpenCodeContextWindowResolver.resolve(model, cwd));
        }
        return contextWindowByModel.get(key);
    }

    private static JsonObject lastAssistantEnvelope(List<JsonObject> converted) {
        for (int i = converted.size() - 1; i >= 0; i--) {
            JsonObject envelope = converted.get(i);
            JsonElement type = envelope == null ? null : envelope.get("type");
            if (type != null && type.isJsonPrimitive() && "assistant".equals(type.getAsString())) {
                return envelope;
            }
        }
        return null;
    }

    private static JsonObject messageObject(JsonObject envelope) {
        if (!envelope.has("message") || !envelope.get("message").isJsonObject()) {
            JsonObject message = new JsonObject();
            message.add("content", new JsonArray());
            envelope.add("message", message);
        }
        return envelope.getAsJsonObject("message");
    }
}
