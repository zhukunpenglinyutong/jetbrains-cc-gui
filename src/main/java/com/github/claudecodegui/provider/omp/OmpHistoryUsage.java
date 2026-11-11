package com.github.claudecodegui.provider.omp;

import com.github.claudecodegui.util.TurnUsageAccumulator;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Stamps omp token usage onto converted history envelopes while one session is read.
 *
 * <p>Each omp assistant message is one model step. Its usage goes on its own last assistant
 * envelope as {@code message.usage}; the steps between two user prompts are summed into
 * {@code turnUsage} / {@code turnCostUsd} on the turn's last assistant envelope. A step without
 * visible envelopes only adds to its turn's total.</p>
 */
final class OmpHistoryUsage {

    private static final String PROVIDER = "omp";

    private final TurnUsageAccumulator turnTotal = new TurnUsageAccumulator();
    private JsonObject turnAnchor;
    private String turnModel;

    /** Record one omp assistant message after its content was converted into envelopes. */
    void onAssistantMessage(JsonObject ompMessage, List<JsonObject> converted) {
        JsonObject anchor = lastAssistantEnvelope(converted);
        if (anchor != null) {
            turnAnchor = anchor;
        }
        JsonObject usage = fromOmpUsage(ompMessage.get("usage"));
        if (usage == null) {
            return;
        }
        if (anchor != null) {
            messageObject(anchor).add("usage", usage);
        }
        turnTotal.add(usage);
        JsonElement model = ompMessage.get("model");
        turnModel = model != null && model.isJsonPrimitive() ? model.getAsString() : null;
    }

    /** Close the current turn: call before each user prompt and once after the last message. */
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

    /**
     * Convert omp {@code usage} to the Claude schema (contract section 5, no context window).
     *
     * @return null when {@code usage} is not an object or carries no numeric field
     */
    static JsonObject fromOmpUsage(JsonElement usageEl) {
        if (usageEl == null || !usageEl.isJsonObject()) {
            return null;
        }
        JsonObject usage = usageEl.getAsJsonObject();
        JsonObject out = new JsonObject();
        copyCount(usage, "input", out, "input_tokens");
        copyCount(usage, "output", out, "output_tokens");
        copyCount(usage, "cacheRead", out, "cache_read_input_tokens");
        copyCount(usage, "cacheWrite", out, "cache_creation_input_tokens");
        copyCount(usage, "totalTokens", out, "total_tokens");
        JsonElement cost = usage.get("cost");
        if (cost != null && cost.isJsonObject()) {
            JsonElement total = cost.getAsJsonObject().get("total");
            if (isNumber(total) && total.getAsDouble() >= 0) {
                out.addProperty(TurnUsageAccumulator.COST_KEY, total.getAsDouble());
            }
        }
        return out.size() == 0 ? null : out;
    }

    private static void copyCount(JsonObject from, String key, JsonObject to, String targetKey) {
        JsonElement value = from.get(key);
        if (isNumber(value)) {
            to.addProperty(targetKey, value.getAsLong());
        }
    }

    private static boolean isNumber(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber();
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
