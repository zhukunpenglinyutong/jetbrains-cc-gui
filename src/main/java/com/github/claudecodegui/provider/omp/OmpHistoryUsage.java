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
        JsonElement provider = ompMessage.get("provider");
        JsonElement model = ompMessage.get("model");
        String modelId = model != null && model.isJsonPrimitive() ? model.getAsString() : null;
        if (modelId != null) {
            // The session records provider and model separately; the model list keys by "provider/id".
            // A model that already is a selector is looked up as written.
            Integer contextWindow = provider != null && provider.isJsonPrimitive()
                    ? OmpContextWindows.resolve(provider.getAsString() + "/" + modelId)
                    : null;
            if (contextWindow == null) {
                contextWindow = OmpContextWindows.resolve(modelId);
            }
            if (contextWindow != null) {
                usage.addProperty("model_context_window", contextWindow);
            }
        }
        if (anchor != null) {
            messageObject(anchor).add("usage", usage);
        }
        turnTotal.add(usage);
        turnModel = modelId;
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
     * Convert omp {@code usage} to the Claude schema (contract section 5, without the context window).
     * Same rule as the live stream: omp writes all-zero usage for aborted or errored steps, and those
     * are dropped rather than replacing the previous step's figures.
     *
     * @return null when {@code usage} is not an object or all its token counts are zero
     */
    static JsonObject fromOmpUsage(JsonElement usageEl) {
        if (usageEl == null || !usageEl.isJsonObject()) {
            return null;
        }
        JsonObject usage = usageEl.getAsJsonObject();
        long input = count(usage, "input");
        long output = count(usage, "output");
        long cacheRead = count(usage, "cacheRead");
        long cacheWrite = count(usage, "cacheWrite");
        long total = count(usage, "totalTokens");
        if (total == 0) {
            total = input + output + cacheRead + cacheWrite;
        }
        if (total <= 0) {
            return null;
        }
        JsonObject out = new JsonObject();
        out.addProperty("input_tokens", input);
        out.addProperty("output_tokens", output);
        out.addProperty("cache_read_input_tokens", cacheRead);
        out.addProperty("cache_creation_input_tokens", cacheWrite);
        out.addProperty("total_tokens", total);
        JsonElement cost = usage.get("cost");
        if (cost != null && cost.isJsonObject()) {
            JsonElement costTotal = cost.getAsJsonObject().get("total");
            if (isNumber(costTotal) && costTotal.getAsDouble() >= 0) {
                out.addProperty(TurnUsageAccumulator.COST_KEY, costTotal.getAsDouble());
            }
        }
        return out;
    }

    /** A token count: missing, non-numeric and negative values are 0, fractions are floored. */
    private static long count(JsonObject from, String key) {
        JsonElement value = from.get(key);
        return isNumber(value) ? Math.max(0L, (long) Math.floor(value.getAsDouble())) : 0L;
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
