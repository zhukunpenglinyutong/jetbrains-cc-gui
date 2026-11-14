package com.github.claudecodegui.provider.omp;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Context windows of the models omp reports, keyed by omp selector ({@code provider/id}).
 *
 * <p>omp session files record only {@code provider} and {@code model}, never the window, so the
 * registry is filled from the model list the plugin fetches ({@code omp models --json}). It stays
 * empty until that list was fetched once in this IDE run.</p>
 */
public final class OmpContextWindows {

    private static volatile Map<String, Integer> windows = Map.of();

    private OmpContextWindows() {
    }

    /**
     * Replace the registry from a {@code listModels} payload. A payload that failed or carries no
     * model with a positive {@code contextWindow} keeps the previous registry.
     */
    public static void update(JsonObject listModelsPayload) {
        if (listModelsPayload == null) {
            return;
        }
        JsonElement success = listModelsPayload.get("success");
        if (success != null && success.isJsonPrimitive() && success.getAsJsonPrimitive().isBoolean()
                && !success.getAsBoolean()) {
            return;
        }
        JsonElement list = listModelsPayload.get("models");
        if (list == null || !list.isJsonArray()) {
            return;
        }
        Map<String, Integer> next = new HashMap<>();
        JsonArray models = list.getAsJsonArray();
        for (JsonElement el : models) {
            if (!el.isJsonObject()) {
                continue;
            }
            JsonObject model = el.getAsJsonObject();
            JsonElement id = model.get("id");
            JsonElement window = model.get("contextWindow");
            if (id == null || !id.isJsonPrimitive() || window == null || !window.isJsonPrimitive()
                    || !window.getAsJsonPrimitive().isNumber()) {
                continue;
            }
            double tokens = window.getAsDouble();
            if (id.getAsString().isBlank() || !(tokens >= 1) || tokens > Integer.MAX_VALUE) {
                continue;
            }
            next.put(id.getAsString(), (int) tokens);
        }
        if (!next.isEmpty()) {
            windows = Map.copyOf(next);
        }
    }

    /**
     * @param selector omp model selector such as {@code anthropic/claude-opus-5-5}
     * @return the model's context window in tokens, or null when unknown
     */
    public static Integer resolve(String selector) {
        return selector == null ? null : windows.get(selector);
    }

    /** Empty the registry between tests. */
    static void reset() {
        windows = Map.of();
    }
}
