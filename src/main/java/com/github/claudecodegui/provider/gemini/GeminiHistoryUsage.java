package com.github.claudecodegui.provider.gemini;

import com.github.claudecodegui.util.TurnUsageAccumulator;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Stamps Gemini token usage onto converted history envelopes while one conversation
 * is read.
 *
 * <p>Each {@code step_type = 15} ({@code AGENT}) row is one model step. Its own usage
 * goes on its own last assistant envelope as {@code message.usage} (or on the
 * immediately following {@code TOOL} step's assistant envelope when the agent step
 * was a silent tool-dispatch step; the latest one restores the context ring). All
 * agent steps between two user prompts are summed into {@code turnUsage} on that
 * turn's last assistant envelope. Usage never moves into another turn: a step without
 * visible envelopes only adds to its own turn's total.</p>
 */
final class GeminiHistoryUsage {

    private final TurnUsageAccumulator turnTotal = new TurnUsageAccumulator();
    private JsonObject turnAnchor;
    private JsonObject pendingStepUsage;

    /**
     * Record one non-user step after its payload was converted into envelopes.
     */
    void onStep(List<JsonObject> converted, JsonObject stepUsage) {
        JsonObject anchor = lastAssistantEnvelope(converted);
        if (anchor != null) {
            turnAnchor = anchor;
            if (pendingStepUsage != null && stepUsage == null) {
                messageObject(anchor).add("usage", pendingStepUsage);
                pendingStepUsage = null;
            }
        }
        if (stepUsage == null) {
            return;
        }
        if (anchor != null) {
            messageObject(anchor).add("usage", stepUsage);
            pendingStepUsage = null;
        } else {
            pendingStepUsage = stepUsage;
        }
        turnTotal.add(stepUsage);
    }

    /**
     * Close the current turn: call before each user prompt and once after the last step.
     */
    void finishTurn() {
        if (turnAnchor != null && !turnTotal.isEmpty()) {
            if (pendingStepUsage != null) {
                messageObject(turnAnchor).add("usage", pendingStepUsage);
            }
            turnAnchor.add("turnUsage", turnTotal.snapshot());
        }
        turnTotal.reset();
        turnAnchor = null;
        pendingStepUsage = null;
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
