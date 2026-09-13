package com.github.claudecodegui.provider.grok;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Builds a {@code ContextUsageData}-compatible payload for the Grok provider.
 * Grok ACP only exposes aggregate token usage (not Claude's category breakdown),
 * so we synthesize: used conversation tokens + free space within the model limit.
 */
public final class GrokContextUsageBuilder {

    private GrokContextUsageBuilder() {
    }

    /**
     * @param usedTokens tokens used in the current/last turn (0 if unknown)
     * @param maxTokens  model context window limit
     * @param model      model id for display
     */
    public static JsonObject build(int usedTokens, int maxTokens, String model) {
        int used = Math.max(0, usedTokens);
        int max = Math.max(1, maxTokens);
        if (used > max) {
            used = max;
        }
        int free = Math.max(0, max - used);
        double percentage = (100.0 * used) / max;

        JsonObject root = new JsonObject();
        root.addProperty("success", true);
        root.addProperty("totalTokens", used);
        root.addProperty("maxTokens", max);
        root.addProperty("rawMaxTokens", max);
        root.addProperty("percentage", Math.round(percentage * 10.0) / 10.0);
        root.addProperty("model", model != null ? model : "");
        root.addProperty("isAutoCompactEnabled", false);
        root.addProperty("source", "grok-synthesized");

        JsonArray categories = new JsonArray();
        JsonObject usedCat = new JsonObject();
        usedCat.addProperty("name", "Conversation");
        usedCat.addProperty("tokens", used);
        usedCat.addProperty("color", "claude");
        categories.add(usedCat);

        JsonObject freeCat = new JsonObject();
        freeCat.addProperty("name", "Free space");
        freeCat.addProperty("tokens", free);
        freeCat.addProperty("color", "inactive");
        categories.add(freeCat);
        root.add("categories", categories);

        // Minimal 1-row grid for the dialog heatmap.
        JsonArray gridRows = new JsonArray();
        JsonArray row = new JsonArray();
        row.add(gridCell("claude", used > 0, "Conversation", used, percentage, used > 0 ? 1.0 : 0.0));
        double freePct = 100.0 - percentage;
        row.add(gridCell("inactive", false, "Free space", free, freePct, free > 0 ? Math.min(1.0, free / (double) max) : 0.0));
        gridRows.add(row);
        root.add("gridRows", gridRows);

        root.add("memoryFiles", new JsonArray());
        root.add("mcpTools", new JsonArray());
        root.add("agents", new JsonArray());

        return root;
    }

    private static JsonObject gridCell(
            String color,
            boolean isFilled,
            String categoryName,
            int tokens,
            double percentage,
            double squareFullness
    ) {
        JsonObject cell = new JsonObject();
        cell.addProperty("color", color);
        cell.addProperty("isFilled", isFilled);
        cell.addProperty("categoryName", categoryName);
        cell.addProperty("tokens", tokens);
        cell.addProperty("percentage", Math.round(percentage * 10.0) / 10.0);
        cell.addProperty("squareFullness", squareFullness);
        return cell;
    }

    /**
     * Normalize usage to OpenAI snake_case ({@code total_tokens}, {@code input_tokens}, …).
     * Primary path for [USAGE] after the bridge; camelCase ACP is mapped here as fallback.
     *
     * @return new object with snake_case keys, or null if no token fields found
     */
    public static JsonObject normalizeUsageToSnakeCase(JsonObject usage) {
        if (usage == null) {
            return null;
        }
        // Nested { usage: {...} }
        if (usage.has("usage") && usage.get("usage").isJsonObject()
                && firstPositiveInt(usage, "total_tokens", "totalTokens", "input_tokens", "inputTokens") <= 0) {
            JsonObject nested = normalizeUsageToSnakeCase(usage.getAsJsonObject("usage"));
            if (nested != null) {
                return nested;
            }
        }

        int total = firstPositiveInt(usage, "total_tokens", "totalTokens");
        int input = firstPositiveInt(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
        int output = firstPositiveInt(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
        int thought = firstPositiveInt(
                usage,
                "thought_tokens",
                "thoughtTokens",
                "reasoning_tokens",
                "reasoningTokens"
        );
        int cachedWrite = firstPositiveInt(usage, "cached_write_tokens", "cachedWriteTokens");
        int cachedRead = firstPositiveInt(
                usage,
                "cached_read_tokens",
                "cachedReadTokens",
                "cached_tokens",
                "cachedTokens"
        );

        if (total <= 0 && input <= 0 && output <= 0 && thought <= 0 && cachedWrite <= 0 && cachedRead <= 0) {
            return null;
        }

        JsonObject out = new JsonObject();
        if (input > 0) {
            out.addProperty("input_tokens", input);
        }
        if (output > 0) {
            out.addProperty("output_tokens", output);
        }
        if (thought > 0) {
            out.addProperty("thought_tokens", thought);
        }
        if (cachedWrite > 0) {
            out.addProperty("cached_write_tokens", cachedWrite);
        }
        if (cachedRead > 0) {
            out.addProperty("cached_read_tokens", cachedRead);
        }
        int resolvedTotal = total > 0
                ? total
                : input + output + thought + cachedWrite + cachedRead;
        out.addProperty("total_tokens", resolvedTotal);
        return out;
    }

    /**
     * Extract used-token total from a Grok/ACP usage JSON object.
     * Prefers snake_case after {@link #normalizeUsageToSnakeCase}; dual-reads camelCase as fallback.
     */
    public static int extractUsedTokens(JsonObject usage) {
        if (usage == null) {
            return 0;
        }
        JsonObject normalized = normalizeUsageToSnakeCase(usage);
        if (normalized != null) {
            int total = firstPositiveInt(normalized, "total_tokens");
            if (total > 0) {
                return total;
            }
            int used = 0;
            used += firstPositiveInt(normalized, "input_tokens");
            used += firstPositiveInt(normalized, "output_tokens");
            used += firstPositiveInt(normalized, "thought_tokens");
            used += firstPositiveInt(normalized, "cached_write_tokens");
            used += firstPositiveInt(normalized, "cached_read_tokens");
            if (used > 0) {
                return used;
            }
        }
        // Last-resort dual-read without normalize
        int total = firstPositiveInt(usage, "total_tokens", "totalTokens");
        if (total > 0) {
            return total;
        }
        int used = 0;
        used += firstPositiveInt(usage, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
        used += firstPositiveInt(usage, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
        used += firstPositiveInt(usage, "thought_tokens", "thoughtTokens");
        used += firstPositiveInt(usage, "cached_write_tokens", "cachedWriteTokens");
        used += firstPositiveInt(usage, "cached_read_tokens", "cachedReadTokens");
        return Math.max(0, used);
    }

    /** First finite non-null number &gt; 0 among keys (or 0). Snake_case keys should be listed first. */
    static int firstPositiveInt(JsonObject obj, String... keys) {
        if (obj == null || keys == null) {
            return 0;
        }
        for (String key : keys) {
            if (key == null || !obj.has(key) || obj.get(key).isJsonNull()) {
                continue;
            }
            try {
                int n = obj.get(key).getAsInt();
                if (n > 0) {
                    return n;
                }
            } catch (Exception ignored) {
                // non-numeric
            }
        }
        return 0;
    }
}
