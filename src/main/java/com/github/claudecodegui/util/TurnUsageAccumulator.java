package com.github.claudecodegui.util;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

/**
 * Sums per-step usage reports into the whole-turn {@code turnUsage} the message
 * footer renders.
 *
 * <p>Providers such as OpenCode report usage once per model step, and each report
 * covers that step only, so the turn figure is their sum. A {@code cost_usd} in a
 * report is the provider's own price for the step; when any step carries one, the
 * reported total replaces the static pricing tables, so a subscription or local
 * model is not shown at list price.</p>
 */
public final class TurnUsageAccumulator {

    /** Provider-reported step cost in USD carried inside a usage object. */
    public static final String COST_KEY = "cost_usd";

    private static final String[] TOKEN_KEYS = {
        "input_tokens",
        "output_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "thinking_tokens",
        "total_tokens",
    };

    private JsonObject totals = new JsonObject();
    private double reportedCostUsd;
    private boolean costReported;

    /**
     * Add one step's usage to the turn.
     *
     * @param stepUsage usage in the Claude schema; non-numeric fields are ignored
     */
    public void add(JsonObject stepUsage) {
        if (stepUsage == null) {
            return;
        }
        for (String key : TOKEN_KEYS) {
            if (isNumber(stepUsage.get(key))) {
                totals.addProperty(key, readCount(totals, key) + readCount(stepUsage, key));
            }
        }
        if (isNumber(stepUsage.get(COST_KEY))) {
            costReported = true;
            reportedCostUsd += Math.max(0.0, stepUsage.get(COST_KEY).getAsDouble());
        }
    }

    public boolean isEmpty() {
        return totals.size() == 0;
    }

    /**
     * @return a copy of the summed usage, safe to store on a message
     */
    public JsonObject snapshot() {
        return totals.deepCopy();
    }

    /**
     * Whole-turn cost: the provider-reported sum when any step reported a cost,
     * otherwise an estimate from the pricing tables.
     *
     * @return cost in USD, or null when it is zero or unknown
     */
    public Double turnCostUsd(String provider, String model) {
        if (isEmpty()) {
            return null;
        }
        Double cost = costReported
                ? Double.valueOf(reportedCostUsd)
                : UsageCostCalculator.calculateTurnCostUsd(provider, totals, model);
        return cost != null && cost > 0 ? cost : null;
    }

    public void reset() {
        totals = new JsonObject();
        reportedCostUsd = 0.0;
        costReported = false;
    }

    private static boolean isNumber(JsonElement value) {
        return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isNumber();
    }

    private static long readCount(JsonObject usage, String key) {
        return isNumber(usage.get(key)) ? Math.max(0L, usage.get(key).getAsLong()) : 0L;
    }
}
